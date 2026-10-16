import { ConsoleLogger } from '@xo/logger';
import { loadConfig } from './config.js';
import { createHttpServer } from './server.js';
import { FileAuditStore, resolveAuditConfig, type AuditSink } from '@xo/audit';

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
  void (async () => {
    // P1.0 M4 — audit storage is resolved BEFORE the socket opens. Production without an explicit retention policy,
    // or a half-configured store, aborts startup instead of running unaudited / retaining indefinitely by accident.
    const audit = resolveAuditConfig(process.env);
    if (!audit.ok) {
      logger.error(`startup aborted: ${audit.error.message}`);
      process.exit(1);
    }
    let auditSink: AuditSink | undefined;
    if (audit.value.mode === 'durable') {
      auditSink = await FileAuditStore.open({
        dir: audit.value.dir,
        retention: { defaultRetentionMs: audit.value.defaultRetentionMs, minimumRetentionMs: audit.value.minimumRetentionMs },
      });
    }
    const server = createHttpServer({ logger, apiKeysDir: config.apiKeysDir, ...(auditSink !== undefined ? { auditSink } : {}) });
    server.listen(config.port, config.host, () => {
      logger.info(`listening on http://${config.host}:${config.port}`);
    });
  })().catch((cause: unknown) => {
    logger.error(`startup aborted: ${cause instanceof Error ? cause.message : 'unknown error'}`);
    process.exit(1);
  });
}
