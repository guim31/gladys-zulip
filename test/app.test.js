// -----------------------------------------------------------------------------
// The integration end to end: the fake Gladys of the SDK on one side, a fake
// Zulip (REST and event queues) answering like a real one on the other.
// -----------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { GladysApiError } from '@gladysassistant/integration-sdk';
import {
  ACTION_KEY,
  CREDENTIALS_RETRY_MS,
  LOST_AFTER_MS,
  MAX_MESSAGE_AGE_MS,
  SCENE_ACTION_KEY,
  TRIGGERS,
  parseCommand,
} from '../src/app.js';
import { WIDGET_KEY } from '../src/widgets.js';
import {
  ALICE_BOT_ID,
  ALICE_ID,
  BASE_CONFIG,
  BOT_ID,
  FAMILY,
  GARAGE,
  MALLORY_ID,
  START,
  createFakeServer,
  createWorld,
  settle,
} from './helpers/world.js';

async function connected(t, options) {
  const world = await createWorld(options);
  t.after(() => world.app.stop());
  assert.equal(world.app.connection, 'connected');
  return world;
}

/** Someone writes in a channel (an id) or to the bot (an array of user ids). */
async function say(world, target, text, userId = ALICE_ID, extra) {
  const message = world.server.publish(userId, target, text, extra);
  await settle();
  return message;
}

const toBot = [BOT_ID];
const botMessages = (world) => world.server.messages.filter((m) => m.sender_id === BOT_ID);
const recipients = (message) => message.display_recipient.map((user) => user.id);

test('not configured: says what is missing, never calls the server', async (t) => {
  const server = createFakeServer();
  const world = await createWorld({ config: {}, server });
  t.after(() => world.app.stop());
  assert.equal(world.app.connection, 'not_configured');
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.en, /address of the Zulip organization/);

  await world.fake.configUpdated({ server_url: 'ftp://zulip.test' });
  assert.match(world.fake.connectionStatus.message.fr, /adresse de l'organisation incomprise/);
  await world.fake.configUpdated({ server_url: 'zulip.test' }); // https:// is implied
  assert.match(world.fake.connectionStatus.message.de, /API-Schlüssel des Bots/);
  assert.deepEqual(server.requests, []);
});

test('connection: the key checked, the people found, the public channel joined', async (t) => {
  const world = await connected(t);
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
  assert.ok(world.server.channels.get(GARAGE).members.has(BOT_ID), 'the bot joined #garage');
  assert.equal(world.server.queues.size, 1);
  const paths = world.server.requests.map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(paths.slice(0, 5), [
    'GET /users/me',
    'GET /users',
    'GET /get_stream_id',
    'POST /users/me/subscriptions',
    'POST /register',
  ]);
  // The first start does not replay the history.
  assert.ok(!paths.includes('GET /messages'));
});

test('a refused key is said and retried slowly, without a lost trigger', async (t) => {
  const server = createFakeServer();
  server.keys.clear();
  const world = await createWorld({ server });
  t.after(() => world.app.stop());
  assert.equal(world.app.connection, 'disconnected');
  assert.match(world.fake.connectionStatus.message.en, /API key refused/);
  assert.equal(world.sleeps[0].ms, CREDENTIALS_RETRY_MS);
  assert.deepEqual(world.fake.sceneEvents, [], 'never connected: nothing was lost');
});

test('people and channels not found: connected, the status says which, nothing created', async (t) => {
  const world = await connected(t, {
    config: {
      ...BASE_CONFIG,
      allowed_users: 'user8@zulip.test, ghost@example.org, alice-bot@zulip.test',
      channels: '#garage, nope, family',
    },
  });
  assert.equal(world.fake.connectionStatus.connected, true);
  assert.match(
    world.fake.connectionStatus.message.en,
    /ghost@example\.org, alice-bot@zulip\.test, #nope, #family/,
  );
  assert.equal(world.server.channels.size, 2, 'an unknown name never creates a channel');
  const report = await world.fake.action(ACTION_KEY, {});
  assert.equal(
    report.data.message.en,
    'Connected as gladys-bot@zulip.test. Watched channels: 1/3. Allowed people found: 1/3.',
  );
});

test('a person is found by user id, by shown e-mail or by real e-mail', async (t) => {
  const server = createFakeServer();
  server.users.get(ALICE_ID).delivery_email = 'alice@example.org';
  for (const entry of ['8', 'user8@zulip.test', 'Alice@Example.org']) {
    const world = await connected(t, { server, config: { ...BASE_CONFIG, allowed_users: entry } });
    await say(world, GARAGE, 'hello');
    assert.equal(world.fake.sceneEvents.length, 1, entry);
    assert.equal(world.fake.sceneEvents[0].data.sender, entry.toLowerCase());
    await world.app.stop();
  }
});

