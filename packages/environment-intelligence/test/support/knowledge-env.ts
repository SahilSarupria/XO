/**
 * C5 test support: several SCRIPTED organizational sources (email-like, project-tool-like, HR-directory-like, policy-document-like)
 * served through the REAL registry, framework enforcement, ledger, audit recorder and durable `EiStateStore`, and ingested through
 * the REAL C4 `ingestSource`. Offline and deterministic; nothing here verifies any real provider (live Microsoft OAuth is UNVERIFIED).
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathScope, type AuthenticatedPrincipal } from '@xo/permissions';
import { MockClock } from '@xo/testing';
import { err, ok, type Result } from '@xo/types';
import {
  ConnectorRegistry,
  DiscoveryErrorCode,
  EiStateStore,
  EnvironmentInventory,
  EvidenceLedger,
  EvidenceStaging,
  KnowledgeModel,
  STRUCTURED_RECORD_SCHEMA,
  capturingConnector,
  discoverSource,
  discoveryError,
  ingestSource,
  type Connector,
  type ConnectorContext,
  type ConnectorDescriptor,
  type DetectedSource,
  type DiscoveryDeps,
  type DiscoveryError,
  type Evidence,
  type IngestionResult,
  type JsonValue,
  type RemovedResource,
  type ResolutionPolicy,
  type SourceId,
  type SyncOutcome,
  type SyncRequest,
  type ConnectionValidation,
  type DiscoveryOutcome,
  type DiscoveryRequest,
} from '../../src/index.js';
import { auditDenial, beginAudit, runAudited } from '../../src/audited-operation.js';
import { requireAuthorization, type TrustedAllow } from '../../src/authorization-gate.js';
import { ConnectorId, EvidenceId, SourceId as toSourceId, stableDigest, stableId } from '../../src/ids.js';
import { TEST_PRINCIPAL, authenticated } from '../helpers.js';
import { readGrant } from './audit-grants.js';
import { ScriptedAuthorization } from './scripted-authorization.js';
import { FlakyRecorder } from './scripted-sync.js';

export const KNOW_CONNECTOR_ID = ConnectorId('xo.connector.test-org-sources');
export const KNOW_SOURCE_TYPE = 'x-test-org' as const;
const LIST = 'filesystem.list';
const READ = 'filesystem.read';

export interface OrgScope {
  readonly kind: 'org_source';
  readonly path: string;
}
export const scopeOf = (path: string): OrgScope => ({ kind: 'org_source', path });

export interface OrgItem {
  readonly key: string;
  readonly record: JsonValue;
  /** Observation time override (ISO). */
  readonly observedAt?: string;
}
export interface OrgPage {
  readonly items: readonly OrgItem[];
  readonly removed?: readonly RemovedResource[];
  readonly next?: string;
}

/** Scripted pages per source path and cursor. */
export class OrgProvider {
  readonly pages = new Map<string, OrgPage>();
  set(path: string, cursor: string | undefined, page: OrgPage): this {
    this.pages.set(`${path}#${cursor ?? ''}`, page);
    return this;
  }
}

const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x !== null && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );

