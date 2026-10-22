// -----------------------------------------------------------------------------
// The integration: a Zulip generic bot wired to Gladys.
//
// - A connection loop: the REST API (who am I, the allowed people, the watched
//   channels), then an event queue (register, then long polling), which brings
//   every new message the bot can see. After a restart or an expired queue,
//   the messages of the last minutes are read back. Only the people of the
//   "allowed" list are ever answered or obeyed.
// - Watched channels (configuration): every message fires `message_received`,
//   a message starting with the command prefix also fires `command_received`.
// - A direct message between the bot and one allowed person is a conversation
//   with Gladys (manifest `type: "communication"`): a link code links the
//   Zulip account to a Gladys user, then the messages go to the brain
//   (publishMessage) and the answers come back through onSendMessage.
// - Anything else (group direct messages, other channels) is ignored: Gladys
//   never answers where others can read.
// - Scene action `send_message`: a message in a channel topic, or to a person.
// - Triggers `connection_lost` / `connection_restored`, the connection status
//   of the Configuration screen, the widget and the `test_connection` action.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, parseChannelName, parsePerson, parseServer } from './config.js';
import {
  ERROR_KINDS,
  MAX_MESSAGE_LENGTH,
  MAX_TOPIC_LENGTH,
  TRANSIENT_KINDS,
  ZulipClient,
  ZulipError,
} from './zulip/client.js';
import { createFailureLog } from './log.js';
import { Store } from './store.js';
import {
  BOT_TEXT,
  PARTIAL_STATUS,
  REPORT_TEXT,
  each,
  errorText,
  errorTexts,
  pick,
} from './texts.js';
import { CONNECTION, TEST_ACTION, WIDGET_KEY, buildWidgetContent } from './widgets.js';

const logger = createLogger({ name: 'zulip' });

export const ACTION_KEY = 'test_connection';
export const SCENE_ACTION_KEY = 'send_message';
export const TRIGGERS = {
  MESSAGE: 'message_received',
  COMMAND: 'command_received',
  LOST: 'connection_lost',
  RESTORED: 'connection_restored',
};

// Messages older than this when the bot reads them (missed while Gladys or
// the container was down) are skipped: a "!open garage" from two hours ago
// must not run now.
export const MAX_MESSAGE_AGE_MS = 5 * 60 * 1000;
// The connection is declared lost after failures lasting this long, never on one blip.
export const LOST_AFTER_MS = 60 * 1000;
export const RETRY_DELAYS_MS = [2000, 5000, 10_000, 30_000, 60_000];
// Refused credentials: retry slowly, in case the server was the cause.
export const CREDENTIALS_RETRY_MS = 5 * 60 * 1000;
export const RECENT_KEPT = 5;
// The newest messages read back after a new event queue (the 5 minutes window).
export const CATCH_UP_COUNT = 100;
// Message ids already handled: the event queue and the catch-up may both bring one.
const SEEN_KEPT = 200;
const SEEN_SAVED = 50;
// Gladys waits 5 s for the ack of a message: answer before, even if the server is slow.
export const MESSAGE_TIMEOUT_MS = 4500;
// How long a message of Gladys waits for the first connection, within that deadline.
export const CONNECT_WAIT_MS = 2000;
// The topic of a scene message when the scene gives none.
export const DEFAULT_TOPIC = 'Gladys';
// Gladys link codes: 8 characters of an alphabet without 0/O/1/I/L.
const LINK_CODE = /^[A-HJ-KM-NP-Z2-9]{8}$/i;
const MAX_TEXT_LENGTH = 4096; // the limit of publishMessage
// A mention at the start of a message: @**Name**, @**Name|12**, @_**Name** (silent).
const LEADING_MENTION = /^@_?\*\*([^*|]+)(?:\|(\d+))?\*\*\s*/;

const fingerprint = (...parts) =>
  createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);

/** Parses a command: "!lights off" → { command: "lights", args: "off" }. */
export function parseCommand(text, prefix) {
  if (!text.startsWith(prefix)) {
    return null;
  }
  const rest = text.slice(prefix.length);
  const match = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return null;
  }
  return { command: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
}

