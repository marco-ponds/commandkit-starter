import crypto from 'node:crypto';
import express from 'express';

const MAX_MESSAGE_LENGTH = 2000;

let server = null;

export function resolvePort(env) {
  return env.PORT === undefined || env.PORT === '' ? 3000 : Number(env.PORT);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

function isValidToken(provided, secret) {
  return crypto.timingSafeEqual(sha256(provided), sha256(secret));
}

export function createApp({ client, env, logger }) {
  const app = express();

  // Request logger: method, path (no query), status, duration. Never headers.
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
      logger.log(`[http] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    });
    next();
  });

  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  const requireSecret = (req, res, next) => {
    if (!env.SEND_API_SECRET) {
      return res.status(503).json({ error: 'send_disabled' });
    }
    next();
  };

  const requireBearer = (req, res, next) => {
    const match = /^Bearer (.+)$/.exec(req.get('authorization') ?? '');
    if (!match || !isValidToken(match[1], env.SEND_API_SECRET)) {
      return res.status(401).json({ error: 'invalid_token' });
    }
    next();
  };

  app.post('/send', requireSecret, requireBearer, express.json(), async (req, res) => {
    const { channelId, message } = req.body ?? {};
    if (typeof channelId !== 'string' || !channelId || typeof message !== 'string' || !message) {
      return res.status(400).json({ error: 'invalid_body' });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: 'message_too_long' });
    }
    if (!client.isReady()) {
      return res.status(503).json({ error: 'not_ready' });
    }

    let channel;
    try {
      channel = await client.channels.fetch(channelId);
    } catch {
      channel = null;
    }
    if (!channel) {
      return res.status(404).json({ error: 'channel_not_found' });
    }
    if (!channel.isTextBased?.() || typeof channel.send !== 'function') {
      return res.status(422).json({ error: 'channel_not_sendable' });
    }

    try {
      const sent = await channel.send({
        content: message,
        allowedMentions: { parse: ['users'] },
      });
      return res.status(200).json({ id: sent.id });
    } catch (err) {
      logger.error(`[http] send failed: ${err?.message}`);
      return res.status(502).json({ error: 'discord_error' });
    }
  });

  // Body-parser errors (malformed JSON, oversized body) are client errors.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.status >= 400 && err.status < 500) {
      return res.status(400).json({ error: 'invalid_body' });
    }
    logger.error(`[http] unhandled error: ${err?.message}`);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

export function startServer({ client, env = process.env, logger = console }) {
  if (server) return server;
  const app = createApp({ client, env, logger });
  server = app.listen(resolvePort(env));
  server.on('error', (err) => {
    logger.error(`[http] server error: ${err.message}`);
  });
  server.on('listening', () => {
    logger.log(`[http] listening on ${server.address().port}`);
  });
  return server;
}
