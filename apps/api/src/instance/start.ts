import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { ConsoleLogger, type Logger, type LogLevel } from '@xo/logger';
import { shutdownPdfium, shutdownTesseract } from '@xo/compiler';
import { assertTrustPolicyAllowedHere, loadOperatorTrustPolicy } from '@xo/package-sdk';
import { FileAuditStore, NonProductionAuditSink, resolveAuditConfig, type AuditSink } from '@xo/audit';
import { EI_AUDIT_EXTENSION_SCHEMAS } from '@xo/connect';
import { applySettingsToEnv, openInstance, type OpenedInstance } from '@xo/instance';
import { loadConfig } from '../config.js';
import { createHttpServer } from '../server.js';
import { createAuthorizationPoint } from '../auth/authorization-point.js';
import { auditAnchorSinkFromEnv } from '../audit/anchor.js';
import { AuditService } from '../audit/audit-service.js';
import { schedulerDepsFrom, startScheduler } from '../workflow-controls/scheduler.js';
import { InstanceMetrics } from './metrics.js';
import { instanceReadiness } from './readiness.js';
import { StudioStatic } from './studio-static.js';

/**
 * UW-17 (ADR 0023) — the one way an XO instance starts, whoever starts it (`xo up`, `node apps/api/dist/index.js`, the container,
 * `npm run dev`). Settings are validated first and every problem is reported at once; the instance is locked, created on first start
 * and migrated; audit storage, package trust and the authorization point are resolved before the socket opens; then the API (and,
 * when configured, Studio on the same port) and the schedule triggers start. `stop()` undoes it in reverse.
 */
export interface StartInstanceOptions {
  /** The environment read and then completed with resolved values (default `process.env`, which every module reads). */
  readonly env?: NodeJS.ProcessEnv;
  readonly xoVersion?: string;
  readonly cwd?: string;
  readonly logger?: Logger;
  /** Overrides PORT/HOST (tests use port 0). */
  readonly listen?: { readonly port: number; readonly host: string };
}

export interface RunningInstance {
  /** Where the socket is bound. */
  readonly url: string;
  /** What people should open: `XO_PUBLIC_BASE_URL`, or the bound address. */
  readonly publicUrl: string;
  readonly server: Server;
  readonly opened: OpenedInstance;
  readonly servesStudio: boolean;
  stop(): Promise<void>;
}

export const XO_VERSION = '0.1.0';

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);

