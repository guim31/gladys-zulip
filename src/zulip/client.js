// -----------------------------------------------------------------------------
// A small client of the Zulip REST API (/api/v1), the handful of endpoints a
// generic bot needs: who am I, the users, channels, the event queue
// (register, then long polling), messages and file upload. Built on fetch,
// injected by the tests.
//
// Every failure is a ZulipError with a `kind` (below), so the callers and the
// texts never parse a server message. The API key never appears in an error
// message nor in a log line.
// -----------------------------------------------------------------------------

export const ERROR_KINDS = {
  NOT_CONFIGURED: 'not_configured',
  INVALID_URL: 'invalid_url',
  NO_CREDENTIALS: 'no_credentials',
  UNREACHABLE: 'unreachable',
  TIMEOUT: 'timeout',
  NOT_ZULIP: 'not_zulip',
  CREDENTIALS: 'credentials',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  REJECTED: 'rejected',
  RATE_LIMITED: 'rate_limited',
  SERVER: 'server',
  // The event queue was garbage-collected by the server: register a new one.
  QUEUE_EXPIRED: 'queue_expired',
};

// Failures that say nothing about the configuration: the network or the server
// will come back, the connection loop retries.
export const TRANSIENT_KINDS = new Set([
  ERROR_KINDS.UNREACHABLE,
  ERROR_KINDS.TIMEOUT,
  ERROR_KINDS.RATE_LIMITED,
  ERROR_KINDS.SERVER,
  ERROR_KINDS.QUEUE_EXPIRED,
]);

