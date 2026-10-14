import { ConsoleLogger } from '@xo/logger';
import { loadConfig } from './config.js';
import { createHttpServer } from './server.js';

export { createHttpServer, buildRouter } from './server.js';
export type { ServerDeps } from './server.js';
export type { OidcAuthDeps } from './http/auth.js';
export * from './http/types.js';

/** Only runs when this module is the actual process entrypoint (`npm start` / `node dist/index.js`) — importing this module from a test never binds a socket. */
function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href;
}

if (isMainModule()) {
  const config = loadConfig();
  const logger = new ConsoleLogger({ name: 'xo-api' });
  try {
    const server = createHttpServer({ logger, apiKeysDir: config.apiKeysDir });
    server.listen(config.port, config.host, () => {
      logger.info(`listening on http://${config.host}:${config.port}`);
    });
  } catch (cause) {
    // Invalid or incomplete authentication configuration must stop startup visibly, never degrade silently.
    logger.error(`refusing to start: ${cause instanceof Error ? cause.message : 'invalid configuration'}`);
    process.exitCode = 1;
  }
}