test('a message in a watched channel fires the triggers, a command too', async (t) => {
  const world = await connected(t);
  await say(world, GARAGE, '!Lumieres off salon');
  const common = {
    channel: 'garage',
    channel_id: String(GARAGE),
    topic: 'door',
    sender: 'user8@zulip.test',
    sender_name: 'Alice Martin',
    text: '!Lumieres off salon',
  };
  assert.deepEqual(world.fake.sceneEvents, [
    { key: TRIGGERS.MESSAGE, data: common },
    { key: TRIGGERS.COMMAND, data: { ...common, command: 'lumieres', arguments: 'off salon' } },
  ]);
  const widget = await world.fake.widgetGet(WIDGET_KEY, { language: 'en', settings: {} });
  const [card] = widget.data.content.components[1].items;
  assert.equal(card.title, 'Alice Martin · door');
  assert.equal(card.badge.text, '#garage');
  assert.equal(card.date, new Date(START).toISOString());
});

test('a mention of the bot in front of a command is dropped', async (t) => {
  const world = await connected(t);
  await say(world, GARAGE, '@**Gladys** !open garage');
  await say(world, GARAGE, '@**Gladys|9** !close');
  await say(world, GARAGE, '@**Someone** !ignored');
  const commands = world.fake.sceneEvents.filter((event) => event.key === TRIGGERS.COMMAND);
  assert.deepEqual(
    commands.map((event) => event.data.command),
    ['open', 'close'],
  );
});

test('the bot obeys nobody else, and skips its own, other bots and old messages', async (t) => {
  const world = await connected(t);
  await say(world, GARAGE, '!garage open', MALLORY_ID);
  await say(world, GARAGE, '!garage open', BOT_ID);
  await say(world, GARAGE, '!garage open', ALICE_BOT_ID); // Alice's bot, not Alice
  await say(world, GARAGE, '!garage open', ALICE_ID, {
    timestamp: Math.floor((START - MAX_MESSAGE_AGE_MS - 1000) / 1000),
  });
  await say(world, toBot, 'let me in', MALLORY_ID);
  assert.deepEqual(world.fake.sceneEvents, []);
  assert.deepEqual(world.fake.messages, []);
  assert.equal(botMessages(world).length, 1, 'only the one written as the bot');
});

test('a group direct message is never a conversation with Gladys', async (t) => {
  const world = await connected(t);
  await say(world, [BOT_ID, MALLORY_ID], 'Turn off the heating');
  assert.deepEqual(world.fake.sceneEvents, []);
  assert.deepEqual(world.fake.messages, []);
  assert.deepEqual(botMessages(world), []);
});

test('direct message: the link code links the account, then messages go to Gladys', async (t) => {
  const world = await connected(t, {
    linkedUser: { selector: 'alice', first_name: 'Alice', language: 'fr' },
  });
  await say(world, toBot, 'abcd2345');
  assert.equal(world.fake.contacts[0].contact_id, String(ALICE_ID));
  assert.equal(world.fake.contacts[0].contact_name, 'Alice Martin');
  const [linked] = botMessages(world);
  assert.match(linked.content, /^Bonjour Alice/);
  assert.deepEqual(recipients(linked), [ALICE_ID, BOT_ID]);
  assert.deepEqual(world.fake.sceneEvents, [], 'a direct message fires no trigger');

  await say(world, toBot, 'Turn on the kitchen light');
  assert.deepEqual(world.fake.messages, [
    {
      contact_id: String(ALICE_ID),
      text: 'Turn on the kitchen light',
      created_at: new Date(START).toISOString(),
    },
  ]);

  // The answer of Gladys comes back as a direct message, Markdown as is.
  const ack = await world.fake.sendMessage(
    { id: String(ALICE_ID) },
    { text: 'It is **21 °C**', file: null },
  );
  assert.equal(ack.success, true);
  const answer = botMessages(world).at(-1);
  assert.deepEqual(recipients(answer), [ALICE_ID, BOT_ID]);
  assert.equal(answer.content, 'It is **21 °C**');
});

