import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmberForwarder } from '../src/bridge/ember.js';

const URL_ = 'https://ember.example/hook';
const SECRET = 'super-secret-value';
const env = {
    EMBER_WEBHOOK_URL: URL_,
    EMBER_WEBHOOK_SECRET: SECRET,
    CHANNEL_IDS: 'help1,bug1',
};

function setup(envOverride = env, fetchImpl) {
    const calls = [];
    const logs = { info: [], warn: [], error: [] };
    const logger = {
        info: (...a) => logs.info.push(a.join(' ')),
        warn: (...a) => logs.warn.push(a.join(' ')),
        error: (...a) => logs.error.push(a.join(' ')),
    };
    const fetch = async (url, init) => {
        calls.push({ url, init });
        return fetchImpl ? fetchImpl(url, init) : { ok: true, status: 200 };
    };
    const forward = createEmberForwarder({ fetch, env: envOverride, logger });
    return { forward, calls, logs };
}

function msg(overrides = {}) {
    const typing = { count: 0 };
    const m = {
        id: 'm1',
        content: 'hello',
        url: 'https://discord.com/channels/g/help1/m1',
        createdAt: new Date('2026-01-02T03:04:05.000Z'),
        author: { id: 'u1', username: 'alice', bot: false },
        guildId: 'g1',
        channel: {
            id: 'help1',
            name: 'help',
            parentId: null,
            isThread: () => false,
            sendTyping: async () => {
                typing.count++;
            },
        },
        ...overrides,
    };
    m.typing = typing;
    return m;
}

function all(logs) {
    return [...logs.info, ...logs.warn, ...logs.error].join('\n');
}

const KEYS = [
    'authorId', 'authorUsername', 'channelId', 'channelName',
    'content', 'createdAt', 'guildId', 'messageId', 'url',
];

async function checkForward(channelId, channelName) {
    const { forward, calls } = setup();
    const m = msg();
    m.channel.id = channelId;
    m.channel.name = channelName;
    await forward(m);
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, URL_);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.headers.Authorization, `Bearer ${SECRET}`);
    const body = JSON.parse(init.body);
    assert.deepStrictEqual(Object.keys(body).sort(), KEYS);
    assert.deepStrictEqual(body, {
        messageId: 'm1', content: 'hello', authorId: 'u1', authorUsername: 'alice',
        channelId, channelName, guildId: 'g1',
        url: 'https://discord.com/channels/g/help1/m1',
        createdAt: '2026-01-02T03:04:05.000Z',
    });
}

test('S5 help channel message is POSTed to Ember with auth and exact body', () =>
    checkForward('help1', 'help'));

test('S6 bug-report channel message is POSTed to Ember', () =>
    checkForward('bug1', 'bugs'));

test('S7 thread under help or bug-report parent forwards with thread id/name', async () => {
    for (const parentId of ['help1', 'bug1']) {
        const { forward, calls } = setup();
        const m = msg();
        m.channel = { ...m.channel, id: 't9', name: 'my thread', parentId, isThread: () => true };
        await forward(m);
        assert.equal(calls.length, 1);
        const body = JSON.parse(calls[0].init.body);
        assert.equal(body.channelId, 't9');
        assert.equal(body.channelName, 'my thread');
    }
});

test('S8 bot-authored message is not forwarded', async () => {
    const { forward, calls } = setup();
    await forward(msg({ author: { id: 'b', username: 'bot', bot: true } }));
    assert.equal(calls.length, 0);
});

test('S9 unrelated channel and thread under unrelated parent are not forwarded', async () => {
    const { forward, calls } = setup();
    const a = msg();
    a.channel = { ...a.channel, id: 'other' };
    await forward(a);
    const b = msg();
    b.channel = { ...b.channel, id: 't1', parentId: 'other', isThread: () => true };
    await forward(b);
    assert.equal(calls.length, 0);
});

test('S9 unset channel ids never match an empty channel id', async () => {
    const { forward, calls } = setup({ EMBER_WEBHOOK_URL: URL_, EMBER_WEBHOOK_SECRET: SECRET, CHANNEL_IDS: '' });
    const m = msg();
    m.channel = { ...m.channel, id: '', parentId: undefined };
    await forward(m);
    assert.equal(calls.length, 0);
});

test('S10 non-2xx logs one line with messageId and status, resolves, later message forwards', async () => {
    let n = 0;
    const { forward, calls, logs } = setup(env, async () => (++n === 1 ? { ok: false, status: 500 } : { ok: true, status: 200 }));
    const m = msg();
    await forward(m);
    assert.deepEqual([...logs.error, ...logs.warn, ...logs.info], ['[ember] forward failed messageId=m1 status=500']);
    assert.equal(m.typing.count, 0);
    await forward(msg({ id: 'm2' }));
    assert.equal(calls.length, 2);
});

test('S10 network rejection logs one line with messageId and error, resolves', async () => {
    const { forward, logs } = setup(env, async () => {
        throw new Error('ECONNREFUSED');
    });
    await forward(msg());
    assert.deepEqual([...logs.error, ...logs.warn, ...logs.info], ['[ember] forward failed messageId=m1 error=ECONNREFUSED']);
});