export class ZulipError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message English, without secret
   * @param {object} [details]
   * @param {number} [details.status] HTTP status
   * @param {string} [details.code] Zulip error code (BAD_EVENT_QUEUE_ID, UNAUTHORIZED...)
   * @param {number} [details.retryAfterMs] wait asked by a 429
   */
  constructor(kind, message, { status, code, retryAfterMs, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ZulipError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

const API_PATH = '/api/v1';
export const REQUEST_TIMEOUT_MS = 15_000;
// The server answers a long poll with a heartbeat event after about 50 s at most.
export const EVENTS_TIMEOUT_MS = 90_000;
// The longest wait a 429 is honored with inside one call; beyond, the caller decides.
const MAX_INLINE_RETRY_MS = 10_000;
// The default limits of a Zulip server (max_message_length, max_topic_length).
export const MAX_MESSAGE_LENGTH = 10_000;
export const MAX_TOPIC_LENGTH = 60;

function kindOf(status, code) {
  if (code === 'BAD_EVENT_QUEUE_ID') {
    return ERROR_KINDS.QUEUE_EXPIRED;
  }
  if (['STREAM_DOES_NOT_EXIST', 'BAD_NARROW'].includes(code)) {
    return ERROR_KINDS.NOT_FOUND;
  }
  switch (status) {
    case 401:
      // A wrong key, a deactivated bot or organization (USER_DEACTIVATED, REALM_DEACTIVATED).
      return ERROR_KINDS.CREDENTIALS;
    case 403:
      return ERROR_KINDS.FORBIDDEN;
    case 404:
      return ERROR_KINDS.NOT_FOUND;
    case 429:
      return ERROR_KINDS.RATE_LIMITED;
    default:
      // Any other 4xx (a channel the bot cannot access, a message too long): refused as is.
      return status >= 500 ? ERROR_KINDS.SERVER : ERROR_KINDS.REJECTED;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** The wait a 429 asks for: the Retry-After header, else `retry-after` of the body (seconds). */
function retryAfter(headers, data) {
  for (const value of [headers?.get?.('retry-after'), data?.['retry-after']]) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }
  }
  return undefined;
}

/** A form body: Zulip takes application/x-www-form-urlencoded, arrays and objects as JSON. */
function formBody(fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) {
      body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  }
  return body;
}

export class ZulipClient {
  /**
   * @param {object} options
   * @param {URL} options.server address of the organization
   * @param {string} options.email e-mail of the bot
   * @param {string} options.apiKey API key of the bot
   * @param {typeof fetch} [options.fetch]
   */
  constructor({ server, email, apiKey, fetch: fetchImpl = globalThis.fetch }) {
    this.base = server;
    this.authorization = `Basic ${Buffer.from(`${email}:${apiKey}`).toString('base64')}`;
    this.fetch = fetchImpl;
  }

  url(path, query) {
    const url = new URL(this.base.href.replace(/\/$/, '') + API_PATH + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(
          key,
          typeof value === 'object' ? JSON.stringify(value) : String(value),
        );
      }
    }
    return url;
  }

  /**
   * One request. Resolves with the JSON body of a successful answer.
   * @param {string} method
   * @param {string} path below /api/v1
   * @param {object} [options]
   * @param {object} [options.fields] form fields (POST, PATCH, DELETE)
   * @param {object} [options.query] query string
   * @param {FormData} [options.form] multipart body (upload)
   */
  async request(
    method,
    path,
    { fields, query, form, timeoutMs = REQUEST_TIMEOUT_MS, signal } = {},
  ) {
    const headers = { authorization: this.authorization };
    const body = form ?? (fields ? formBody(fields) : undefined);
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await this.fetch(this.url(path, query), {
          method,
          headers,
          body,
          // A fresh timeout per attempt: the wait of a 429 does not eat the next one.
          signal: signal
            ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
            : AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (signal?.aborted) {
          throw err; // stopped by the caller: not a failure of the server
        }
        if (err?.name === 'TimeoutError') {
          throw new ZulipError(ERROR_KINDS.TIMEOUT, `No answer within ${timeoutMs} ms`);
        }
        throw new ZulipError(
          ERROR_KINDS.UNREACHABLE,
          `Server unreachable: ${err?.cause?.code ?? err?.message}`,
        );
      }
      let data;
      const text = await response.text().catch(() => '');
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      const isZulip = data !== null && typeof data === 'object' && typeof data.result === 'string';
      if (response.ok && isZulip && data.result === 'success') {
        return data;
      }
      if (!isZulip && (response.ok || [404, 405].includes(response.status))) {
        // A web server that is not Zulip: the address is wrong.
        throw new ZulipError(
          ERROR_KINDS.NOT_ZULIP,
          `No Zulip API at this address (HTTP ${response.status})`,
          { status: response.status },
        );
      }
      const code = typeof data?.code === 'string' ? data.code : undefined;
      const kind = kindOf(response.status, code);
      const retryAfterMs = retryAfter(response.headers, data);
      if (kind === ERROR_KINDS.RATE_LIMITED && attempt === 0) {
        const wait = retryAfterMs ?? 1000;
        if (wait <= MAX_INLINE_RETRY_MS) {
          await sleep(wait, signal);
          if (signal?.aborted) {
            throw signal.reason;
          }
          continue;
        }
      }
      // The server message never carries the key.
      const reason = typeof data?.msg === 'string' ? data.msg.slice(0, 200) : '';
      throw new ZulipError(kind, `${method} ${path}: HTTP ${response.status} ${reason}`.trim(), {
        status: response.status,
        code,
        retryAfterMs,
      });
    }
  }

  /** The account behind the key: `{ user_id, email, full_name, is_bot... }`. */
  me(options) {
    return this.request('GET', '/users/me', options);
  }

  /** Every user of the organization the bot can see, deactivated ones included. */
  async users({ signal } = {}) {
    const data = await this.request('GET', '/users', {
      query: { include_custom_profile_fields: false },
      signal,
    });
    return Array.isArray(data.members) ? data.members : [];
  }

  /** The id of a channel by its name (case-insensitive on the server). */
  async channelId(name, { signal } = {}) {
    const data = await this.request('GET', '/get_stream_id', { query: { stream: name }, signal });
    return data.stream_id;
  }

  /**
   * Subscribes the bot to channels by name (idempotent). Beware: an unknown
   * name creates the channel, so check it with channelId() first.
   */
  subscribe(names, { signal } = {}) {
    return this.request('POST', '/users/me/subscriptions', {
      fields: { subscriptions: names.map((name) => ({ name })) },
      signal,
    });
  }

  /**
   * Registers an event queue for new messages, Markdown as typed (not HTML).
   * Resolves with `{ queue_id, last_event_id, max_message_id... }`.
   */
  register({ signal } = {}) {
    return this.request('POST', '/register', {
      fields: {
        event_types: ['message'],
        apply_markdown: false,
        client_gravatar: true,
        slim_presence: true,
      },
      signal,
    });
  }

  /**
   * The events after `lastEventId`: blocks until there is one, or a heartbeat,
   * unless `dontBlock` (an answer at once, to know the server is back).
   */
  async events(queueId, lastEventId, { signal, dontBlock = false } = {}) {
    const data = await this.request('GET', '/events', {
      query: {
        queue_id: queueId,
        last_event_id: lastEventId,
        ...(dontBlock ? { dont_block: true } : {}),
      },
      // A dont_block poll answers at once: a server that hangs is found in 15 s, not 90.
      timeoutMs: dontBlock ? REQUEST_TIMEOUT_MS : EVENTS_TIMEOUT_MS,
      signal,
    });
    return Array.isArray(data.events) ? data.events : [];
  }

  /** Deletes an event queue (on stop: the server would expire it after 10 minutes anyway). */
  deleteQueue(queueId, { signal } = {}) {
    return this.request('DELETE', '/events', { fields: { queue_id: queueId }, signal });
  }

  /**
   * The newest messages of a narrow, oldest first: `[{ operator: 'is', operand:
   * 'private' }]` (the direct messages) or `[{ operator: 'stream', operand: id }]`.
   * Both operators are understood by every server version.
   */
  async recentMessages(count, narrow, { signal } = {}) {
    const data = await this.request('GET', '/messages', {
      query: {
        anchor: 'newest',
        num_before: count,
        num_after: 0,
        narrow,
        apply_markdown: false,
        client_gravatar: true,
      },
      signal,
    });
    return Array.isArray(data.messages) ? data.messages : [];
  }

  /**
   * Sends a message in a channel (`channel` + `topic`) or to people (`to`,
   * user ids). Resolves with `{ id }`.
   */
  sendMessage({ channel, topic, to, content }, { signal } = {}) {
    const fields = to
      ? { type: 'private', to, content }
      : // As JSON: a bare "2024" would be read as the id of a channel.
        { type: 'stream', to: JSON.stringify(channel), topic, content };
    return this.request('POST', '/messages', { fields, signal });
  }

  /** Uploads a file. Resolves with its path on the server (/user_uploads/...). */
  async upload(buffer, contentType, fileName) {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: contentType }), fileName);
    const data = await this.request('POST', '/user_uploads', { form, timeoutMs: 30_000 });
    // `uri` before Zulip 9, `url` since; both are kept by the current servers.
    const path = data.url ?? data.uri;
    if (typeof path !== 'string') {
      throw new ZulipError(ERROR_KINDS.NOT_ZULIP, 'Upload answer without an address');
    }
    return path;
  }
}
