import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { parseChannelIds } from './channel-ids.js';

const MAX_MESSAGE_LENGTH = 2000;
const DEFAULT_LIMIT = 20;
// Discord API: 50001 Missing Access, 50013 Missing Permissions.
const PERMISSION_CODES = new Set([50001, 50013]);

const SNOWFLAKE = /^\d{17,20}$/;
const ID_FORMAT = 'a Discord snowflake (17-20 digits)';

// Strict schemas: used by the handlers' own safeParse so every bad input
// becomes an invalid_input tool error.
const sendSchema = z.object({
    channelId: z.string().regex(SNOWFLAKE),
    message: z.string().min(1).max(MAX_MESSAGE_LENGTH),
});

const readSchema = z.object({
    channelId: z.string().regex(SNOWFLAKE),
    limit: z.number().int().min(1).max(100).optional(),
});

// Loose shapes registered with the SDK: types and descriptions only, so the
// SDK does not reject bad values itself and the handlers return invalid_input.
const sendShape = {
    channelId: z
        .string()
        .describe(`ID of the Discord channel or thread to post in, ${ID_FORMAT}.`),
    message: z
        .string()
        .describe(
            'Message text in plain Discord markdown, at most 2000 characters. Mention a user as <@userId>; only user mentions ping.',
        ),
};

const readShape = {
    channelId: z
        .string()
        .describe(
            `ID of a watched channel, or of a thread under a watched channel, ${ID_FORMAT}.`,
        ),
    limit: z
        .number()
        .optional()
        .describe(`How many messages to return, 1-100 (default ${DEFAULT_LIMIT}).`),
};

const HINTS = {
    invalid_input:
        'Arguments failed validation; channelId must be a Discord snowflake (17-20 digits), message 1-2000 characters, limit an integer 1-100.',
    not_ready: 'The Discord client is not ready yet; retry shortly.',
    channel_not_found: 'The channel could not be fetched; check the channel ID.',
    channel_not_allowed:
        'This channel is not watched; only watched channels and their threads can be read.',
    channel_not_sendable: 'The channel does not support sending messages.',
    channel_not_readable: 'The channel does not support reading messages.',
    missing_permission:
        'The bot lacks Discord permission (Missing Access or Missing Permissions) for this channel.',
    discord_error: 'Discord rejected the request.',
};

function ok(out) {
    return { content: [{ type: 'text', text: JSON.stringify(out) }] };
}

function fail(code) {
    return {
        isError: true,
        content: [
            { type: 'text', text: JSON.stringify({ code, message: HINTS[code] }) },
        ],
    };
}

/** Map a Discord failure to a tool error; logs only the code and Discord's message. */
function discordFail(err, logger, tool) {
    const code = PERMISSION_CODES.has(err?.code)
        ? 'missing_permission'
        : 'discord_error';
    logger.error(`[mcp] ${tool} failed code=${code} error=${err?.message}`);
    return fail(code);
}

async function fetchChannel(client, channelId, logger, tool) {
    try {
        return (await client.channels.fetch(channelId)) ?? null;
    } catch (err) {
        logger.error(`[mcp] ${tool} channel fetch failed error=${err?.message}`);
        return null;
    }
}

export async function sendDiscordMessage(args, { client, logger = console }) {
    const parsed = sendSchema.safeParse(args);
    if (!parsed.success) return fail('invalid_input');
    const { channelId, message } = parsed.data;

    if (!client.isReady()) return fail('not_ready');

    const channel = await fetchChannel(
        client,
        channelId,
        logger,
        'send_discord_message',
    );
    if (!channel) return fail('channel_not_found');
    if (!channel.isTextBased?.() || typeof channel.send !== 'function') {
        return fail('channel_not_sendable');
    }

    try {
        const sent = await channel.send({
            content: message,
            allowedMentions: { parse: ['users'] },
        });
        return ok({ messageId: sent.id, url: sent.url });
    } catch (err) {
        return discordFail(err, logger, 'send_discord_message');
    }
}

export async function getRecentMessages(args, { client, env, logger = console }) {
    const parsed = readSchema.safeParse(args);
    if (!parsed.success) return fail('invalid_input');
    const { channelId, limit = DEFAULT_LIMIT } = parsed.data;

    if (!client.isReady()) return fail('not_ready');

    const channel = await fetchChannel(
        client,
        channelId,
        logger,
        'get_recent_messages',
    );
    if (!channel) return fail('channel_not_found');

    const ids = parseChannelIds(env.CHANNEL_IDS);
    const allowed =
        ids.has(channel.id) ||
        Boolean(channel.isThread?.() && ids.has(channel.parentId));
    if (!allowed) return fail('channel_not_allowed');

    if (typeof channel.messages?.fetch !== 'function') {
        return fail('channel_not_readable');
    }

    let messages;
    try {
        messages = await channel.messages.fetch({ limit });
    } catch (err) {
        return discordFail(err, logger, 'get_recent_messages');
    }

    const out = [...messages.values()]
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
        .map((m) => ({
            id: m.id,
            authorId: m.author.id,
            authorUsername: m.author.username,
            authorIsBot: Boolean(m.author.bot),
            content: m.content,
            createdAt: m.createdAt.toISOString(),
            url: m.url,
            attachments: [...m.attachments.values()].map((a) => ({
                url: a.url,
                name: a.name,
            })),
        }));
    return ok(out);
}

/** Build a fresh, unconnected MCP server exposing the two Discord tools. */
export function buildMcpServer({ client, env, logger = console }) {
    const deps = { client, env, logger };
    const server = new McpServer({ name: 'discord-bot', version: '1.0.0' });

    server.registerTool(
        'send_discord_message',
        {
            description:
                'Post a message to a Discord channel or thread the bot can see. Plain Discord markdown, at most 2000 characters. Mention users as <@userId>; only user mentions ping (no @everyone or roles). Returns { messageId, url }.',
            inputSchema: sendShape,
        },
        (args) => sendDiscordMessage(args, deps),
    );

    server.registerTool(
        'get_recent_messages',
        {
            description: `Read recent messages from a watched channel (or a thread under one); other channels are refused. Returns an array of messages, newest first. limit is 1-100, default ${DEFAULT_LIMIT}.`,
            inputSchema: readShape,
        },
        (args) => getRecentMessages(args, deps),
    );

    return server;
}
