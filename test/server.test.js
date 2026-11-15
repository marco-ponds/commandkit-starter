import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp, startServer, resolvePort } from '../src/bridge/server.js';

const C1 = '111111111111111111';

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
after(() =>
  Promise.all(
    servers.map((s) =>
      new Promise((r) => {
        s.close(r);
        s.closeAllConnections?.();
      }),
    ),
  ),
);

const AUTH = { authorization: 'Bearer topsecret' };
const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};
const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 't', version: '0' },
  },
};

const postMcp = (base, headers = AUTH, body = INIT) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...headers },
    body: JSON.stringify(body),
  });

async function withClient(base, fn) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer topsecret' } },
  });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test('S1 GET /health returns 200 without auth', async () => {
  const { base } = await boot({ client: makeClient(makeChannel()) });
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('startServer serves /health on PORT and is idempotent', async () => {
  const client = makeClient(makeChannel());
  const logger = makeLogger();
  const a = startServer({ client, env: { PORT: '0' }, logger });
  const b = startServer({ client, env: { PORT: '0' }, logger });
  servers.push(a);
  assert.equal(a, b);
  if (!a.listening) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('listen timeout')), 5000);
      a.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      a.once('listening', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  const port = a.address().port;
  assert.notEqual(port, 3000);
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
});

test('PORT unset resolves to 3000 without binding it', () => {
  assert.equal(resolvePort({}), 3000);
  assert.equal(resolvePort({ PORT: '' }), 3000);
  assert.equal(resolvePort({ PORT: '0' }), 0);
  assert.equal(resolvePort({ PORT: '4567' }), 4567);
});

test('S2 no/wrong bearer -> 401 and handler not invoked; lowercase bearer accepted', async () => {
  const channel = makeChannel();
  const client = makeClient(channel);
  const { base } = await boot({ client });
  for (const headers of [{}, { authorization: 'Basic topsecret' }, { authorization: 'Bearer nope' }]) {
    const res = await postMcp(base, headers);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(body.error);
    assert.equal(body.jsonrpc, undefined);
    assert.equal(body.result, undefined);
  }
  assert.deepEqual(client.fetched, []);
  assert.equal(channel.sent.length, 0);
  const ok = await postMcp(base, { authorization: 'bearer topsecret' });
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).result.serverInfo);
});

for (const secret of [undefined, '']) {
  test(`S3 SEND_API_SECRET ${JSON.stringify(secret)} -> POST /mcp 503 for any headers`, async () => {
    const { base } = await boot({ client: makeClient(makeChannel()), env: { SEND_API_SECRET: secret } });
    for (const headers of [AUTH, {}, { authorization: 'Bearer x' }]) {
      const res = await postMcp(base, headers);
      assert.equal(res.status, 503);
      assert.ok((await res.json()).error);
    }
  });
}

test('S4 SDK client initialize + listTools lists exactly the two tools with input schemas', async () => {
  const { base } = await boot({ client: makeClient(makeChannel()) });
  await withClient(base, async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['get_recent_messages', 'send_discord_message']);
    for (const t of tools) {
      assert.equal(t.inputSchema.type, 'object');
      assert.ok('channelId' in t.inputSchema.properties);
    }
  });
});

test('S5 S7 callTool send_discord_message sends once via the fake client', async () => {
  const channel = makeChannel();
  const { base } = await boot({ client: makeClient(channel) });
  await withClient(base, async (client) => {
    const res = await client.callTool({
      name: 'send_discord_message',
      arguments: { channelId: C1, message: 'hello ember' },
    });
    assert.ok(!res.isError);
  });
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, 'hello ember');
  assert.deepEqual(channel.sent[0].allowedMentions, { parse: ['users'] });
});

test('S18 failing tool call -> isError with {code, message} text over HTTP 200', async () => {
  const { base } = await boot({ client: makeClient(null) });
  const res = await postMcp(base, AUTH, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'send_discord_message', arguments: { channelId: C1, message: 'hi' } },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.result.isError, true);
  const err = JSON.parse(body.result.content[0].text);
  assert.equal(err.code, 'channel_not_found');
  assert.equal(typeof err.message, 'string');
});

test('stateless: two sequential clients work independently', async () => {
  const channel = makeChannel();
  const { base } = await boot({ client: makeClient(channel) });
  for (const message of ['one', 'two']) {
    await withClient(base, async (client) => {
      const res = await client.callTool({
        name: 'send_discord_message',
        arguments: { channelId: C1, message },
      });
      assert.ok(!res.isError);
    });
  }
  assert.deepEqual(
    channel.sent.map((m) => m.content),
    ['one', 'two'],
  );
});

for (const method of ['GET', 'DELETE']) {
  test(`S13 ${method} /mcp -> 405 JSON-RPC error + Allow: POST; 401 without bearer; 503 secret unset`, async () => {
    const { base } = await boot({ client: makeClient(makeChannel()) });
    const res = await fetch(`${base}/mcp`, { method, headers: AUTH });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
    const body = await res.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.ok(body.error);
    assert.equal(body.id, null);
    assert.equal((await fetch(`${base}/mcp`, { method })).status, 401);
    const off = await boot({ client: makeClient(makeChannel()), env: {} });
    assert.equal((await fetch(`${off.base}/mcp`, { method, headers: AUTH })).status, 503);
  });
}

test('S14 POST /send -> 404', async () => {
  const channel = makeChannel();
  const { base } = await boot({ client: makeClient(channel) });
  const res = await fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify({ channelId: C1, message: 'hi' }),
  });
  assert.equal(res.status, 404);
  assert.equal(channel.sent.length, 0);
});

test('malformed JSON on /mcp -> 400 invalid_body (error handler kept)', async () => {
  const { base } = await boot({ client: makeClient(makeChannel()) });
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...AUTH },
    body: '{bad',
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'invalid_body' });
});

test('S15 /mcp log line format; logs never contain secret, Authorization value or message text', async () => {
  const channel = makeChannel();
  const { base, logger } = await boot({ client: makeClient(channel) });
  await (await postMcp(base, { authorization: 'Bearer wrong' })).text();
  await withClient(base, (client) =>
    client.callTool({
      name: 'send_discord_message',
      arguments: { channelId: C1, message: 'super-private-text' },
    }),
  );
  const nope = await fetch(`${base}/nope?token=topsecret`);
  await nope.text();
  await new Promise((r) => setImmediate(r));
  const mcpLines = logger.lines.filter((l) => l.startsWith('[http] POST /mcp'));
  assert.ok(mcpLines.length >= 2);
  for (const l of mcpLines) assert.match(l, /^\[http\] POST \/mcp \d{3} \d+ms$/);
  assert.match(mcpLines[0], /^\[http\] POST \/mcp 401 /);
  assert.ok(logger.lines.some((l) => /^\[http\] GET \/nope 404 \d+ms$/.test(l)));
  const all = logger.lines.join('\n');
  for (const needle of ['topsecret', 'Bearer', 'super-private-text']) {
    assert.ok(!all.includes(needle), `logs leaked ${needle}`);
  }
});
