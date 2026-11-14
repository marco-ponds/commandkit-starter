import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, IntentsBitField } from 'discord.js';
import { intents } from '../src/bridge/intents.js';

test('S1: client intents include Guilds, GuildMessages and MessageContent', () => {
    const client = new Client({ intents });
    const bits = client.options.intents;
    for (const name of ['Guilds', 'GuildMessages', 'MessageContent']) {
        assert.ok(bits.has(IntentsBitField.Flags[name]), `missing ${name}`);
    }
    client.destroy();
});

test('S1: existing GuildMembers intent is kept', () => {
    const bits = new IntentsBitField(intents);
    assert.ok(bits.has(IntentsBitField.Flags.GuildMembers));
});