class OrgConnector implements Connector<OrgScope> {
  readonly descriptor: ConnectorDescriptor;
  incrementalSync: (request: SyncRequest<OrgScope>, ctx: ConnectorContext) => Promise<Result<SyncOutcome, DiscoveryError>>;
  constructor(private readonly provider: OrgProvider) {
    this.descriptor = Object.freeze({
      id: KNOW_CONNECTOR_ID,
      version: '0.0.1',
      displayName: 'Scripted org sources (test double)',
      sourceTypes: [KNOW_SOURCE_TYPE],
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
    this.incrementalSync = (r, c) => this.sync(r, c);
  }
  static sourceId(path: string): SourceId {
    return toSourceId(stableId('src', [KNOW_SOURCE_TYPE, path]));
  }
  private async authorize(
    ctx: ConnectorContext,
    operation: 'detect' | 'validate_connection' | 'discover' | 'incremental_sync',
    permission: string,
    path: string,
  ) {
    const d = await requireAuthorization(ctx.authorization, {
      connectorId: KNOW_CONNECTOR_ID,
      operation,
      permission,
      scope: pathScope(path),
      ...(ctx.principal !== undefined ? { principal: ctx.principal } : {}),
      reason: `scripted ${operation}`,
    });
    if (!d.ok) await auditDenial(ctx, { operation, connectorId: KNOW_CONNECTOR_ID, permission, scope: pathScope(path), error: d.error });
    return d;
  }
  private source(path: string, ctx: ConnectorContext): DetectedSource {
    return {
      sourceId: OrgConnector.sourceId(path),
      sourceType: KNOW_SOURCE_TYPE,
      displayName: 'scripted',
      locator: path,
      detectedBy: KNOW_CONNECTOR_ID,
      detectedAt: ctx.clock.now().toISOString(),
      fingerprint: stableDigest([KNOW_SOURCE_TYPE, path]),
    };
  }
  async detectSource(r: DiscoveryRequest<OrgScope>, ctx: ConnectorContext): Promise<Result<DetectedSource, DiscoveryError>> {
    const a = await this.authorize(ctx, 'detect', LIST, r.scope.path);
    return a.ok ? ok(this.source(r.scope.path, ctx)) : a;
  }
  async validateConnection(r: DiscoveryRequest<OrgScope>, ctx: ConnectorContext): Promise<Result<ConnectionValidation, DiscoveryError>> {
    const a = await this.authorize(ctx, 'validate_connection', LIST, r.scope.path);
    if (!a.ok) return a;
    return ok({ sourceId: OrgConnector.sourceId(r.scope.path), validatedAt: ctx.clock.now().toISOString(), details: { readable: true } });
  }
  async discover(r: DiscoveryRequest<OrgScope>, ctx: ConnectorContext): Promise<Result<DiscoveryOutcome, DiscoveryError>> {
    const path = r.scope.path;
    const a = await this.authorize(ctx, 'discover', LIST, path);
    if (!a.ok) return a;
    const sourceId = OrgConnector.sourceId(path);
    const session = await beginAudit(ctx, {
      operation: 'discover',
      connectorId: KNOW_CONNECTOR_ID,
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
  private evidence(sourceId: SourceId, item: OrgItem, allow: TrustedAllow, ctx: ConnectorContext): Evidence {
    const digest = `sha256:${createHash('sha256').update(canon(item.record)).digest('hex')}`;
    return Object.freeze({
      id: EvidenceId(stableId('ev', [sourceId, 'document_content', item.key, digest])),
      kind: 'document_content' as const,
      sourceId,
      resourceKey: item.key,
      payload: { digest, schema: STRUCTURED_RECORD_SCHEMA, record: item.record },
      sensitivity: 'derived_from_content' as const,
      provenance: {
        sourceId,
        connectorId: KNOW_CONNECTOR_ID,
        connectorVersion: '0.0.1',
        locator: item.key,
        observedAt: item.observedAt ?? ctx.clock.now().toISOString(),
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
  private async sync(request: SyncRequest<OrgScope>, ctx: ConnectorContext): Promise<Result<SyncOutcome, DiscoveryError>> {
    const path = request.scope.path;
    const a = await this.authorize(ctx, 'incremental_sync', READ, path);
    if (!a.ok) return a;
    const sourceId = OrgConnector.sourceId(path);
    const session = await beginAudit(ctx, {
      operation: 'incremental_sync',
      connectorId: KNOW_CONNECTOR_ID,
      connectorVersion: '0.0.1',
      permission: READ,
      scope: pathScope(path),
      allow: a.value,
      sourceId,
    });
    if (!session.ok) return session;
    const page = this.provider.pages.get(`${path}#${request.cursor ?? ''}`);
    if (page === undefined)
      return runAudited(session.value, async () =>
        err(discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'unrecognised cursor', { field: 'cursor' })),
      );
    return runAudited(session.value, async () =>
      ok({
        status: 'complete' as const,
        evidence: page.items.map((i) => this.evidence(sourceId, i, a.value, ctx)),
        skipped: { byReason: {} },
        limits: { hit: [], entriesVisited: page.items.length, elapsedMs: 0 },
        errors: [],
        ...(page.next !== undefined ? { nextCursor: page.next } : {}),
        ...(page.removed !== undefined ? { removed: page.removed } : {}),
      }),
    );
  }
}

export interface KnowledgePolicy {
  ingest: boolean;
  derive: boolean;
  query: boolean;
  review: boolean;
  read: boolean;
  /** Decides per-resource knowledge access: return true to HIDE the resource from this principal. */
  hide: (principalId: string, sourceId: string, resourceDigest: string) => boolean;
  /** When set, the authorization port throws for per-resource decisions (an outage). */
  outage: boolean;
}

export interface KnowledgeEnv {
  readonly dir: string;
  readonly store: EiStateStore;
  readonly inventory: EnvironmentInventory;
  readonly ledger: EvidenceLedger;
  readonly deps: DiscoveryDeps;
  readonly ctx: ConnectorContext;
  readonly provider: OrgProvider;
  readonly staging: EvidenceStaging;
  readonly model: KnowledgeModel;
  readonly authz: ScriptedAuthorization;
  readonly recorder: FlakyRecorder;
  readonly clock: MockClock;
  readonly policy: KnowledgePolicy;
  readonly principal: AuthenticatedPrincipal;
  readonly paths: readonly string[];
  sourceOf(path: string): SourceId;
  /** The same environment seen by ANOTHER authenticated caller (same store, ledger, audit; own principal). */
  as(principal: AuthenticatedPrincipal): ConnectorContext;
  ingest(path: string, limits?: { maxBatches?: number }): Promise<IngestionResult>;
}

export interface KnowledgeEnvOptions {
  readonly provider?: OrgProvider;
  readonly policy?: ResolutionPolicy;
  readonly paths: readonly string[];
  readonly skipDiscover?: boolean;
  readonly clock?: MockClock;
  readonly principal?: AuthenticatedPrincipal;
  readonly staging?: EvidenceStaging;
  readonly model?: KnowledgeModel;
}

export async function knowledgeEnv(base: string, options: KnowledgeEnvOptions): Promise<KnowledgeEnv> {
  const dir = join(base, 'state');
  const principal = options.principal ?? TEST_PRINCIPAL;
  const opened = await EiStateStore.open({ dir });
  if (!opened.ok) throw new Error(`state open failed: ${opened.error.code}`);
  const inventory = new EnvironmentInventory();
  const ledger = new EvidenceLedger();
  const started = await opened.value.start({ grant: await readGrant(), trust: { principal }, inventory, ledger });
  if (!started.ok) throw new Error(`state start failed: ${started.error.code}`);
  const provider = options.provider ?? new OrgProvider();
  const staging = options.staging ?? new EvidenceStaging();
  const registry = new ConnectorRegistry();
  registry.register(capturingConnector(new OrgConnector(provider), staging));
  const deps: DiscoveryDeps = { registry, inventory };
  const clock = options.clock ?? new MockClock('2026-10-30T00:00:00.000Z');
  const recorder = new FlakyRecorder(clock);
  const policy: KnowledgePolicy = { ingest: true, derive: true, query: true, review: true, read: true, hide: () => false, outage: false };
  const authz = new ScriptedAuthorization((r) => {
    if (r.operation === 'ingest_source') return policy.ingest;
    if (r.operation === 'derive_knowledge') return policy.derive;
    if (r.operation === 'review_knowledge') return policy.review;
    if (r.operation === 'query_knowledge') {
      const res = r.scope.kind === 'resource' ? r.scope.resource : '';
      const m = /\/knowledge\/evidence\/([^/]+)\/([^/]+)$/.exec(res);
      if (m !== null) {
        if (policy.outage) throw new Error('scripted authorization outage');
        return policy.query && !policy.hide(r.principal?.id ?? '', m[1] ?? '', m[2] ?? '');
      }
      return policy.query;
    }
    return policy.read;
  });
  const ctx: ConnectorContext = { clock, authorization: authz, principal, audit: recorder, ledger, state: opened.value };
  if (options.skipDiscover !== true)
    for (const path of options.paths) {
      const run = await discoverSource(deps, { sourceType: KNOW_SOURCE_TYPE, scope: scopeOf(path) }, ctx);
      if (!run.ok || run.value.record.axes.authorization !== 'granted') throw new Error(`source ${path} could not be established`);
    }
  const model = options.model ?? new KnowledgeModel(options.policy !== undefined ? { policy: options.policy } : {});
  return {
    dir,
    store: opened.value,
    inventory,
    ledger,
    deps,
    ctx,
    provider,
    staging,
    model,
    authz,
    recorder,
    clock,
    policy,
    principal,
    paths: options.paths,
    sourceOf: (p) => OrgConnector.sourceId(p),
    as: (who) => ({ ...ctx, principal: who }),
    async ingest(path, limits) {
      const r = await ingestSource(
        deps,
        {
          sourceId: OrgConnector.sourceId(path),
          kind: 'document_content',
          scope: scopeOf(path),
          ...(limits !== undefined ? { limits } : {}),
        },
        ctx,
      );
      if (!r.ok) throw new Error(`ingest failed: ${r.error.code}`);
      return r.value;
    },
  };
}

export { authenticated };
