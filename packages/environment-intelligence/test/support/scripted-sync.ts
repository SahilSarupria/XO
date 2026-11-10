/**
 * C4 test support: a SCRIPTED provider and a connector that serves it, plus an environment builder that wires the REAL registry,
 * ledger, audit recorder, durable `EiStateStore` and framework enforcement. Everything is offline and deterministic: the "provider"
 * is an in-memory script, there is no network and there are no credentials. Tests built on it are OFFLINE CONTRACT tests of EI's
 * ingestion machinery; they say nothing about any real provider.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathScope, toPrincipalSnapshot, type AuthenticatedPrincipal } from '@xo/permissions';
import { MockClock } from '@xo/testing';
import { err, ok, type Result } from '@xo/types';
import {
  AuditErrorCode,
  ConnectorRegistry,
  DiscoveryErrorCode,
  EiStateStore,
  EnvironmentInventory,
  EvidenceLedger,
  InMemoryAuditRecorder,
  auditError,
  discoverSource,
  discoveryError,
  type AuditError,
  type AuditReceipt,
  type AuditRecordRequest,
  type AuditRecorder,
  type AuditTrust,
  type ConnectionValidation,
  type Connector,
  type ConnectorContext,
  type ConnectorDescriptor,
  type DetectedSource,
  type DiscoveryDeps,
  type DiscoveryError,
  type DiscoveryOutcome,
  type DiscoveryRequest,
  type Evidence,
  type RemovedResource,
  type SourceId,
  type SyncOutcome,
  type SyncRequest,
} from '../../src/index.js';
import { auditDenial, beginAudit, runAudited } from '../../src/audited-operation.js';
import { requireAuthorization, type TrustedAllow } from '../../src/authorization-gate.js';
import { ConnectorId, EvidenceId, SourceId as toSourceId, stableDigest, stableId } from '../../src/ids.js';
import { TEST_PRINCIPAL } from '../helpers.js';
import { readGrant } from './audit-grants.js';
import { ScriptedAuthorization } from './scripted-authorization.js';

export const SCRIPT_CONNECTOR_ID = ConnectorId('xo.connector.test-scripted-sync');
export const SCRIPT_SOURCE_TYPE = 'x-test-scripted' as const;
const LIST = 'filesystem.list';
const READ = 'filesystem.read';

export interface ScriptScope {
  readonly kind: 'scripted_source';
  readonly path: string;
}
export const SCOPE: ScriptScope = { kind: 'scripted_source', path: '/scripted/finance-share' };

export interface ScriptedItem {
  readonly key: string;
  readonly content: string;
}
export interface ScriptedPage {
  readonly items: readonly ScriptedItem[];
  readonly removed?: readonly RemovedResource[];
  /** Cursor to resume from. Undefined = nothing further. */
  readonly next?: string;
  readonly status?: 'complete' | 'partial';
  /** Evidence kind to stamp on items (default `document_content`); used to provoke a kind mismatch. */
  readonly kind?: Evidence['kind'];
}

/** The scripted provider: pages keyed by the cursor they are read from (`''` = from the beginning). */
export class ScriptedProvider {
  readonly pages = new Map<string, ScriptedPage>();
  /** Every cursor a read was attempted with, in order (`undefined` = from the beginning). */
  readonly reads: (string | undefined)[] = [];
  /** Runs at the start of a sync call, BEFORE the connector asks for authorization (simulates a change of policy mid-run). */
  beforeAuthorize: ((cursor: string | undefined) => Promise<void> | void) | undefined;
  /** Runs after authorization was granted and the audit attempt accepted, before the page is read (simulates mid-read revocation, delay, crash). */
  afterAuthorize: ((cursor: string | undefined) => Promise<void> | void) | undefined;

  set(cursor: string | undefined, page: ScriptedPage): this {
    this.pages.set(cursor ?? '', page);
    return this;
  }
}

class ScriptedConnector implements Connector<ScriptScope> {
  readonly descriptor: ConnectorDescriptor;
  incrementalSync: (request: SyncRequest<ScriptScope>, ctx: ConnectorContext) => Promise<Result<SyncOutcome, DiscoveryError>>;

  constructor(private readonly provider: ScriptedProvider) {
    this.descriptor = Object.freeze({
      id: SCRIPT_CONNECTOR_ID,
      version: '0.0.1',
      displayName: 'Scripted sync provider (test double)',
      sourceTypes: [SCRIPT_SOURCE_TYPE],
      authMethods: ['operator_scope_grant'],
      configFields: [],
      requiredPermissions: { detect: LIST, validate_connection: LIST, discover: LIST, incremental_sync: READ },
      operations: {
        detect: 'supported',
        validate_connection: 'supported',
        discover: 'supported',
        acquire_content: 'unsupported',
        incremental_sync: 'supported',
        health: 'unsupported',
      },
      evidenceKinds: ['resource_inventory', 'document_content'],
      sideEffects: 'none',
      documentation: { scope: 'A script. Test double only.', detects: [], cannotDetermine: [], limitations: ['test double'] },
    } as ConnectorDescriptor);
    this.incrementalSync = (request, ctx) => this.sync(request, ctx);
  }

