import type { AuthenticatedPrincipal, PermissionManager } from '@xo/permissions';
import { failResult } from './contract.js';
import type { AuditSink } from '@xo/audit';
import {
  CanonicalAuditRecorder,
  EiStateStore,
  EvidenceStaging,
  KnowledgeModel,
  EvidenceLedger,
  EI_AUDIT_EXTENSION_SCHEMA,
  EI_AUDIT_NAMESPACE,
  ConnectorRegistry,
  EnvironmentInventory,
  LocalFilesystemConnector,
  PermissionManagerAuthorization,
  type AuditRecorder,
  type Deriver,
  type ConnectorContext,
} from '@xo/environment-intelligence';
import { createEiCapabilityProbe, createEiKnowledgePort, createEiLocalFolderBackend } from './ei-backend.js';
import { FileConnectStateStore } from './store.js';
import { stagingConnector } from './staging.js';
import { FileRecordsDeriver } from './deriver.js';
import { createConnectService, type ConnectClock, type ConnectService } from './service.js';

export interface ConnectRuntimeOptions {
  /** The platform permission manager. Every decision comes from it, through `PermissionManagerAuthorization`. */
  readonly permissionManager: PermissionManager;
  /**
   * The platform audit sink (the same `@xo/audit` sink the API uses). Environment Intelligence events are written through
   * `CanonicalAuditRecorder`. The sink MUST have been created with `EI_AUDIT_EXTENSION_SCHEMAS`, or every protected operation fails
   * closed (nothing is read, nothing is allowed). Exactly one of `auditSink` / `audit` is required: there is no unaudited mode.
   */
  readonly auditSink?: AuditSink;
  /** An already-built EI recorder (tests). */
  readonly audit?: AuditRecorder;
  /** Directory for Connect's own durable state (selection, history, stop flag). */
  readonly stateDir: string;
  readonly clock?: ConnectClock;
  /** Allow reading folders on this machine. Default FALSE: see `ConnectServiceOptions.localFolders`. */
  readonly localFolders?: boolean;
  /** Turns retained evidence into knowledge. Default: `FileRecordsDeriver` (structured record files and single-record payloads only; never guesses). */
  readonly deriver?: Deriver;
  /**
   * Durable Environment Intelligence state (journal of the inventory, evidence ledger and ingestion checkpoints). When set, reads
   * RETAIN evidence, the inventory survives a restart, and removal retires evidence. When absent, Connect still works but retains
   * nothing (`ReadReport.evidence: 'not_retained'`).
   */
  readonly durable?: {
    /** Directory for the EI state journal (separate from `stateDir`). */
    readonly dir: string;
    /**
     * Mints the single-use audit `read` grant that starting the state store requires (the store verifies its whole journal on start).
     * Called once, at startup. In the API this is `auditAccess.authorize(servicePrincipal, 'read')`.
     */
    readonly readGrant: () => Promise<unknown>;
    /** The service principal the journal records as its actor. */
    readonly principal: AuthenticatedPrincipal;
  };
}

export interface ConnectRuntime {
  readonly service: ConnectService;
  /** Resolves once the durable state (if configured) is verified and operational. Every service call already waits for it. */
  readonly ready: Promise<{ readonly ok: boolean }>;
  /** Releases the durable store. Safe to call more than once. */
  close(): Promise<void>;
  /** The process-local source inventory the service reads facts from. */
  readonly inventory: EnvironmentInventory;
}

/**
 * Composition root for the C7 local-folder path (D-6). Wires the production authorization gate (the platform PermissionManager), the
 * real local filesystem connector and Connect's durable state into one `ConnectService` a host can pass to the API as `connect`.
 *
 * KNOWN LIMITS: the EI source inventory is process-local (EI's durable state store is not started here), so after a restart a source
 * shows `setup_incomplete` until its folder is previewed or read again; Connect's own selection and history do survive.
 */
/** Extension schemas an `@xo/audit` sink must be created with to accept Environment Intelligence events. */
export const EI_AUDIT_EXTENSION_SCHEMAS = Object.freeze({ [EI_AUDIT_NAMESPACE]: EI_AUDIT_EXTENSION_SCHEMA });

export function createConnectRuntime(options: ConnectRuntimeOptions): ConnectRuntime {
  if ((options.auditSink === undefined) === (options.audit === undefined))
    throw new TypeError('createConnectRuntime requires exactly one of auditSink or audit');
  const audit: AuditRecorder =
    options.audit ??
    new CanonicalAuditRecorder(options.auditSink as AuditSink, { allowVolatileReceipt: options.auditSink?.mode === 'non-production' });
  const registry = new ConnectorRegistry();
  const staging = options.durable !== undefined ? new EvidenceStaging() : undefined;
  const model = options.durable !== undefined ? new KnowledgeModel() : undefined;
  registry.register(staging !== undefined ? stagingConnector(new LocalFilesystemConnector(), staging) : new LocalFilesystemConnector());
  const inventory = new EnvironmentInventory();
  const ledger = options.durable !== undefined ? new EvidenceLedger() : undefined;
  let store: EiStateStore | undefined;
  const ready: Promise<{ readonly ok: boolean }> =
    options.durable === undefined
      ? Promise.resolve({ ok: true })
      : (async () => {
          const d = options.durable as NonNullable<ConnectRuntimeOptions['durable']>;
          try {
            const opened = await EiStateStore.open({ dir: d.dir });
            if (!opened.ok) return { ok: false };
            store = opened.value;
            const started = await opened.value.start({
              grant: await d.readGrant(),
              trust: { principal: d.principal },
              inventory,
              ledger: ledger as EvidenceLedger,
            });
            return { ok: started.ok };
          } catch {
            return { ok: false };
          }
        })();
  const authorization = new PermissionManagerAuthorization(options.permissionManager);
  const clock = options.clock ?? { now: () => new Date() };
  const contextFor = (principal: AuthenticatedPrincipal): ConnectorContext => ({
    clock,
    principal,
    audit,
    authorization,
    ...(ledger !== undefined && store !== undefined ? { ledger, state: store } : {}),
  });
  const backend = createEiLocalFolderBackend({
    deps: { registry, inventory },
    contextFor,
    ...(ledger !== undefined ? { ledger } : {}),
    ...(ledger !== undefined && model !== undefined && staging !== undefined
      ? { knowledge: { model, staging, deriver: options.deriver ?? new FileRecordsDeriver() } }
      : {}),
  });
  const knowledge =
    model !== undefined && ledger !== undefined
      ? createEiKnowledgePort({
          model,
          platform: () => ({ clock, authorization, audit, ledger, ...(store !== undefined ? { state: store } : {}) }),
        })
      : undefined;
  const inner = createConnectService({
    backend,
    store: new FileConnectStateStore(options.stateDir),
    access: createEiCapabilityProbe(contextFor),
    localFolders: options.localFolders === true,
    clock,
    ...(knowledge !== undefined ? { knowledge } : {}),
  });
  // Every operation waits for the durable state to be verified and fails closed (`unavailable`) if it could not be.
  const guarded = new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (prop === 'catalog' || typeof v !== 'function') return v;
      return async (...args: unknown[]) => {
        const r = await ready;
        if (!r.ok) return failResult('unavailable', 'the durable knowledge state is not available; nothing was changed', true);
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return {
    service: guarded,
    ready,
    inventory,
    async close() {
      await ready;
      await store?.close();
    },
  };
}
