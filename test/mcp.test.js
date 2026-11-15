import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  buildMcpServer,
  sendDiscordMessage,
  getRecentMessages,
} from '../src/bridge/mcp.js';
import { parseChannelIds } from '../src/bridge/channel-ids.js';

const C1 = '111111111111111111';
const C9 = '999999999999999999';
const T1 = '222222222222222222';
const T2 = '333333333333333333';
const OTHER = '444444444444444444';
const BAD_ID = '123/../../guilds/1';

function makeLogger() {
  const lines = [];
  const push = (...a) => lines.push(a.map(String).join(' '));
  return { lines, log: push, info: push, warn: push, error: push };
}

function makeMessage(i, over = {}) {
  return {
    id: `m${i}`,
    author: { id: `u${i}`, username: `user${i}`, bot: false },
    content: `content ${i}`,
    createdAt: new Date(1_700_000_000_000 + i * 1000),
    createdTimestamp: 1_700_000_000_000 + i * 1000,
    url: `https://discord.com/channels/g/c/m${i}`,
    attachments: new Map(),
    ...over,
  };
}

function makeChannel(over = {}) {
  const sent = [];
  const fetchCalls = [];
  return {
    id: C1,
    sent,
    fetchCalls,
    isTextBased: () => true,
    isThread: () => false,
    send: async (m) => {
      sent.push(m);
      return { id: 'sent1', url: 'https://discord.com/channels/g/c/sent1' };
    },
    messages: {
      fetch: async (opts) => {
        fetchCalls.push(opts);
        return new Map([1, 3, 2].map((i) => [`m${i}`, makeMessage(i)]));
      },
    },
    ...over,
  };
}

function makeClient(channel, { ready = true, fetchImpl } = {}) {
  return {
    isReady: () => ready,
    channels: { fetch: fetchImpl ?? (async () => channel) },
  };
}

async function connect({ client, env = { CHANNEL_IDS: C1 }, logger = makeLogger() }) {
  const server = buildMcpServer({ client, env, logger });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return { mcp, logger, close: () => mcp.close() };
}

const parse = (res) => JSON.parse(res.content[0].text);
const send = (mcp, args) => mcp.callTool({ name: 'send_discord_message', arguments: args });
const read = (mcp, args) => mcp.callTool({ name: 'get_recent_messages', arguments: args });
const boom = (msg = 'boom', code) => async () => {
  throw Object.assign(new Error(msg), code ? { code } : {});
};

test('S16 parseChannelIds splits, trims and drops empties', () => {
  assert.deepEqual([...parseChannelIds(' a, b ,,c,')], ['a', 'b', 'c']);
  assert.equal(parseChannelIds(undefined).size, 0);
  assert.ok(parseChannelIds('a') instanceof Set);
});

test('S4 tools/list has exactly the two tools with input schemas', async () => {
  const { mcp, close } = await connect({ client: makeClient(makeChannel()) });
  const { tools } = await mcp.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['get_recent_messages', 'send_discord_message']);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(
    Object.keys(byName.send_discord_message.inputSchema.properties).sort(),
    ['channelId', 'message'],
  );
  assert.deepEqual(
    Object.keys(byName.get_recent_messages.inputSchema.properties).sort(),
    ['channelId', 'limit'],
  );
  await close();
});

test('S19 descriptions carry usage guidance', async () => {
  const { mcp, close } = await connect({ client: makeClient(makeChannel()) });
  const { tools } = await mcp.listTools();
  const s = JSON.stringify(tools.find((t) => t.name === 'send_discord_message'));
  const g = JSON.stringify(tools.find((t) => t.name === 'get_recent_messages'));
  assert.match(s, /2000/);
  assert.match(s, /<@/);
  assert.match(g, /newest first/);
  assert.match(g, /1[–-]100/);
  await close();
});

test('S5 send posts with allowedMentions and returns messageId/url', async () => {
  const channel = makeChannel();
  const { mcp, close } = await connect({ client: makeClient(channel) });
  const res = await send(mcp, { channelId: C9, message: 'hello' });
  assert.ok(!res.isError);
  assert.deepEqual(channel.sent, [{ content: 'hello', allowedMentions: { parse: ['users'] } }]);
  assert.deepEqual(parse(res), { messageId: 'sent1', url: 'https://discord.com/channels/g/c/sent1' });
  await close();
});

test('send to a channel that is not watched is channel_not_allowed and sends nothing', async () => {
  const channel = makeChannel({ id: OTHER });
  const res = await sendDiscordMessage(
    { channelId: OTHER, message: 'hi' },
    { client: makeClient(channel), env: { CHANNEL_IDS: C1 }, logger: makeLogger() },
  );
  assert.equal(res.isError, true);
  assert.equal(parse(res).code, 'channel_not_allowed');
  const { mcp, close } = await connect({ client: makeClient(channel) });
  const over = await send(mcp, { channelId: OTHER, message: 'hi' });
  assert.equal(parse(over).code, 'channel_not_allowed');
  await close();
  assert.equal(channel.sent.length, 0);
});

