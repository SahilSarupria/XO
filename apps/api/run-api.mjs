// Temporary launcher — works around dist/index.js's isMainModule() check
// not detecting Windows as the entrypoint. Doesn't modify any project
// file; calls the exact same exported functions the real entrypoint does.
import { createHttpServer } from './dist/index.js';
import { loadConfig } from './dist/config.js';
import { ConsoleLogger } from '@xo/logger';

const config = loadConfig();
const logger = new ConsoleLogger({ name: 'xo-api' });
const server = createHttpServer({ logger, apiKeysDir: config.apiKeysDir });
server.listen(config.port, config.host, () => {
  logger.info(`listening on http://${config.host}:${config.port}`);
});