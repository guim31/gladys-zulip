// -----------------------------------------------------------------------------
// The integration wired to the fake Gladys of the SDK and to a fake Zulip
// server: a `fetch` replacement for the REST API and the event queues, shaped
// like the answers of a real Zulip 12.3 (test/fixtures/zulip/). No network, a
// virtual clock, manual sleeps.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';

export const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/zulip/${name}.json`, import.meta.url), 'utf8'));

export const SERVER = 'https://zulip.test';
const me = fixture('users-me');
export const BOT_EMAIL = me.email;
export const API_KEY = 'Y0urAp1KeyY0urAp1KeyY0urAp1Key00';
export const BOT_ID = me.user_id; // 9
export const ALICE_ID = 8; // alice@example.org, shown as user8@zulip.test
export const MALLORY_ID = 10;
export const ALICE_BOT_ID = 11; // a bot owned by Alice
export const GARAGE = 4; // public, the bot is not in it yet
export const FAMILY = 5; // private, without the bot
export const START = Date.parse('2026-10-20T10:00:00Z');

export const BASE_CONFIG = {
  server_url: SERVER,
  bot_email: BOT_EMAIL,
  api_key: API_KEY,
  channels: 'garage',
  allowed_users: 'user8@zulip.test',
  language: 'en',
};

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const error = (status, code, msg, extra = {}) =>
  json(status, { result: 'error', msg, code, ...extra });

const ok = (body = {}) => json(200, { result: 'success', msg: '', ...body });

/** A fake Zulip server: just enough of the REST API and of the event queues, recorded. */
export function createFakeServer() {
  const server = {
    down: null, // an error code (ECONNREFUSED...) makes every request fail
    keys: new Map([[BOT_EMAIL, API_KEY]]),
    users: new Map([
      ...fixture('users').members.map((user) => [user.user_id, { ...user }]),
      [
        ALICE_BOT_ID,
        { user_id: ALICE_BOT_ID, email: 'alice-bot@zulip.test', full_name: 'Alice', is_bot: true },
      ],
    ]),
    channels: new Map([
      [GARAGE, { id: GARAGE, name: 'garage', private: false, members: new Set([ALICE_ID]) }],
      [FAMILY, { id: FAMILY, name: 'family', private: true, members: new Set([ALICE_ID]) }],
    ]),
    messages: [], // every message, as in an event
    queues: new Map(), // queue id → { events, waiters }
    uploads: [],
    requests: [], // { method, path }
    rejectMessages: false, // a 400, as for a message too long
    dropNewQueues: false, // a new queue is unknown at once (a proxy mixing two servers)
    clock: () => START,
  };
  let nextQueue = 1;
  let nextChannel = 10;

  const caller = (authorization = '') => {
    const [email, key] = Buffer.from(authorization.replace(/^Basic /, ''), 'base64')
      .toString()
      .split(':');
    return server.keys.get(email) === key ? email : null;
  };
  const channelByName = (name) =>
    [...server.channels.values()].find((c) => c.name.toLowerCase() === name.toLowerCase());
  const visible = (channel) => channel && (!channel.private || channel.members.has(BOT_ID));
  const canSee = (message) =>
    message.type === 'stream'
      ? server.channels.get(message.stream_id)?.members.has(BOT_ID)
      : message.display_recipient.some((user) => user.id === BOT_ID);

  server.fetch = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = init.method ?? 'GET';
    const path = pathname.replace(/^\/api\/v1/, '');
    server.requests.push({ method, path });
    if (init.signal?.aborted) {
      throw init.signal.reason; // like fetch: an aborted request never starts
    }
    if (server.down) {
      throw new TypeError('fetch failed', { cause: { code: server.down } });
    }
    if (!pathname.startsWith('/api/v1/')) {
      return new Response('<html>Not found</html>', { status: 404 });
    }
    if (!caller(init.headers?.authorization)) {
      return json(401, fixture('error-401'), { 'www-authenticate': 'Basic realm="zulip"' });
    }
    const form = init.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    const param = (key) => form.get(key) ?? searchParams.get(key);

    if (path === '/users/me') {
      return ok(server.users.get(BOT_ID));
    }
    if (path === '/users') {
      return ok({ members: [...server.users.values()] });
    }
    if (path === '/get_stream_id') {
      const channel = channelByName(param('stream'));
      return visible(channel)
        ? ok({ stream_id: channel.id })
        : error(400, 'BAD_REQUEST', `Invalid channel name '${param('stream')}'`);
    }
    if (method === 'POST' && path === '/users/me/subscriptions') {
      const subscribed = [];
      const already = [];
      for (const { name } of JSON.parse(param('subscriptions'))) {
        let channel = channelByName(name);
        if (!channel) {
          // A real Zulip creates the channel: the integration must never get here.
          channel = { id: nextChannel++, name, private: false, members: new Set() };
          server.channels.set(channel.id, channel);
        }
        if (!visible(channel)) {
          return error(400, 'BAD_REQUEST', `Unable to access channel (${name}).`);
        }
        (channel.members.has(BOT_ID) ? already : subscribed).push(name);
        channel.members.add(BOT_ID);
      }
      return ok({
        subscribed: subscribed.length ? { [BOT_ID]: subscribed } : {},
        already_subscribed: already.length ? { [BOT_ID]: already } : {},
      });
    }
    if (method === 'POST' && path === '/register') {
      const id = `queue-${nextQueue++}`;
      if (!server.dropNewQueues) {
        server.queues.set(id, { events: [], waiters: [], next: 0 });
      }
      return ok({
        ...fixture('register'),
        queue_id: id,
        last_event_id: -1,
        max_message_id: server.messages.at(-1)?.id ?? -1,
      });
    }
    if (path === '/events') {
      const queue = server.queues.get(param('queue_id'));
      if (!queue) {
        return json(400, { ...fixture('events-bad-queue'), queue_id: param('queue_id') });
      }
      if (method === 'DELETE') {
        server.queues.delete(param('queue_id'));
        return ok();
      }
      const last = Number(param('last_event_id'));
      const pending = () => queue.events.filter((event) => event.id > last);
      if (pending().length === 0 && param('dont_block') !== 'true') {
        // Long polling: wait for an event, the queue expiring, or the caller giving up.
        await new Promise((resolve, reject) => {
          queue.waiters.push({ resolve, reject });
          init.signal?.addEventListener('abort', () => reject(init.signal.reason), {
            once: true,
          });
        });
      }
      if (!server.queues.has(param('queue_id'))) {
        return json(400, { ...fixture('events-bad-queue'), queue_id: param('queue_id') });
      }
      return ok({ events: pending() });
    }
    if (path === '/messages' && method === 'GET') {
      const count = Number(param('num_before'));
      const [term] = JSON.parse(param('narrow') ?? '[]');
      const inNarrow = (m) =>
        !term ||
        (term.operator === 'is' ? m.type === 'private' : m.stream_id === Number(term.operand));
      return ok({ messages: server.messages.filter(canSee).filter(inNarrow).slice(-count) });
    }
    if (method === 'POST' && path === '/messages') {
      if (server.rejectMessages) {
        return error(400, 'BAD_REQUEST', 'Message must not be longer than 10000 characters.');
      }
      let target;
      if (['private', 'direct'].includes(param('type'))) {
        target = JSON.parse(param('to'));
        if (!target.every((id) => server.users.has(id))) {
          return error(400, 'BAD_REQUEST', 'Invalid user ID');
        }
      } else {
        const name = JSON.parse(param('to')); // a channel name as JSON, as Zulip parses it
        const channel = channelByName(name);
        if (!channel) {
          return error(400, 'STREAM_DOES_NOT_EXIST', `Channel '${name}' does not exist`, {
            stream: name,
          });
        }
        if (!visible(channel)) {
          return error(400, 'BAD_REQUEST', 'Not authorized to send to channel');
        }
        target = channel.id;
      }
      const message = server.publish(BOT_ID, target, param('content'), { topic: param('topic') });
      return ok({ id: message.id });
    }
    if (method === 'POST' && path === '/user_uploads') {
      const file = init.body.get('file');
      server.uploads.push({ size: file.size, type: file.type, name: file.name });
      const url = `/user_uploads/2/ab/xyz${server.uploads.length}/${file.name}`;
      return ok({ uri: url, url, filename: file.name });
    }
    return error(404, 'BAD_REQUEST', 'Endpoint not found');
  };

  /**
   * A new message, pushed to the event queues of the bot when it can see it.
   * @param {number} senderId
   * @param {number|number[]} target a channel id, or the user ids of a direct message (sender excluded)
   */
  server.publish = (senderId, target, content, { topic = 'door', timestamp } = {}) => {
    const sender = server.users.get(senderId);
    const id = 100 + server.messages.length;
    const common = {
      id,
      sender_id: senderId,
      content,
      timestamp: timestamp ?? Math.floor(server.clock() / 1000),
      client: 'website',
      sender_full_name: sender.full_name,
      sender_email: sender.email,
      sender_realm_str: '',
      content_type: 'text/x-markdown',
    };
    let message;
    if (Array.isArray(target)) {
      const people = [...new Set([senderId, ...target])].sort((a, b) => a - b);
      message = {
        ...common,
        type: 'private',
        subject: '',
        display_recipient: people.map((userId) => ({
          id: userId,
          email: server.users.get(userId).email,
          full_name: server.users.get(userId).full_name,
          is_mirror_dummy: false,
        })),
      };
    } else {
      const channel = server.channels.get(target);
      message = {
        ...common,
        type: 'stream',
        stream_id: channel.id,
        display_recipient: channel.name,
        subject: topic,
      };
    }
    server.messages.push(message);
    if (canSee(message)) {
      for (const queue of server.queues.values()) {
        queue.events.push({ type: 'message', message, flags: [], id: queue.next++ });
        queue.waiters.splice(0).forEach((waiter) => waiter.resolve());
      }
    }
    return message;
  };

  /** Every queue garbage-collected, as after 10 minutes without a poll (or a server restart). */
  server.expireQueues = () => {
    const queues = [...server.queues.values()];
    server.queues.clear();
    queues.forEach((queue) => queue.waiters.splice(0).forEach((waiter) => waiter.resolve()));
  };

  /** The server stops answering: pending long polls fail too. */
  server.goDown = (code = 'ECONNREFUSED') => {
    server.down = code;
    for (const queue of server.queues.values()) {
      queue.waiters
        .splice(0)
        .forEach((waiter) => waiter.reject(new TypeError('fetch failed', { cause: { code } })));
    }
  };

  return server;
}

export function createMemoryStore(initial = {}) {
  return {
    data: structuredClone(initial),
    writes: 0,
    async load() {
      return structuredClone(this.data);
    },
    async save(data) {
      this.data = structuredClone(data);
      this.writes += 1;
    },
    async flush() {},
  };
}

/** Lets pending promises and fetches settle. */
export async function settle(rounds = 30) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export async function createWorld({
  config = BASE_CONFIG,
  stored = {},
  server = createFakeServer(),
  linkedUser,
} = {}) {
  const gladys = createFakeGladys({ config, linkedUser });
  const store = createMemoryStore(stored);
  const clock = { time: START };
  server.clock = () => clock.time;
  const sleeps = [];
  const app = registerHandlers(gladys, {
    fetch: server.fetch,
    store,
    now: () => clock.time,
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        const entry = { ms, resolve };
        sleeps.push(entry);
        signal.addEventListener('abort', resolve);
      }),
  });
  /** Ends the oldest pending sleep, moving the clock forward by its length. */
  const wake = async () => {
    await settle();
    const entry = sleeps.shift();
    if (!entry) {
      throw new Error('nothing is sleeping');
    }
    clock.time += entry.ms;
    entry.resolve();
    await settle();
    return entry.ms;
  };
  await gladys.connect();
  await settle();
  return { gladys, fake: gladys.fake, server, store, clock, sleeps, wake, app };
}