export async function startInstance(opts: StartInstanceOptions = {}): Promise<RunningInstance> {
  const env = opts.env ?? process.env;
  const xoVersion = opts.xoVersion ?? XO_VERSION;
  const opened = await openInstance(env, { xoVersion, purpose: 'instance', ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}) });
  const cleanups: (() => void | Promise<void>)[] = [async () => opened.lock?.release()];
  const stop = async () => {
    for (const c of cleanups.splice(0).reverse()) await Promise.resolve(c()).catch(() => undefined);
  };
  try {
    applySettingsToEnv(opened.settings, env);
    const level = env['XO_LOG_LEVEL'] ?? 'info';
    const logger = opts.logger ?? new ConsoleLogger({ name: 'xo', level: (LEVELS.has(level) ? level : 'info') as LogLevel });
    for (const w of opened.settings.warnings) logger.warn(`setting ${w.name} ${w.message}`);
    if (opened.created) logger.info('instance created', { instanceId: opened.meta?.instanceId, dataDir: opened.dataDir });
    if (opened.migration !== undefined && opened.migration.applied.length > 0)
      logger.info('instance data migrated', { from: opened.migration.from, to: opened.migration.to });
    if (opened.dataDir === undefined)
      logger.warn(
        'XO_DATA_DIR is not set: state is spread over separate folders, with no instance lock, migrations or backups (set XO_DATA_DIR)',
      );

    const config = loadConfig(env);
    await mkdir(config.workspaceDataDir, { recursive: true });
    // P1.0 M4 — audit storage is resolved BEFORE the socket opens. Production without an explicit retention policy, or a half-configured
    // store, aborts startup instead of running unaudited / retaining indefinitely by accident.
    const audit = resolveAuditConfig(env);
    if (!audit.ok) throw audit.error;
    let auditSink: AuditSink | undefined;
    if (audit.value.mode === 'durable') {
      auditSink = await FileAuditStore.open({
        dir: audit.value.dir,
        retention: { defaultRetentionMs: audit.value.defaultRetentionMs, minimumRetentionMs: audit.value.minimumRetentionMs },
      });
    } else logger.warn('platform audit is in non-production mode (set XO_AUDIT_RETENTION_DAYS and XO_AUDIT_MIN_RETENTION_DAYS to keep it)');
    // Invalid or incomplete authentication or trust configuration stops start-up visibly, never degrades silently. The server and the
    // schedule trigger share exactly the same enforcement inputs (one authorization point, one audit sink, one package trust).
    const trust = loadOperatorTrustPolicy(env);
    if (!trust.ok) throw trust.error;
    const allowed = assertTrustPolicyAllowedHere(trust.value, env);
    if (!allowed.ok) throw allowed.error;
    const sink = auditSink ?? new NonProductionAuditSink(undefined, { extensionSchemas: EI_AUDIT_EXTENSION_SCHEMAS });
    const authorization = createAuthorizationPoint({ dataRootDir: config.workspaceDataDir, onError: (message) => logger.error(message) });
    cleanups.push(() => authorization.stop());
    const auditAnchor = auditAnchorSinkFromEnv(env);
    if (auditAnchor === undefined && opened.dataDir !== undefined)
      logger.warn('XO_AUDIT_ANCHOR_DIR is not set: audit verification cannot detect a complete rewrite of a workspace log');

    let studio: StudioStatic | undefined;
    if (env['XO_STUDIO_DIR'] !== undefined) {
      studio = new StudioStatic({ dir: env['XO_STUDIO_DIR'], devSignIn: !['0', 'false'].includes(env['XO_DEV_SIGN_IN'] ?? '1') });
      await studio.check();
    }
    const schedulerOn = env['XO_SCHEDULER'] !== 'off';
    const metrics = new InstanceMetrics({
      version: xoVersion,
      ...(opened.meta !== undefined ? { instanceId: opened.meta.instanceId } : {}),
    });
    const server = createHttpServer({
      logger,
      env,
      apiKeysDir: config.apiKeysDir,
      auditSink: sink,
      packageTrustPolicy: trust.value,
      authorization,
      ...(auditAnchor !== undefined ? { auditAnchor } : {}),
      ...(studio !== undefined ? { studio } : {}),
      metrics,
      ...(env['XO_METRICS_TOKEN'] !== undefined ? { metricsToken: env['XO_METRICS_TOKEN'] } : {}),
      readiness: instanceReadiness({
        workspaceDataDir: config.workspaceDataDir,
        ...(opened.dataDir !== undefined ? { dataDir: opened.dataDir } : {}),
        scheduler: schedulerOn ? 'on' : 'off',
      }),
    });
    const port = opts.listen?.port ?? config.port;
    const host = opts.listen?.host ?? config.host;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    );
    // UW-3: local OCR workers and the PDF renderer hold native resources; release them with the instance.
    cleanups.push(async () => {
      await shutdownTesseract().catch(() => undefined);
      await shutdownPdfium().catch(() => undefined);
    });
    // Schedule triggers fire from this process. XO_SCHEDULER=off turns them off (for example on a second instance).
    if (schedulerOn) {
      const stopScheduler = startScheduler(
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
      cleanups.push(stopScheduler);
    }
    const address = server.address() as AddressInfo;
    const bound = `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`;
    const local = host === '0.0.0.0' || host === '::' ? `http://127.0.0.1:${address.port}` : bound;
    const publicUrl = env['XO_PUBLIC_BASE_URL']?.replace(/\/+$/, '') ?? local;
    logger.info(`listening on ${bound}`, { publicUrl, studio: studio !== undefined, scheduler: schedulerOn ? 'on' : 'off' });
    return { url: bound, publicUrl, server, opened, servesStudio: studio !== undefined, stop };
  } catch (cause) {
    await stop();
    throw cause;
  }
}