  static sourceId(path: string): SourceId {
    return toSourceId(stableId('src', [SCRIPT_SOURCE_TYPE, path]));
  }

  private async authorize(
    ctx: ConnectorContext,
    operation: 'detect' | 'validate_connection' | 'discover' | 'incremental_sync',
    permission: string,
    path: string,
  ) {
    const decided = await requireAuthorization(ctx.authorization, {
      connectorId: SCRIPT_CONNECTOR_ID,
      operation,
      permission,
      scope: pathScope(path),
      ...(ctx.principal !== undefined ? { principal: ctx.principal } : {}),
      reason: `scripted ${operation}`,
    });
    if (!decided.ok)
      await auditDenial(ctx, { operation, connectorId: SCRIPT_CONNECTOR_ID, permission, scope: pathScope(path), error: decided.error });
    return decided;
  }

  private source(path: string, ctx: ConnectorContext): DetectedSource {
    return {
      sourceId: ScriptedConnector.sourceId(path),
      sourceType: SCRIPT_SOURCE_TYPE,
      displayName: 'scripted',
      locator: path,
      detectedBy: SCRIPT_CONNECTOR_ID,
      detectedAt: ctx.clock.now().toISOString(),
      fingerprint: stableDigest([SCRIPT_SOURCE_TYPE, path]),
    };
  }

  async detectSource(request: DiscoveryRequest<ScriptScope>, ctx: ConnectorContext): Promise<Result<DetectedSource, DiscoveryError>> {
    const a = await this.authorize(ctx, 'detect', LIST, request.scope.path);
    return a.ok ? ok(this.source(request.scope.path, ctx)) : a;
  }

  async validateConnection(
    request: DiscoveryRequest<ScriptScope>,
    ctx: ConnectorContext,
  ): Promise<Result<ConnectionValidation, DiscoveryError>> {
    const a = await this.authorize(ctx, 'validate_connection', LIST, request.scope.path);
    if (!a.ok) return a;
    return ok({
      sourceId: ScriptedConnector.sourceId(request.scope.path),
      validatedAt: ctx.clock.now().toISOString(),
      details: { readable: true },
    });
  }

  async discover(request: DiscoveryRequest<ScriptScope>, ctx: ConnectorContext): Promise<Result<DiscoveryOutcome, DiscoveryError>> {
    const path = request.scope.path;
    const a = await this.authorize(ctx, 'discover', LIST, path);
    if (!a.ok) return a;
    const sourceId = ScriptedConnector.sourceId(path);
    const session = await beginAudit(ctx, {
      operation: 'discover',
      connectorId: SCRIPT_CONNECTOR_ID,
      connectorVersion: '0.0.1',
      permission: LIST,
      scope: pathScope(path),
      allow: a.value,
      sourceId,
    });
    if (!session.ok) return session;
    return runAudited(session.value, async () =>
      ok({
        status: 'complete' as const,
        sources: [this.source(path, ctx)],
        scans: [{ sourceId, contentFingerprint: stableDigest([path]) }],
        evidence: [],
        skipped: { byReason: {} },
        limits: { hit: [], entriesVisited: 0, elapsedMs: 0 },
        errors: [],
      }),
    );
  }

  async acquireContent(): Promise<Result<never, DiscoveryError>> {
    return err(discoveryError(DiscoveryErrorCode.UNSUPPORTED_OPERATION, 'unsupported'));
  }

  private evidence(sourceId: SourceId, item: ScriptedItem, kind: Evidence['kind'], allow: TrustedAllow, ctx: ConnectorContext): Evidence {
    const digest = `sha256:${createHash('sha256').update(item.content).digest('hex')}`;
    return Object.freeze({
      id: EvidenceId(stableId('ev', [sourceId, kind, item.key, digest])),
      kind,
      sourceId,
      resourceKey: item.key,
      payload: { digest, identifiers: [] },
      sensitivity: 'derived_from_content' as const,
      provenance: {
        sourceId,
        connectorId: SCRIPT_CONNECTOR_ID,
        connectorVersion: '0.0.1',
        locator: item.key,
        observedAt: ctx.clock.now().toISOString(),
        access: {
          operation: 'incremental_sync' as const,
          permission: READ,
          authority: allow.authority,
          decisionReason: allow.decision.reason,
          principal: allow.principal,
        },
        transformationChain: [],
      },
    });
  }