/** Parses an image of Gladys (a camera): "image/jpg;base64,..." (data: optional). */
export function parseImage(file) {
  if (typeof file !== 'string') {
    return null;
  }
  const match = file.match(/^(?:data:)?(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    return null;
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0) {
    return null;
  }
  // Gladys writes image/jpg: the registered type is image/jpeg.
  const contentType =
    match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  const extension = contentType.split('/')[1].replace('jpeg', 'jpg').replace(/\+.*$/, '');
  return { buffer, contentType, extension };
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {object} [options] replaced by the tests
 * @param {typeof fetch} [options.fetch]
 * @param {{ load(): Promise<object>, save(data: object): Promise<void>, flush(): Promise<void> }} [options.store]
 * @param {() => number} [options.now] milliseconds
 * @param {(ms: number, signal: AbortSignal) => Promise<void>} [options.sleep]
 */
export function registerHandlers(gladys, options = {}) {
  const {
    fetch: fetchImpl = globalThis.fetch,
    store = new Store(),
    now = () => Date.now(),
    sleep = (ms, signal) =>
      new Promise((resolve) => {
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
  } = options;

  let data = {}; // persisted: see save()
  const loaded = store.load().then((stored) => {
    data = stored ?? {};
    seen = new Set(Array.isArray(data.seen) ? data.seen : []);
  });

  let config = normalizeConfig({});
  let client = null;
  let me = null; // the bot account: { id, email, name }
  let configError = new ZulipError(ERROR_KINDS.NOT_CONFIGURED, 'Not configured yet');
  let connection = CONNECTION.NOT_CONFIGURED;
  let lastError = null;
  let watched = new Map(); // channel id → the name typed in the configuration
  let allowed = new Map(); // user id → { entry, name }: the allowed people found
  let failures = []; // channels and people of the configuration not found or not joined
  let queueId = null; // the event queue of the running loop
  let controller = null; // aborts the running loop
  let running = null; // the running loop
  let stopped = false;
  let lastStatus = null;
  let connectionKey = null; // server and credentials of the applied configuration
  let lostFired = false; // connection_lost was fired: connection_restored may follow
  let applying = Promise.resolve(); // configurations are applied one at a time
  let readyWaiters = []; // onSendMessage calls waiting for the first connection
  let seen = new Set(); // ids of the messages already handled, persisted (data.seen)
  const strangers = new Set(); // user ids of the people not allowed who wrote to the bot
  const statusLog = createFailureLog(logger, { recovered: 'Connection status published again' });
  const queueLog = createFailureLog(logger, { recovered: 'Zulip connection works again' });
  const brainLog = createFailureLog(logger, { recovered: 'Messages reach Gladys again' });

  function save() {
    return store.save(data);
  }

  // --- Gladys side effects, never fatal --------------------------------------

  async function publishStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === lastStatus || !gladys.connected) {
      return;
    }
    try {
      await gladys.setConnectionStatus(connected, message);
      lastStatus = key;
      statusLog.ok();
    } catch (err) {
      statusLog.fail(`Cannot publish the connection status: ${err.message}`);
    }
  }

  async function fire(key, payload) {
    try {
      await gladys.publishSceneEvent(key, payload);
    } catch (err) {
      logger.warn(`Cannot fire the "${key}" trigger: ${err.message}`);
    }
  }

  function refreshWidget() {
    try {
      gladys.requestWidgetRefresh(WIDGET_KEY);
    } catch (err) {
      logger.debug(`Widget refresh not requested: ${err.message}`);
    }
  }

  function setConnection(next) {
    if (connection !== next) {
      connection = next;
      refreshWidget();
    }
  }

  // --- Connection ----------------------------------------------------------------

  /** Finds a person of the organization: by user id, or by e-mail (shown or real). */
  function findPerson(users, entry) {
    return users.find(
      (user) =>
        String(user.user_id) === entry ||
        user.email?.toLowerCase() === entry ||
        user.delivery_email?.toLowerCase() === entry,
    );
  }

  /** Checks the credentials, then finds the allowed people and the watched channels. */
  async function connect(signal) {
    const account = fingerprint(client.base.href, config.bot_email, config.api_key);
    if (data.account !== account) {
      // Another server or another bot: nothing stored applies any more.
      data = { account, recent: data.recent ?? [] };
      seen = new Set();
      await save();
    }
    const user = await client.me({ signal });
    me = { id: user.user_id, email: user.email, name: user.full_name };
    const missing = [];

    const users = config.allowed_users.length > 0 ? await client.users({ signal }) : [];
    const found = new Map();
    for (const entry of config.allowed_users) {
      const person = findPerson(users, entry);
      // Never a bot (its owner could make it speak) nor a deactivated account.
      if (!person || person.is_bot || person.is_active === false || person.user_id === me.id) {
        missing.push(entry);
        logger.warn(`Allowed person ${entry} not found on the server`);
        continue;
      }
      found.set(person.user_id, { entry, name: person.full_name || entry });
    }
    allowed = found;

    const channels = new Map();
    for (const name of config.channels) {
      try {
        // The id first: subscribing to an unknown name would create the channel. A
        // private channel the bot is not in is unknown too (400 "Invalid channel name").
        const channelId = await client.channelId(name, { signal });
        const answer = await client.subscribe([name], { signal }); // idempotent
        if (Object.keys(answer.subscribed ?? {}).length > 0) {
          logger.info(`Joined the watched channel #${name}`);
        }
        channels.set(channelId, name);
      } catch (err) {
        if (
          signal.aborted ||
          TRANSIENT_KINDS.has(err.kind) ||
          err.kind === ERROR_KINDS.CREDENTIALS
        ) {
          throw err;
        }
        missing.push(`#${name}`);
        logger.warn(`Cannot watch the channel #${name}: ${err.message}`);
      }
    }
    watched = channels;
    failures = missing;
  }

  const partialStatus = () =>
    failures.length > 0 ? each(PARTIAL_STATUS, (text) => text(failures.join(', '))) : undefined;

  async function markConnected() {
    lastError = null;
    if (connection !== CONNECTION.CONNECTED) {
      logger.info(`Connected to Zulip as ${me.email}`);
    }
    setConnection(CONNECTION.CONNECTED);
    readyWaiters.splice(0).forEach((wake) => wake());
    await publishStatus(true, partialStatus());
    if (lostFired) {
      lostFired = false;
      logger.info('Zulip connection restored');
      await fire(TRIGGERS.RESTORED, { user: me?.email ?? '' });
    }
  }

  /** Resolves once the bot is connected, or after `ms` at most. */
  function whenConnected(ms) {
    if (me && connection === CONNECTION.CONNECTED) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        readyWaiters = readyWaiters.filter((waiter) => waiter !== wake);
        resolve();
      }, ms);
      readyWaiters.push(wake);
    });
  }

  // --- The connection loop -------------------------------------------------------

  /** A new event queue, then the messages missed since the last one. */
  async function openQueue(signal) {
    await connect(signal);
    const queue = await client.register({ signal });
    queueId = queue.queue_id;
    const lastSeen = data.lastMessageId;
    if (!Number.isInteger(lastSeen)) {
      // First start with this bot: the history is not replayed.
      data.lastMessageId = queue.max_message_id ?? 0;
      save();
    }
    return { lastEventId: queue.last_event_id, catchUpFrom: lastSeen, max: queue.max_message_id };
  }

  async function loop(signal) {
    let failingSince = null;
    let attempt = 0;
    let lastEventId = null;
    queueId = null;
    if (connection !== CONNECTION.DISCONNECTED) {
      // A reconnection keeps "connected" until the loss is declared.
      setConnection(CONNECTION.CONNECTING);
    }
    const succeeded = async () => {
      failingSince = null;
      attempt = 0;
      queueLog.ok();
      if (connection !== CONNECTION.CONNECTED || lostFired) {
        await markConnected();
      }
    };
    while (!signal.aborted) {
      try {
        if (!queueId) {
          const opened = await openQueue(signal);
          lastEventId = opened.lastEventId;
          await succeeded();
          if (Number.isInteger(opened.catchUpFrom) && opened.max > opened.catchUpFrom) {
            await catchUp(opened.catchUpFrom, signal);
          }
        }
        // After a failure, an answer at once: the server being back is known without
        // waiting for the next event or heartbeat.
        const events = await client.events(queueId, lastEventId, {
          signal,
          dontBlock: failingSince !== null,
        });
        await succeeded();
        for (const event of events) {
          if (Number.isInteger(event.id) && event.id > lastEventId) {
            lastEventId = event.id;
          }
          if (event.type === 'message') {
            await handleMessage(event.message);
          }
        }
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        const error =
          err instanceof ZulipError ? err : new ZulipError(ERROR_KINDS.SERVER, err.message);
        if (error.kind === ERROR_KINDS.QUEUE_EXPIRED) {
          // Garbage-collected after 10 minutes without a poll: a new queue, read back what was missed.
          logger.debug('Event queue expired: registering a new one');
          queueId = null;
          continue;
        }
        const transient = TRANSIENT_KINDS.has(error.kind);
        lastError = error;
        let delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        attempt += 1;
        if (!transient) {
          // The configuration is wrong: say it, and retry slowly in case the server is the cause.
          delay = CREDENTIALS_RETRY_MS;
          queueId = null;
        } else if (error.kind === ERROR_KINDS.RATE_LIMITED && error.retryAfterMs > delay) {
          delay = error.retryAfterMs;
        }
        failingSince ??= now();
        queueLog.fail(`Zulip connection failed: ${error.message}`);
        if (!transient || now() - failingSince >= LOST_AFTER_MS) {
          if (connection !== CONNECTION.DISCONNECTED) {
            const wasConnected = connection === CONNECTION.CONNECTED;
            setConnection(CONNECTION.DISCONNECTED);
            logger.warn(`Zulip connection lost: ${error.message}`);
            if (wasConnected) {
              lostFired = true;
              await fire(TRIGGERS.LOST, { error: errorText(error, config.language) });
            }
          }
          await publishStatus(false, errorTexts(error));
        }
        await sleep(delay, signal);
      }
    }
  }

  /** Handles the messages after `afterId` (a new queue: a restart, an expired queue). */
  async function catchUp(afterId, signal) {
    try {
      const messages = await client.recentMessages(CATCH_UP_COUNT, { signal });
      for (const message of messages) {
        if (message.id > afterId) {
          await handleMessage(message);
        }
      }
    } catch (err) {
      if (!signal.aborted) {
        logger.debug(`Missed messages not read: ${err.message}`);
      }
    }
  }

  /** The text of a message, without a mention of the bot in front. */
  function textOf(message) {
    let text = typeof message.content === 'string' ? message.content.trim() : '';
    const mention = text.match(LEADING_MENTION);
    if (mention && (Number(mention[2]) === me.id || mention[1].trim() === me.name)) {
      text = text.slice(mention[0].length).trim();
    }
    return text;
  }

  /** A direct message between the bot and its sender, nobody else (not a group). */
  function isDirect(message) {
    const recipients = Array.isArray(message.display_recipient) ? message.display_recipient : [];
    return (
      ['private', 'direct'].includes(message.type) &&
      recipients.length === 2 &&
      recipients.some((recipient) => recipient.id === me.id)
    );
  }

  /** One message, from the event queue or the catch-up. */
  async function handleMessage(message) {
    if (!message || !Number.isInteger(message.id) || seen.has(message.id)) {
      return;
    }
    seen.add(message.id);
    if (seen.size > SEEN_KEPT) {
      seen.delete(seen.values().next().value);
    }
    data.seen = [...seen].slice(-SEEN_SAVED);
    if (message.id > (data.lastMessageId ?? 0)) {
      data.lastMessageId = message.id;
    }
    save();
    if (!me || message.sender_id === me.id) {
      return; // its own messages: no loop between a scene and its triggers
    }
    const person = allowed.get(message.sender_id);
    if (!person) {
      if (isDirect(message) && !strangers.has(message.sender_id)) {
        // Once per person: the user id to add to the allowed people, when e-mails are hidden.
        strangers.add(message.sender_id);
        logger.info(
          `Direct message from user id ${message.sender_id}, not in the allowed people: ignored`,
        );
      }
      logger.debug(`Message ${message.id} ignored: not from an allowed person`);
      return;
    }
    if (message.timestamp * 1000 < now() - MAX_MESSAGE_AGE_MS) {
      logger.debug(`Message ${message.id} skipped: too old`);
      return;
    }
    const text = textOf(message);
    if (text === '') {
      return;
    }
    try {
      if (['stream', 'channel'].includes(message.type) && watched.has(message.stream_id)) {
        await handleChannelMessage(message, person, text);
      } else if (isDirect(message)) {
        // A direct message between the bot and this allowed person, nobody else.
        await handleConversation(message, person, text);
      } else {
        logger.debug(
          `Message ${message.id} ignored: neither a watched channel nor a direct message`,
        );
      }
    } catch (err) {
      logger.warn(`Message ${message.id} not handled: ${err.message}`);
    }
  }

  async function handleChannelMessage(message, person, text) {
    const channel = watched.get(message.stream_id);
    const topic = typeof message.subject === 'string' ? message.subject : '';
    const at = new Date(message.timestamp * 1000 || now()).toISOString();
    data.recent = [
      { channel, topic, sender: person.name, text: text.slice(0, 500), at },
      ...(data.recent ?? []),
    ].slice(0, RECENT_KEPT);
    save();
    refreshWidget();
    logger.debug(`Message from ${person.entry} in #${channel}`);
    const common = {
      channel,
      channel_id: String(message.stream_id),
      topic,
      sender: person.entry,
      sender_name: person.name,
      text: text.slice(0, 1000),
    };
    await fire(TRIGGERS.MESSAGE, common);
    const command = parseCommand(text, config.command_prefix);
    if (command) {
      await fire(TRIGGERS.COMMAND, {
        ...common,
        command: command.command.slice(0, 1000),
        arguments: command.args.slice(0, 1000),
      });
    }
  }

  async function reply(userId, text) {
    try {
      await client.sendMessage({ to: [userId], content: text });
    } catch (err) {
      logger.warn(`Cannot answer in Zulip: ${err.message}`);
    }
  }

  async function handleConversation(message, person, text) {
    const userId = message.sender_id;
    const contactId = String(userId);
    if (LINK_CODE.test(text)) {
      try {
        const user = await gladys.linkContact(text.toUpperCase(), contactId, person.name);
        logger.info(`Zulip account ${person.entry} linked to a Gladys user`);
        const language = BOT_TEXT[user?.language] ? user.language : config.language;
        await reply(userId, pick(BOT_TEXT, language).linked(user?.first_name || person.name));
        return;
      } catch (err) {
        if (err?.status !== 404) {
          logger.warn(`Cannot link ${person.entry}: ${err.message}`);
          await reply(userId, pick(BOT_TEXT, config.language).unavailable);
          return;
        }
        // Not a valid code: maybe a word that looks like one, for the brain.
      }
    }
    try {
      await gladys.publishMessage(contactId, text.slice(0, MAX_TEXT_LENGTH), {
        createdAt: new Date(message.timestamp * 1000 || now()),
      });
      brainLog.ok();
      logger.debug(`Message from ${person.entry} passed to Gladys`);
    } catch (err) {
      if (err?.status === 404) {
        logger.info(`Message from ${person.entry}, whose account is not linked: instructions sent`);
        await reply(userId, pick(BOT_TEXT, config.language).notLinked);
        return;
      }
      brainLog.fail(`Cannot pass a message to Gladys: ${err.message}`);
      await reply(userId, pick(BOT_TEXT, config.language).unavailable);
    }
  }

  // --- Configuration -------------------------------------------------------------

  async function stopLoop() {
    controller?.abort();
    await running;
    if (queueId && client) {
      // Frees the queue now rather than in 10 minutes; never blocks a stop.
      client
        .deleteQueue(queueId, { signal: AbortSignal.timeout(2000) })
        .catch((err) => logger.debug(`Event queue not deleted: ${err.message}`));
    }
    queueId = null;
    controller = null;
    running = null;
  }

  function applyConfig(raw) {
    // Serialized: two saves in a row must never leave two loops running.
    applying = applying.then(() => doApplyConfig(raw));
    return applying;
  }

  async function doApplyConfig(raw) {
    await loaded;
    await stopLoop();
    config = normalizeConfig(raw);
    client = null;
    me = null;
    lastError = null;
    watched = new Map();
    allowed = new Map();
    failures = [];
    const previousKey = connectionKey;
    connectionKey = `${config.server_url}|${config.bot_email}|${config.api_key}`;
    if (connectionKey !== previousKey) {
      lostFired = false; // another server or bot: a loss of the old one is not restored here
    }
    const server = parseServer(config.server_url);
    if (!config.server_url) {
      configError = new ZulipError(ERROR_KINDS.NOT_CONFIGURED, 'No server address');
    } else if (!server) {
      configError = new ZulipError(ERROR_KINDS.INVALID_URL, 'Server address not understood');
    } else if (!config.bot_email || !config.api_key) {
      configError = new ZulipError(ERROR_KINDS.NO_CREDENTIALS, 'No bot e-mail or API key');
    } else {
      configError = null;
    }
    if (configError) {
      setConnection(CONNECTION.NOT_CONFIGURED);
      await publishStatus(false, errorTexts(configError));
      return;
    }
    client = new ZulipClient({
      server,
      email: config.bot_email,
      apiKey: config.api_key,
      fetch: fetchImpl,
    });
    if (stopped) {
      return;
    }
    controller = new AbortController();
    running = loop(controller.signal).catch((err) => logger.error('Zulip loop stopped', err));
  }

  function requireConnected() {
    if (!client) {
      throw configError;
    }
    if (!me) {
      throw lastError ?? new ZulipError(ERROR_KINDS.UNREACHABLE, 'Not connected to Zulip yet');
    }
    return client;
  }

  // --- Sending -------------------------------------------------------------------

  /**
   * Sends to a person ("alice@example.org", "@alice@example.org", "@12") or in
   * a channel ("garage", "#garage") under a topic.
   */
  async function sendTo(target, topic, content) {
    const zulip = requireConnected();
    const isPerson = target.startsWith('@') || target.includes('@');
    if (isPerson) {
      const entry = parsePerson(target);
      const person = entry ? findPerson(await zulip.users(), entry) : null;
      if (!person || person.is_active === false) {
        throw new ZulipError(ERROR_KINDS.NOT_FOUND, `Unknown user ${target}`);
      }
      return zulip.sendMessage({ to: [person.user_id], content });
    }
    const channel = parseChannelName(target);
    if (!channel) {
      throw new ZulipError(ERROR_KINDS.NOT_FOUND, `Not a channel: ${target}`);
    }
    return zulip.sendMessage({
      channel,
      topic: clip(topic.trim() || DEFAULT_TOPIC, MAX_TOPIC_LENGTH),
      content,
    });
  }

  async function sendImage(userId, file) {
    const image = parseImage(file);
    if (!image || !client) {
      return;
    }
    try {
      const name = `gladys.${image.extension}`;
      const path = await client.upload(image.buffer, image.contentType, name);
      await client.sendMessage({ to: [userId], content: `[${name}](${path})` });
    } catch (err) {
      logger.warn(`Image not sent to Zulip: ${err.message}`);
    }
  }

  async function testConnection() {
    if (!client) {
      return each(REPORT_TEXT, (text, lang) => text.failed(errorText(configError, lang)));
    }
    try {
      const user = await client.me();
      const lines = (text) => [
        text.connected(user.email),
        config.channels.length > 0
          ? text.channels(watched.size, config.channels.length)
          : text.noChannels,
        config.allowed_users.length > 0
          ? text.users(allowed.size, config.allowed_users.length)
          : text.noUsers,
      ];
      return each(REPORT_TEXT, (text) => lines(text).join(' '));
    } catch (err) {
      return each(REPORT_TEXT, (text, lang) => text.failed(errorText(err, lang)));
    }
  }

  // --- Handlers ------------------------------------------------------------------

  gladys.onSendMessage(async (contact, message) => {
    // Gladys gives up after 5 s: everything below holds in one deadline.
    const deadline = AbortSignal.timeout(MESSAGE_TIMEOUT_MS);
    const contactId = typeof contact?.id === 'string' ? contact.id : '';
    const userId = /^\d+$/.test(contactId) ? Number(contactId) : null;
    // Right after a start (the "Gladys updated" message), the bot may still be connecting.
    await whenConnected(CONNECT_WAIT_MS);
    if (!me) {
      requireConnected(); // throws: Gladys learns the message was not delivered
    }
    if (!allowed.has(userId)) {
      // Linked once, then removed from the allowed people: nothing goes out to them.
      logger.debug(
        `Message to ${contactId || 'an unknown contact'} not sent: not an allowed person`,
      );
      return;
    }
    const text = typeof message?.text === 'string' ? message.text : '';
    try {
      const zulip = requireConnected();
      if (text.trim() !== '') {
        await zulip.sendMessage(
          { to: [userId], content: clip(text, MAX_MESSAGE_LENGTH) },
          { signal: deadline },
        );
      }
      if (message?.file) {
        sendImage(userId, message.file); // after the ack: an upload takes longer than 5 s
      }
    } catch (err) {
      const failure = deadline.aborted
        ? new ZulipError(ERROR_KINDS.TIMEOUT, `No answer within ${MESSAGE_TIMEOUT_MS} ms`)
        : err;
      logger.warn(`Message not delivered to ${allowed.get(userId).entry}: ${failure.message}`);
      throw new Error(`Zulip: ${errorText(failure, 'en')}`, { cause: err });
    }
  });

  gladys.onSceneAction(SCENE_ACTION_KEY, async (fields) => {
    const target = typeof fields?.channel === 'string' ? fields.channel.trim() : '';
    const topic = typeof fields?.topic === 'string' ? fields.topic : '';
    const text = typeof fields?.message === 'string' ? fields.message : '';
    if (target === '' || text.trim() === '') {
      throw new Error('Zulip: the channel and the message are required');
    }
    try {
      const sent = await sendTo(target, topic, clip(text, MAX_MESSAGE_LENGTH));
      logger.info(`Scene message sent to ${target}`);
      return { sent: true, post_id: sent.id === undefined ? '' : String(sent.id), error: '' };
    } catch (err) {
      logger.warn(`Scene message not sent to ${target}: ${err.message}`);
      return { sent: false, post_id: '', error: errorText(err, config.language) };
    }
  });

  gladys.onAction(ACTION_KEY, () => testConnection());

  gladys.onWidgetGet(WIDGET_KEY, async ({ language }) => {
    await loaded;
    return buildWidgetContent(
      {
        connection,
        account: me?.email ?? null,
        channels: { joined: watched.size, total: config.channels.length },
        recent: data.recent ?? [],
      },
      language,
    );
  });

  gladys.onWidgetAction(WIDGET_KEY, async (actionKey) => {
    if (actionKey !== TEST_ACTION) {
      throw new Error(`Unknown widget action "${actionKey}"`);
    }
    const report = await testConnection();
    return each(report, (text) => clip(text, 200));
  });

  gladys.onConfigUpdated((raw) => applyConfig(raw));

  gladys.on('connected', () => {
    lastStatus = null; // a new connection: publish the status again
    return applyConfig(gladys.config).catch((err) =>
      logger.error('Cannot apply the configuration', err),
    );
  });

  return {
    get config() {
      return config;
    },
    get connection() {
      return connection;
    },
    get data() {
      return data;
    },
    async stop() {
      stopped = true;
      await stopLoop();
      save();
      await store.flush();
    },
  };
}