test('send with CHANNEL_IDS unset is channel_not_allowed', async () => {
  const channel = makeChannel();
  const res = await sendDiscordMessage(
    { channelId: C1, message: 'hi' },
    { client: makeClient(channel), env: {}, logger: makeLogger() },
  );
  assert.equal(parse(res).code, 'channel_not_allowed');
  assert.equal(channel.sent.length, 0);
});

test('send to a thread under a watched channel is allowed', async () => {
  const thread = makeChannel({ id: T1, isThread: () => true, parentId: C1 });
  const { mcp, close } = await connect({ client: makeClient(thread) });
  const res = await send(mcp, { channelId: T1, message: 'hi' });
  assert.ok(!res.isError);
  assert.equal(thread.sent.length, 1);
  await close();
});

test('S6 invalid send input returns invalid_input and sends nothing', async () => {
  const channel = makeChannel();
  const deps = { client: makeClient(channel), env: {}, logger: makeLogger() };
  for (const args of [
    { channelId: C1, message: '' },
    { channelId: C1, message: 'x'.repeat(2001) },
    { channelId: '', message: 'hi' },
    { message: 'hi' },
  ]) {
    const res = await sendDiscordMessage(args, deps);
    assert.equal(res.isError, true);
    assert.equal(parse(res).code, 'invalid_input');
  }
  assert.equal(channel.sent.length, 0);
});

test('S6 invalid input over MCP is an invalid_input error result and nothing is sent', async () => {
  const channel = makeChannel();
  const { mcp, close } = await connect({ client: makeClient(channel) });
  for (const args of [
    { channelId: C1, message: '' },
    { channelId: C1, message: 'x'.repeat(2001) },
    { channelId: '', message: 'hi' },
  ]) {
    const res = await send(mcp, args);
    assert.equal(res.isError, true);
    assert.equal(parse(res).code, 'invalid_input');
  }
  assert.equal(channel.sent.length, 0);
  await close();
});

test('channelId that is not a snowflake is invalid_input and never fetched (send)', async () => {
  const channel = makeChannel();
  const fetched = [];
  const client = makeClient(channel, { fetchImpl: async (id) => { fetched.push(id); return channel; } });
  const res = await sendDiscordMessage({ channelId: BAD_ID, message: 'hi' }, { client, env: {}, logger: makeLogger() });
  assert.equal(res.isError, true);
  assert.equal(parse(res).code, 'invalid_input');
  const { mcp, close } = await connect({ client });
  const over = await send(mcp, { channelId: BAD_ID, message: 'hi' });
  assert.equal(over.isError, true);
  assert.equal(parse(over).code, 'invalid_input');
  await close();
  assert.deepEqual(fetched, []);
  assert.equal(channel.sent.length, 0);
});

test('channelId that is not a snowflake is invalid_input and never fetched (read)', async () => {
  const channel = makeChannel();
  const fetched = [];
  const client = makeClient(channel, { fetchImpl: async (id) => { fetched.push(id); return channel; } });
  const res = await getRecentMessages({ channelId: BAD_ID }, { client, env: { CHANNEL_IDS: C1 }, logger: makeLogger() });
  assert.equal(res.isError, true);
  assert.equal(parse(res).code, 'invalid_input');
  const { mcp, close } = await connect({ client });
  const over = await read(mcp, { channelId: BAD_ID });
  assert.equal(over.isError, true);
  assert.equal(parse(over).code, 'invalid_input');
  await close();
  assert.deepEqual(fetched, []);
});

test('not_ready read returns not_ready and fetches nothing', async () => {
  const channel = makeChannel();
  const { mcp, close } = await connect({ client: makeClient(channel, { ready: false }) });
  const res = await read(mcp, { channelId: C1 });
  assert.equal(res.isError, true);
  assert.equal(parse(res).code, 'not_ready');
  assert.equal(channel.fetchCalls.length, 0);
  await close();
});

test('S7 + S18 send failure codes with { code, message } and no content echo', async () => {
  const secret = 'SECRET-BODY-TEXT';
  const cases = [
    ['channel_not_found', makeClient(null)],
    ['channel_not_found', makeClient(null, { fetchImpl: boom('nope') })],
    ['channel_not_sendable', makeClient(makeChannel({ isTextBased: () => false }))],
    ['channel_not_sendable', makeClient(makeChannel({ send: undefined }))],
    ['discord_error', makeClient(makeChannel({ send: boom() }))],
    ['not_ready', makeClient(makeChannel(), { ready: false })],
  ];
  for (const [code, client] of cases) {
    const { mcp, close } = await connect({ client });
    const res = await send(mcp, { channelId: C1, message: secret });
    assert.equal(res.isError, true, code);
    const body = parse(res);
    assert.deepEqual(Object.keys(body).sort(), ['code', 'message']);
    assert.equal(body.code, code);
    assert.equal(typeof body.message, 'string');
    assert.ok(!body.message.includes(secret));
    assert.ok(!body.message.includes('\n'));
    await close();
  }
});