test('an account not linked yet gets the instructions; Gladys down gets an apology', async (t) => {
  const world = await connected(t);
  t.mock.method(world.gladys, 'publishMessage', async () => {
    throw new GladysApiError(404, 'NOT_FOUND', 'CONTACT_NOT_FOUND');
  });
  t.mock.method(world.gladys, 'linkContact', async () => {
    throw new GladysApiError(404, 'NOT_FOUND', 'INVALID_LINK_CODE');
  });
  await say(world, toBot, 'Hello');
  assert.match(botMessages(world)[0].content, /Generate a link code/);
  // A wrong code is a message like any other: the same instructions.
  await say(world, toBot, 'ZZZZ9999');
  assert.match(botMessages(world)[1].content, /Generate a link code/);

  world.gladys.publishMessage.mock.mockImplementation(async () => {
    throw new GladysApiError(500, 'SERVER_ERROR', 'down');
  });
  await say(world, toBot, 'Hello');
  assert.match(botMessages(world)[2].content, /try again later/);
});

test('a camera image of Gladys is uploaded, then linked in a direct message', async (t) => {
  const world = await connected(t);
  await world.fake.sendMessage(
    { id: String(ALICE_ID) },
    { text: 'Doorbell', file: 'image/jpg;base64,/9j/4AAQ' },
  );
  await settle();
  assert.deepEqual(world.server.uploads, [{ size: 6, type: 'image/jpeg', name: 'gladys.jpg' }]);
  const [text, image] = botMessages(world);
  assert.equal(text.content, 'Doorbell');
  assert.equal(image.content, '[gladys.jpg](/user_uploads/2/ab/xyz1/gladys.jpg)');
  assert.deepEqual(recipients(image), [ALICE_ID, BOT_ID]);
});

test('nothing goes out to a contact who is not, or no longer, an allowed person', async (t) => {
  const world = await connected(t);
  for (const id of [String(MALLORY_ID), 'alice', '']) {
    const ack = await world.fake.sendMessage({ id }, { text: 'secret', file: null });
    assert.equal(ack.success, true);
  }
  assert.deepEqual(botMessages(world), []);
});

test('scene action: a channel topic, a person, and a failure reported as outputs', async (t) => {
  const world = await connected(t, { config: { ...BASE_CONFIG, channels: '' } });
  let ack = await world.fake.sceneAction(SCENE_ACTION_KEY, {
    channel: '#Garage',
    topic: 'Alarm',
    message: 'Alarm _on_',
  });
  const [first] = botMessages(world);
  assert.deepEqual(ack.data.outputs, { sent: true, post_id: String(first.id), error: '' });
  assert.equal(first.stream_id, GARAGE);
  assert.equal(first.subject, 'Alarm');
  assert.equal(first.content, 'Alarm _on_');
  assert.equal(world.server.channels.get(GARAGE).members.has(BOT_ID), false, 'no join needed');

  await world.fake.sceneAction(SCENE_ACTION_KEY, { channel: 'garage', message: 'No topic' });
  assert.equal(botMessages(world).at(-1).subject, 'Gladys');

  for (const person of ['user8@zulip.test', '@user8@zulip.test', '@8']) {
    ack = await world.fake.sceneAction(SCENE_ACTION_KEY, { channel: person, message: 'Hi' });
    assert.equal(ack.data.outputs.sent, true, person);
    assert.deepEqual(recipients(botMessages(world).at(-1)), [ALICE_ID, BOT_ID]);
  }

  ack = await world.fake.sceneAction(SCENE_ACTION_KEY, { channel: 'nope', message: 'x' });
  assert.deepEqual(ack.data.outputs, {
    sent: false,
    post_id: '',
    error: 'channel or user not found on the server',
  });
  ack = await world.fake.sceneAction(SCENE_ACTION_KEY, { channel: 'ghost@x.org', message: 'x' });
  assert.equal(ack.data.outputs.error, 'channel or user not found on the server');
  ack = await world.fake.sceneAction(SCENE_ACTION_KEY, { channel: 'family', message: 'x' });
  assert.match(ack.data.outputs.error, /private channel without the bot/);
  world.server.rejectMessages = true;
  ack = await world.fake.sceneAction(SCENE_ACTION_KEY, { channel: 'garage', message: 'x' });
  assert.match(ack.data.outputs.error, /message too long/);
  assert.deepEqual(world.fake.sceneEvents, [], 'its own messages never fire a trigger');
});