  private async sync(request: SyncRequest<ScriptScope>, ctx: ConnectorContext): Promise<Result<SyncOutcome, DiscoveryError>> {
    this.provider.reads.push(request.cursor);
    await this.provider.beforeAuthorize?.(request.cursor);
    const path = request.scope.path;
    const a = await this.authorize(ctx, 'incremental_sync', READ, path);
    if (!a.ok) return a;
    const sourceId = ScriptedConnector.sourceId(path);
    const session = await beginAudit(ctx, {
      operation: 'incremental_sync',
      connectorId: SCRIPT_CONNECTOR_ID,
      connectorVersion: '0.0.1',
      permission: READ,
      scope: pathScope(path),
      allow: a.value,
      sourceId,
    });
    if (!session.ok) return session;
    await this.provider.afterAuthorize?.(request.cursor);
    const page = this.provider.pages.get(request.cursor ?? '');
    if (page === undefined)
      return runAudited(session.value, async () =>
        err(discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'unrecognised cursor', { field: 'cursor' })),
      );
    return runAudited(session.value, async () =>
      ok({
        status: page.status ?? ('complete' as const),
        evidence: page.items.map((i) => this.evidence(sourceId, i, page.kind ?? 'document_content', a.value, ctx)),
        skipped: { byReason: {} },
        limits: { hit: [], entriesVisited: page.items.length, elapsedMs: 0 },
        errors: [],
        ...(page.next !== undefined ? { nextCursor: page.next } : {}),
        ...(page.removed !== undefined ? { removed: page.removed } : {}),
      }),
    );
  }
}

/** An audit recorder that can be told to refuse (to prove fail-closed behaviour), delegating to the real in-memory recorder. */
export class FlakyRecorder implements AuditRecorder {
  readonly inner: InMemoryAuditRecorder;
  /** Return true to refuse this event. */
  refuse: ((event: AuditRecordRequest) => boolean) | undefined;

  constructor(clock: MockClock) {
    this.inner = new InMemoryAuditRecorder(() => clock.now());
  }

  async record(event: AuditRecordRequest, trust: AuditTrust): Promise<Result<AuditReceipt, AuditError>> {
    if (this.refuse?.(event) === true) return err(auditError(AuditErrorCode.UNAVAILABLE, 'scripted audit outage'));
    return this.inner.record(event, trust);
  }
}

export interface IngestEnv {
  readonly dir: string;
  readonly store: EiStateStore;
  readonly inventory: EnvironmentInventory;
  readonly ledger: EvidenceLedger;
  readonly deps: DiscoveryDeps;
  readonly ctx: ConnectorContext;
  readonly provider: ScriptedProvider;
  readonly authz: ScriptedAuthorization;
  readonly recorder: FlakyRecorder;
  readonly clock: MockClock;
  readonly sourceId: SourceId;
  /** Mutable policy: which (operation) grants are currently held. */
  readonly policy: { list: boolean; read: boolean; ingest: boolean };
}

export interface EnvOptions {
  readonly provider?: ScriptedProvider;
  readonly ops?: Parameters<typeof EiStateStore.open>[0]['ops'];
  readonly principal?: AuthenticatedPrincipal;
  readonly policy?: Partial<IngestEnv['policy']>;
  /** Skip the initial `discoverSource` (used when reopening an already-established journal). */
  readonly skipDiscover?: boolean;
  readonly clock?: MockClock;
  readonly auditRecorder?: FlakyRecorder;
}

/** Boots (or reboots) the durable store in `dir` and wires the real EI components around a scripted provider. */
export async function ingestEnv(base: string, options: EnvOptions = {}): Promise<IngestEnv> {
  const dir = join(base, 'state');
  const principal = options.principal ?? TEST_PRINCIPAL;
  const opened = await EiStateStore.open({ dir, ...(options.ops !== undefined ? { ops: options.ops } : {}) });
  if (!opened.ok) throw new Error(`state open failed: ${opened.error.code}`);
  const inventory = new EnvironmentInventory();
  const ledger = new EvidenceLedger();
  const started = await opened.value.start({ grant: await readGrant(), trust: { principal }, inventory, ledger });
  if (!started.ok) throw new Error(`state start failed: ${started.error.code}`);
  const provider = options.provider ?? new ScriptedProvider();
  const registry = new ConnectorRegistry();
  registry.register(new ScriptedConnector(provider));
  const deps: DiscoveryDeps = { registry, inventory };
  const clock = options.clock ?? new MockClock('2026-10-30T00:00:00.000Z');
  const recorder = options.auditRecorder ?? new FlakyRecorder(clock);
  const policy = { list: true, read: true, ingest: true, ...(options.policy ?? {}) };
  const authz = new ScriptedAuthorization((r) =>
    r.operation === 'ingest_source' ? policy.ingest : r.permission === LIST ? policy.list : r.permission === READ ? policy.read : false,
  );
  const ctx: ConnectorContext = { clock, authorization: authz, principal, audit: recorder, ledger, state: opened.value };
  const sourceId = ScriptedConnector.sourceId(SCOPE.path);
  if (options.skipDiscover !== true) {
    const run = await discoverSource(deps, { sourceType: SCRIPT_SOURCE_TYPE, scope: SCOPE }, ctx);
    if (!run.ok || run.value.record.axes.authorization !== 'granted') throw new Error('scripted source could not be established');
  }
  return { dir, store: opened.value, inventory, ledger, deps, ctx, provider, authz, recorder, clock, sourceId, policy };
}

export const SCOPE_OF = (path: string): ScriptScope => ({ kind: 'scripted_source', path });
export { toPrincipalSnapshot };
