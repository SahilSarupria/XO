import { ConsoleLogger } from '@xo/logger';
import { shutdownPdfium, shutdownTesseract } from '@xo/compiler';
import { loadConfig } from './config.js';
import { createHttpServer } from './server.js';
import { assertTrustPolicyAllowedHere, loadOperatorTrustPolicy } from '@xo/package-sdk';
import { createAuthorizationPoint } from './auth/authorization-point.js';
import { auditAnchorSinkFromEnv } from './audit/anchor.js';
import { AuditService } from './audit/audit-service.js';
import { NonProductionAuditSink } from '@xo/audit';
import { EI_AUDIT_EXTENSION_SCHEMAS } from '@xo/connect';
import { FileAuditStore, resolveAuditConfig, type AuditSink } from '@xo/audit';
import { schedulerDepsFrom, startScheduler } from './workflow-controls/scheduler.js';

export { createHttpServer, buildRouter } from './server.js';
export type { ServerDeps } from './server.js';
export { createConfiguredExternalToolWiring } from './external-tools-host.js';
export type { OidcAuthDeps } from './http/auth.js';
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
    // Invalid or incomplete authentication configuration (OIDC, trust policy) must stop startup visibly, never degrade silently.
    // Resolve the trust policy and the audit sink HERE so the server and the schedule trigger share exactly the same enforcement
    // inputs (same policy decision point, same audit sink, same package trust).
    const trust = loadOperatorTrustPolicy();
    if (!trust.ok) throw trust.error;
    const allowed = assertTrustPolicyAllowedHere(trust.value);
    if (!allowed.ok) throw allowed.error;
    const sink = auditSink ?? new NonProductionAuditSink(undefined, { extensionSchemas: EI_AUDIT_EXTENSION_SCHEMAS });
    // UW-1: one authorization point and one anchoring configuration for the server AND the scheduler (no second policy for scheduled runs).
    const authorization = createAuthorizationPoint({ dataRootDir: config.workspaceDataDir, onError: (message) => logger.error(message) });
    const auditAnchor = auditAnchorSinkFromEnv(process.env);
    const server = createHttpServer({
      logger,
      apiKeysDir: config.apiKeysDir,
      auditSink: sink,
      packageTrustPolicy: trust.value,
      authorization,
      ...(auditAnchor !== undefined ? { auditAnchor } : {}),
    });
    server.on('close', () => {
      authorization.stop();
      // UW-3: local OCR workers and the PDF renderer hold native resources; release them with the server.
      void shutdownTesseract().catch(() => undefined);
      void shutdownPdfium().catch(() => undefined);
    });
    server.listen(config.port, config.host, () => {
      logger.info(`listening on http://${config.host}:${config.port}`);
    });
    // Schedule triggers fire from this process. Set XO_SCHEDULER=off to turn them off (for example on a second instance).
    if (process.env['XO_SCHEDULER'] !== 'off') {
      const stop = startScheduler(
        schedulerDepsFrom(
          config.workspacesDir,
          config.workspaceDataDir,
          {
            permissionManager: authorization.permissionManager,
            audit: new AuditService(sink, (info) => logger.error(`audit write failed (${info.phase}): ${info.code}`)),
            packageTrustPolicy: trust.value,
            ...(auditAnchor !== undefined ? { auditAnchor } : {}),
          },
          (line) => logger.warn(line),
        ),
      );
      server.on('close', stop);
      logger.info('schedule triggers are on (XO_SCHEDULER=off to disable)');
    }
  })().catch((cause: unknown) => {
    logger.error(`startup aborted: ${cause instanceof Error ? cause.message : 'unknown error'}`);
    process.exit(1);
  });
}