test('S21 permission errors map to missing_permission for send and read', async () => {
  for (const code of [50001, 50013]) {
    let c = await connect({ client: makeClient(makeChannel({ send: boom('Missing Access', code) })) });
    assert.equal(parse(await send(c.mcp, { channelId: C1, message: 'hi' })).code, 'missing_permission');
    await c.close();

    const readCh = makeChannel({ messages: { fetch: boom('Missing Access', code) } });
    c = await connect({ client: makeClient(readCh) });
    assert.equal(parse(await read(c.mcp, { channelId: C1 })).code, 'missing_permission');
    await c.close();
  }
});

test('S8 + S20 read fetches limit 20 and returns newest first with full shape', async () => {
  const channel = makeChannel();
  channel.messages.fetch = async (opts) => {
    channel.fetchCalls.push(opts);
    return new Map([
      ['m1', makeMessage(1)],
      [
        'm3',
        makeMessage(3, {
          attachments: new Map([['a', { url: 'https://x/a.png', name: 'a.png' }]]),
          author: { id: 'b', username: 'bot', bot: true },
        }),
      ],
      ['m2', makeMessage(2)],
    ]);
  };
  const { mcp, close } = await connect({ client: makeClient(channel) });
  const res = await read(mcp, { channelId: C1 });
  assert.ok(!res.isError);
  assert.deepEqual(channel.fetchCalls, [{ limit: 20 }]);
  const items = parse(res);
  assert.deepEqual(items.map((m) => m.id), ['m3', 'm2', 'm1']);
  assert.deepEqual(items[0], {
    id: 'm3',
    authorId: 'b',
    authorUsername: 'bot',
    authorIsBot: true,
    content: 'content 3',
    createdAt: new Date(1_700_000_003_000).toISOString(),
    url: 'https://discord.com/channels/g/c/m3',
    attachments: [{ url: 'https://x/a.png', name: 'a.png' }],
  });
  assert.deepEqual(items[1].attachments, []);
  await close();
});

test('S9 limit 5 and 100 pass through; 0, 101, 1.5 are errors without fetching', async () => {
  const channel = makeChannel();
  const { mcp, close } = await connect({ client: makeClient(channel) });
  await read(mcp, { channelId: C1, limit: 5 });
  await read(mcp, { channelId: C1, limit: 100 });
  assert.deepEqual(channel.fetchCalls, [{ limit: 5 }, { limit: 100 }]);
  const deps = { client: makeClient(channel), env: { CHANNEL_IDS: C1 }, logger: makeLogger() };
  for (const limit of [0, 101, 1.5]) {
    const res = await getRecentMessages({ channelId: C1, limit }, deps);
    assert.equal(res.isError, true);
    assert.equal(parse(res).code, 'invalid_input');
  }
  assert.equal(channel.fetchCalls.length, 2);
  for (const limit of [0, 101, 1.5]) {
    const res = await read(mcp, { channelId: C1, limit });
    assert.equal(res.isError, true);
    assert.equal(parse(res).code, 'invalid_input');
  }
  assert.equal(channel.fetchCalls.length, 2);
  await close();
});

test('S10 thread under a watched channel is readable', async () => {
  const channel = makeChannel({ id: T1, isThread: () => true, parentId: C1 });
  const { mcp, close } = await connect({ client: makeClient(channel) });
  const res = await read(mcp, { channelId: T1 });
  assert.ok(!res.isError);
  assert.equal(parse(res).length, 3);
  await close();
});

test('S11 unwatched channel is channel_not_allowed and nothing is fetched', async () => {
  for (const channel of [
    makeChannel({ id: OTHER }),
    makeChannel({ id: T2, isThread: () => true, parentId: OTHER }),
  ]) {
    const { mcp, close } = await connect({ client: makeClient(channel) });
    const res = await read(mcp, { channelId: channel.id });
    assert.equal(res.isError, true);
    assert.equal(parse(res).code, 'channel_not_allowed');
    assert.equal(channel.fetchCalls.length, 0);
    await close();
  }
});

test('S12 read failure codes', async () => {
  const cases = [
    ['channel_not_found', makeClient(null)],
    ['channel_not_found', makeClient(null, { fetchImpl: boom('x') })],
    ['channel_not_readable', makeClient(makeChannel({ messages: undefined }))],
    ['discord_error', makeClient(makeChannel({ messages: { fetch: boom() } }))],
  ];
  for (const [code, client] of cases) {
    const { mcp, close } = await connect({ client });
    const res = await read(mcp, { channelId: C1 });
    assert.equal(res.isError, true, code);
    assert.equal(parse(res).code, code);
    await close();
  }
});

test('S15 logs never contain message content', async () => {
  const logger = makeLogger();
  const channel = makeChannel({ send: boom('discord said no') });
  const { mcp, close } = await connect({ client: makeClient(channel), logger });
  await send(mcp, { channelId: C1, message: 'TOP-SECRET-CONTENT' });
  assert.ok(logger.lines.length > 0);
  assert.ok(!logger.lines.join('\n').includes('TOP-SECRET-CONTENT'));
  await close();
});
