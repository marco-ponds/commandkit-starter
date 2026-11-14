import { Client } from 'discord.js';
import { registerPrefixResolver } from './app/util/prefixResolver';
import { intents } from './bridge/intents.js';
import { getEmberForwarder } from './bridge/ember.js';
import { startServer } from './bridge/server.js';

const client = new Client({ intents });

registerPrefixResolver();

getEmberForwarder();
startServer({ client });

export default client;