test('connection lost after a minute of failures, restored once it answers again', async (t) => {
  const world = await connected(t);
  world.server.goDown();
  await settle();
  assert.equal(world.app.connection, 'connected', 'one cut is not a loss');
  let waited = 0;
  while (waited < LOST_AFTER_MS) {
    waited += await world.wake();
  }
  assert.equal(world.app.connection, 'disconnected');
  assert.deepEqual(world.fake.sceneEvents, [
    { key: TRIGGERS.LOST, data: { error: 'the Zulip server does not answer' } },
  ]);
  assert.equal(world.fake.connectionStatus.connected, false);

  world.server.down = null;
  await world.wake();
  assert.equal(world.app.connection, 'connected');
  assert.deepEqual(world.fake.sceneEvents.at(-1), {
    key: TRIGGERS.RESTORED,
    data: { user: 'gladys-bot@zulip.test' },
  });
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
  assert.equal(world.server.queues.size, 1, 'the same queue, still alive on the server');
});

test('a short cut keeps the queue: nothing is missed, nothing is replayed', async (t) => {
  const world = await connected(t);
  await say(world, toBot, 'first');
  world.server.goDown();
  await settle();
  world.server.down = null;
  world.clock.time += 1000;
  world.server.publish(ALICE_ID, GARAGE, '!door close'); // kept in the queue by the server
  await world.wake();
  assert.deepEqual(
    world.fake.sceneEvents.map((event) => event.key),
    [TRIGGERS.MESSAGE, TRIGGERS.COMMAND],
  );
  assert.equal(world.fake.messages.length, 1);
  assert.equal(world.server.requests.filter((r) => r.path === '/register').length, 1);
});

test('an expired queue is replaced at once, and what it missed is read back, once', async (t) => {
  const world = await connected(t);
  await say(world, toBot, 'first');
  world.clock.time += 10 * 60 * 1000; // 10 minutes without a poll (the container was frozen)
  world.server.expireQueues();
  world.clock.time += 1000;
  // Written while no queue existed: only the catch-up can see it.
  const missed = world.server.publish(ALICE_ID, GARAGE, '!door close');
  await settle();
  assert.equal(world.sleeps.length, 0, 'no wait before a new queue');
  assert.equal(world.server.queues.size, 1);
  assert.deepEqual(
    world.fake.sceneEvents.map((event) => event.data.text),
    [missed.content, missed.content],
  );
  assert.equal(world.fake.messages.length, 1, 'the direct message handled before is not replayed');
  assert.equal(world.app.connection, 'connected');
});

test('test action and widget button: the account, the channels, the people', async (t) => {
  const world = await connected(t);
  const report = await world.fake.action(ACTION_KEY, {});
  assert.equal(
    report.data.message.fr,
    'Connecté en tant que gladys-bot@zulip.test. Canaux surveillés : 1/1. Personnes autorisées trouvées : 1/1.',
  );
  const button = await world.fake.widgetAction(
    WIDGET_KEY,
    'test',
    {},
    { settings: {}, values: {} },
  );
  assert.match(button.data.message.en, /^Connected as gladys-bot@zulip\.test/);

  const empty = await createWorld({ config: {} });
  t.after(() => empty.app.stop());
  const failed = await empty.fake.action(ACTION_KEY, {});
  assert.match(failed.data.message.en, /^Connection failed: enter the address/);
});

test('parseCommand: prefix, word in lower case, the rest as arguments', () => {
  assert.deepEqual(parseCommand('!Lights off now', '!'), { command: 'lights', args: 'off now' });
  assert.deepEqual(parseCommand('!ping', '!'), { command: 'ping', args: '' });
  assert.equal(parseCommand('lights off', '!'), null);
  assert.equal(parseCommand('! lights', '!'), null);
});

test('two configurations saved in a row leave one queue polled, and stop() deletes it', async (t) => {
  const world = await connected(t);
  await Promise.all([
    world.fake.configUpdated({ ...BASE_CONFIG }),
    world.fake.configUpdated({ ...BASE_CONFIG, command_prefix: '?' }),
  ]);
  await settle();
  assert.equal(world.server.queues.size, 1, 'the old queues are deleted');
  assert.equal(world.app.config.command_prefix, '?');
  await world.app.stop();
  await settle();
  assert.equal(world.server.queues.size, 0);
});

test('a message of Gladys right after the start waits for the connection', async (t) => {
  const server = createFakeServer();
  const world = await createWorld({ server, config: {} });
  t.after(() => world.app.stop());
  const configured = world.fake.configUpdated(BASE_CONFIG);
  const ack = world.fake.sendMessage({ id: String(ALICE_ID) }, { text: 'Updated', file: null });
  await configured;
  assert.equal((await ack).success, true);
  assert.equal(botMessages(world)[0]?.content, 'Updated');
});

