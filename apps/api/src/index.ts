import { ConsoleLogger } from '@xo/logger';
import { loadConfig } from './config.js';
import { createHttpServer } from './server.js';

export { createHttpServer, buildRouter } from './server.js';
export type { ServerDeps } from './server.js';
export * from './http/types.js';

/** Only runs when this module is the actual process entrypoint (`npm start` / `node dist/index.js`) — importing this module from a test never binds a socket. */
function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href;
}

if (isMainModule()) {
  const config = loadConfig();
  const logger = new ConsoleLogger({ name: 'xo-api' });
  const server = createHttpServer({ logger, apiKeysDir: config.apiKeysDir });
  server.listen(config.port, config.host, () => {
    logger.info(`listening on http://${config.host}:${config.port}`);
  });
}
