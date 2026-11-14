import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp, startServer, resolvePort } from '../src/bridge/server.js';

function makeLogger() {
  const lines = [];
  const push = (...a) => lines.push(a.map(String).join(' '));
  return { lines, log: push, info: push, warn: push, error: push };
}

function makeChannel(over = {}) {
  const sent = [];
  return {
    sent,
    isTextBased: () => true,
    send: async (m) => {
      sent.push(m);
      return { id: '123' };
    },
    ...over,
  };
}

function makeClient(channel, { ready = true, fetchImpl } = {}) {
  const fetched = [];
  return {
    fetched,
    isReady: () => ready,
    channels: {
      fetch:
        fetchImpl ??
        (async (id) => {
          fetched.push(id);
          return channel;
        }),
    },
  };
}

const servers = [];
async function boot({ client, env = { SEND_API_SECRET: 'topsecret' }, logger = makeLogger() } = {}) {
  const app = createApp({ client, env, logger });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  servers.push(server);
  return { base: `http://127.0.0.1:${server.address().port}`, logger };
}
after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

const post = (base, body, headers = { authorization: 'Bearer topsecret' }, raw) =>
  fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: raw ?? JSON.stringify(body),
  });

test('S3 GET /health returns 200 without auth', async () => {
  const { base } = await boot({ client: makeClient(makeChannel()) });
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('S2 startServer serves /health on PORT and is idempotent', async () => {
  const client = makeClient(makeChannel());
  const logger = makeLogger();
  const a = startServer({ client, env: { PORT: '0' }, logger });
  const b = startServer({ client, env: { PORT: '0' }, logger });
  servers.push(a);
  assert.equal(a, b);
  if (!a.listening) await new Promise((r) => a.once('listening', r));
  const res = await fetch(`http://127.0.0.1:${a.address().port}/health`);
  assert.equal(res.status, 200);
});

test('S2 PORT unset resolves to 3000 without binding it', () => {
  assert.equal(resolvePort({}), 3000);
  assert.equal(resolvePort({ PORT: '8080' }), 8080);
});

test('S4 one log line per request with method, path, status, duration; no secret', async () => {
  const { base, logger } = await boot({ client: makeClient(makeChannel()) });
  await fetch(`${base}/health`);
  await post(base, {}, { authorization: 'Bearer wrong' });
  await fetch(`${base}/nope?token=topsecret`);
  await post(base, {}, { authorization: 'Bearer topsecret' });
  assert.equal(logger.lines.length, 4);
  assert.match(logger.lines[0], /^\[http\] GET \/health 200 \d+ms$/);
  assert.match(logger.lines[1], /^\[http\] POST \/send 401 \d+ms$/);
  assert.match(logger.lines[2], /^\[http\] GET \/nope 404 \d+ms$/);
  assert.ok(!logger.lines.join('\n').includes('topsecret'));
});

test('S12 S21 valid request sends once with allowedMentions and returns id', async () => {
  const channel = makeChannel();
  const { base } = await boot({ client: makeClient(channel) });
  const res = await post(base, { channelId: 'c1', message: 'hi' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: '123' });
  assert.deepEqual(channel.sent, [{ content: 'hi', allowedMentions: { parse: ['users'] } }]);
});

for (const [name, headers] of [
  ['missing header', {}],
  ['non-Bearer scheme', { authorization: 'Basic topsecret' }],
  ['wrong token', { authorization: 'Bearer nope' }],
]) {
  test(`S13 ${name} -> 401, no send`, async () => {
    const channel = makeChannel();
    const { base } = await boot({ client: makeClient(channel) });
    const res = await post(base, { channelId: 'c1', message: 'hi' }, headers);
    assert.equal(res.status, 401);
    assert.ok((await res.json()).error);
    assert.equal(channel.sent.length, 0);
  });
}

for (const secret of [undefined, '']) {
  test(`S14 SEND_API_SECRET ${JSON.stringify(secret)} -> 503, no send`, async () => {
    const channel = makeChannel();
    const { base } = await boot({ client: makeClient(channel), env: { SEND_API_SECRET: secret } });
    const res = await post(base, { channelId: 'c1', message: 'hi' }, { authorization: 'Bearer x' });
    assert.equal(res.status, 503);
    assert.ok((await res.json()).error);
    assert.equal(channel.sent.length, 0);
  });
}

for (const [name, body, raw] of [
  ['missing channelId', { message: 'hi' }],
  ['empty channelId', { channelId: '', message: 'hi' }],
  ['non-string channelId', { channelId: 5, message: 'hi' }],
  ['missing message', { channelId: 'c1' }],
  ['empty message', { channelId: 'c1', message: '' }],
  ['non-string message', { channelId: 'c1', message: 5 }],
  ['malformed JSON', undefined, '{bad'],
]) {
  test(`S15 ${name} -> 400 invalid_body, no send`, async () => {
    const channel = makeChannel();
    const { base } = await boot({ client: makeClient(channel) });
    const res = await post(base, body, undefined, raw);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid_body' });
    assert.equal(channel.sent.length, 0);
  });
}

test('S22 2001-char message -> 400 message_too_long; 2000 accepted', async () => {
  const channel = makeChannel();
  const { base } = await boot({ client: makeClient(channel) });
  const long = await post(base, { channelId: 'c1', message: 'a'.repeat(2001) });
  assert.equal(long.status, 400);
  assert.deepEqual(await long.json(), { error: 'message_too_long' });
  const ok = await post(base, { channelId: 'c1', message: 'a'.repeat(2000) });
  assert.equal(ok.status, 200);
  assert.equal(channel.sent.length, 1);
});

test('S16 channels.fetch rejects -> 404', async () => {
  const client = makeClient(null, {
    fetchImpl: async () => {
      throw new Error('Unknown Channel');
    },
  });
  const { base } = await boot({ client });
  const res = await post(base, { channelId: 'c1', message: 'hi' });
  assert.equal(res.status, 404);
});

test('S16 channels.fetch resolves null -> 404', async () => {
  const { base } = await boot({ client: makeClient(null) });
  const res = await post(base, { channelId: 'c1', message: 'hi' });
  assert.equal(res.status, 404);
});

for (const [name, over] of [
  ['isTextBased false', { isTextBased: () => false }],
  ['no send', { send: undefined }],
]) {
  test(`S17 ${name} -> 422, no send`, async () => {
    const channel = makeChannel(over);
    const { base } = await boot({ client: makeClient(channel) });
    const res = await post(base, { channelId: 'c1', message: 'hi' });
    assert.equal(res.status, 422);
    assert.equal(channel.sent.length, 0);
  });
}

test('S18 channel.send rejects -> 502, error logged (message only)', async () => {
  const channel = makeChannel({
    send: async () => {
      throw new Error('Missing Permissions');
    },
  });
  const { base, logger } = await boot({ client: makeClient(channel) });
  const res = await post(base, { channelId: 'c1', message: 'hi' });
  assert.equal(res.status, 502);
  assert.ok((await res.json()).error);
  const errLine = logger.lines.find((l) => l.includes('Missing Permissions'));
  assert.ok(errLine);
  assert.ok(!errLine.includes('topsecret'));
});

test('Task-only: client not ready -> 503, no fetch/send', async () => {
  const channel = makeChannel();
  const client = makeClient(channel, { ready: false });
  const { base } = await boot({ client });
  const res = await post(base, { channelId: 'c1', message: 'hi' });
  assert.equal(res.status, 503);
  assert.deepEqual(client.fetched, []);
  assert.equal(channel.sent.length, 0);
});