test('the scene data stays within 1000 characters', async (t) => {
  const world = await connected(t);
  await say(world, GARAGE, `!say ${'a'.repeat(3000)}`);
  for (const event of world.fake.sceneEvents) {
    for (const value of Object.values(event.data)) {
      assert.ok(value.length <= 1000);
    }
  }
});

test('a restart reads back what was missed, never what was already handled', async (t) => {
  const world = await connected(t);
  await say(world, GARAGE, '!door close');
  await say(world, toBot, 'first');
  await world.app.stop();
  world.clock.time += 1000;
  world.server.publish(ALICE_ID, GARAGE, '!door open'); // while stopped
  const again = await connected(t, { server: world.server, stored: world.store.data });
  assert.deepEqual(
    again.fake.sceneEvents.map((event) => event.data.text),
    ['!door open', '!door open'],
  );
  assert.deepEqual(again.fake.messages, [], 'the direct message handled before is not replayed');
});

test('another bot or server: the stored ids are forgotten', async (t) => {
  const world = await connected(t, {
    stored: { account: 'another', lastMessageId: 5000, seen: [1, 2] },
  });
  assert.notEqual(world.store.data.account, 'another');
  assert.equal(world.store.data.lastMessageId, -1);
});

test('a message of Gladys while Zulip is down is reported as not delivered', async (t) => {
  const server = createFakeServer();
  server.down = 'ECONNREFUSED';
  const world = await createWorld({ server });
  t.after(() => world.app.stop());
  const ack = await world.fake.sendMessage({ id: String(ALICE_ID) }, { text: 'Alarm', file: null });
  assert.equal(ack.success, false);
});

test('a channel not watched never fires a trigger', async (t) => {
  const server = createFakeServer();
  server.channels.get(FAMILY).members.add(BOT_ID);
  const world = await connected(t, { server });
  await say(world, FAMILY, '!heating off');
  assert.deepEqual(world.fake.sceneEvents, []);
});

test('a queue lost as soon as it opens is a failure with a wait, declared lost after a minute', async (t) => {
  const world = await connected(t);
  world.server.dropNewQueues = true;
  world.server.expireQueues();
  await settle();
  assert.equal(world.sleeps.length, 1, 'a wait, not a busy loop');
  let waited = 0;
  while (waited < LOST_AFTER_MS) {
    waited += await world.wake();
  }
  assert.equal(world.app.connection, 'disconnected');
  assert.equal(world.fake.sceneEvents.at(-1).key, TRIGGERS.LOST);
});

test('the catch-up reads the direct messages and the watched channels, not busy others', async (t) => {
  const server = createFakeServer();
  server.channels.get(FAMILY).members.add(BOT_ID); // subscribed, not watched
  const world = await connected(t, { server });
  await world.app.stop();
  world.clock.time += 1000;
  world.server.publish(ALICE_ID, GARAGE, '!door open');
  world.server.publish(ALICE_ID, toBot, 'missed');
  for (let i = 0; i < 150; i += 1) {
    world.server.publish(MALLORY_ID, FAMILY, `chatter ${i}`);
  }
  const again = await connected(t, { server, stored: world.store.data });
  assert.deepEqual(
    again.fake.sceneEvents.map((event) => event.data.text),
    ['!door open', '!door open'],
  );
  assert.deepEqual(
    again.fake.messages.map((m) => m.text),
    ['missed'],
  );
});

test('a channel named with digits is sent by name, never taken for an id', async (t) => {
  const server = createFakeServer();
  server.channels.set(2024, { id: 2024, name: '2024', private: false, members: new Set() });
  const world = await connected(t, { server });
  const ack = await world.fake.sceneAction(SCENE_ACTION_KEY, { channel: '2024', message: 'x' });
  assert.equal(ack.data.outputs.sent, true);
  assert.equal(botMessages(world).at(-1).stream_id, 2024);
});

test('a configuration saved while Zulip is down still fires connection_lost', async (t) => {
  const world = await connected(t);
  world.server.goDown();
  await settle();
  await world.fake.configUpdated({ ...BASE_CONFIG, command_prefix: '?' });
  await settle();
  assert.equal(world.app.connection, 'connected', 'still connected until the loss is declared');
  let waited = 0;
  while (waited < LOST_AFTER_MS) {
    waited += await world.wake();
  }
  assert.deepEqual(
    world.fake.sceneEvents.map((event) => event.key),
    [TRIGGERS.LOST],
  );
});
