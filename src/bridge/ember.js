const TIMEOUT_MS = 10000;
const SINGLETON = Symbol.for('ember-bridge.forwarder');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isAllowedUrl(value) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        return false;
    }
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && LOCAL_HOSTS.has(parsed.hostname);
}

/**
 * Build a handler that forwards human messages in watched channels/threads
 * to Ember's webhook. Fails safe: errors are logged and dropped.
 */
export function createEmberForwarder({ fetch, env, logger = console }) {
    const url = env.EMBER_WEBHOOK_URL;
    const secret = env.EMBER_WEBHOOK_SECRET;
    let enabled = Boolean(url && secret);

    if (!enabled) {
        logger.warn(
            '[ember] EMBER_WEBHOOK_URL or EMBER_WEBHOOK_SECRET is not set; forwarding disabled',
        );
    } else if (!isAllowedUrl(url)) {
        enabled = false;
        logger.warn(
            '[ember] EMBER_WEBHOOK_URL must be https (or http to localhost); forwarding disabled',
        );
    }

    const ids = new Set(
        [env.HELP_CHANNEL_ID, env.BUGREPORT_CHANNEL_ID].filter(Boolean),
    );

    if (enabled && ids.size === 0) {
        logger.warn(
            '[ember] neither HELP_CHANNEL_ID nor BUGREPORT_CHANNEL_ID is set; no messages will be forwarded',
        );
    }

    const isWatched = (channel) =>
        ids.has(channel.id) ||
        Boolean(channel.isThread?.() && ids.has(channel.parentId));

    return async (message) => {
        try {
            if (!enabled) return;
            if (message.author.bot || message.system) return;
            if (!isWatched(message.channel)) return;
            if (!message.content) return;

            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${secret}`,
                },
                body: JSON.stringify({
                    messageId: message.id,
                    content: message.content,
                    authorId: message.author.id,
                    authorUsername: message.author.username,
                    channelId: message.channel.id,
                    channelName: message.channel.name,
                    guildId: message.guildId,
                    url: message.url,
                    createdAt: message.createdAt.toISOString(),
                }),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });

            await res.body?.cancel().catch(() => {});

            if (!res.ok) {
                logger.error(
                    `[ember] forward failed messageId=${message.id} status=${res.status}`,
                );
                return;
            }

            try {
                await message.channel.sendTyping();
            } catch (err) {
                logger.error(
                    `[ember] sendTyping failed messageId=${message.id} error=${err?.message}`,
                );
            }
        } catch (err) {
            logger.error(
                `[ember] forward failed messageId=${message?.id} error=${err?.message}`,
            );
        }
    };
}

/** Lazy singleton, cached on globalThis so HMR re-imports don't re-warn. */
export function getEmberForwarder() {
    globalThis[SINGLETON] ??= createEmberForwarder({
        fetch: globalThis.fetch,
        env: process.env,
        logger: console,
    });
    return globalThis[SINGLETON];
}