test('S10 fetch gets an AbortSignal and a timeout abort is logged, not thrown', async () => {
    const { forward, calls, logs } = setup(env, async (_u, init) => {
        assert.ok(init.signal instanceof AbortSignal);
        const e = new Error('The operation was aborted due to timeout');
        e.name = 'TimeoutError';
        throw e;
    });
    await forward(msg());
    assert.equal(calls.length, 1);
    assert.deepEqual(logs.error, ['[ember] forward failed messageId=m1 error=The operation was aborted due to timeout']);
});

test('S10 timeout signal is created with 10000 ms', async () => {
    const orig = AbortSignal.timeout;
    let ms;
    AbortSignal.timeout = (v) => {
        ms = v;
        return orig.call(AbortSignal, v);
    };
    try {
        const { forward } = setup();
        await forward(msg());
    } finally {
        AbortSignal.timeout = orig;
    }
    assert.equal(ms, 10000);
});

test('S11 missing URL or secret warns once at creation and never fetches', async () => {
    for (const missing of ['EMBER_WEBHOOK_URL', 'EMBER_WEBHOOK_SECRET']) {
        const { forward, calls, logs } = setup({ ...env, [missing]: undefined });
        assert.equal(logs.warn.length, 1);
        await forward(msg());
        await forward(msg({ id: 'm2' }));
        assert.equal(calls.length, 0);
        assert.equal(logs.warn.length, 1);
    }
});

test('system message in a watched channel is not forwarded', async () => {
    const { forward, calls } = setup();
    await forward(msg({ system: true }));
    assert.equal(calls.length, 0);
});

test('webhook configured but no channel ids set warns once at creation', () => {
    for (const value of [undefined, '', ' , ,']) {
        const { logs } = setup({ ...env, CHANNEL_IDS: value });
        assert.equal(logs.warn.length, 1);
        assert.match(logs.warn[0], /CHANNEL_IDS/);
        assert.ok(!all(logs).includes(SECRET));
    }
});

test('S25 CHANNEL_IDS is trimmed and empty entries ignored', async () => {
    const { forward, calls } = setup({ ...env, CHANNEL_IDS: ' a , b,,c ' });
    const inB = msg();
    inB.channel = { ...inB.channel, id: 'b', parentId: undefined };
    await forward(inB);
    assert.equal(calls.length, 1);
    const inThread = msg();
    inThread.channel = { ...inThread.channel, id: 't1', parentId: 'c', isThread: () => true };
    await forward(inThread);
    assert.equal(calls.length, 2);
    const inD = msg();
    inD.channel = { ...inD.channel, id: 'd', parentId: undefined };
    await forward(inD);
    assert.equal(calls.length, 2);
});

test('response body is released on 2xx and non-2xx', async () => {
    for (const status of [200, 500]) {
        let cancelled = 0;
        const { forward } = setup(env, () => ({
            ok: status < 400,
            status,
            body: { cancel: async () => { cancelled++; } },
        }));
        await forward(msg());
        assert.equal(cancelled, 1);
    }
});

test('non-https non-local webhook URL disables forwarding with one warning', async () => {
    for (const bad of ['http://example.com/hook', 'not a url']) {
        const { forward, calls, logs } = setup({ ...env, EMBER_WEBHOOK_URL: bad });
        assert.equal(logs.warn.length, 1);
        assert.ok(!all(logs).includes(SECRET));
        await forward(msg());
        assert.equal(calls.length, 0);
    }
});

test('http webhook URL to localhost is allowed', async () => {
    for (const ok of ['http://localhost:9999/hook', 'http://127.0.0.1:9999/hook', 'http://[::1]:9999/hook']) {
        const { forward, calls, logs } = setup({ ...env, EMBER_WEBHOOK_URL: ok });
        assert.equal(logs.warn.length, 0);
        await forward(msg());
        assert.equal(calls.length, 1);
    }
});

test('S23 empty content is not forwarded', async () => {
    const { forward, calls } = setup();
    await forward(msg({ content: '' }));
    assert.equal(calls.length, 0);
});

test('S24 sendTyping called once after 2xx; rejection is logged and handler resolves', async () => {
    const { forward } = setup();
    const m = msg();
    await forward(m);
    assert.equal(m.typing.count, 1);

    const { forward: f2, logs } = setup();
    const m2 = msg();
    m2.channel.sendTyping = async () => {
        throw new Error('no perms');
    };
    await f2(m2);
    assert.match(logs.error.join('\n'), /no perms/);
});

test('S24 sendTyping not called on network error', async () => {
    const { forward } = setup(env, async () => {
        throw new Error('boom');
    });
    const m = msg();
    await forward(m);
    assert.equal(m.typing.count, 0);
});

test('task-only: no log line contains the secret or Authorization value', async () => {
    const a = setup(env, async () => {
        throw new Error('fail');
    });
    await a.forward(msg());
    const b = setup(env, async () => ({ ok: false, status: 401 }));
    await b.forward(msg());
    const c = setup({ ...env, EMBER_WEBHOOK_URL: '' });
    for (const { logs } of [a, b, c]) {
        const text = all(logs);
        assert.ok(!text.includes(SECRET));
        assert.ok(!text.includes('Bearer'));
    }
});
