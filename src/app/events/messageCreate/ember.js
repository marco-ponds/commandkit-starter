import { getEmberForwarder } from '../../../bridge/ember.js';

/**
 * @typedef {import('commandkit').EventHandler<'messageCreate'>} MessageCreateHandler
 */

/** @type {MessageCreateHandler} */
const handler = (message) => getEmberForwarder()(message);

export default handler;
