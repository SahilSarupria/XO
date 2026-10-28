import { createHash } from 'node:crypto';
import { pathScope, toPrincipalSnapshot, type AuthenticatedPrincipal } from '@xo/permissions';
import { err, ok, type Result } from '@xo/types';
import {
  DiscoveryErrorCode,
  discoveryError,
  type AcquisitionOutcome,
  type AcquisitionRequest,
  type ConnectionValidation,
  type Connector,
  type ConnectorContext,
  type ConnectorDescriptor,
  type ConnectorOperation,
  type DetectedSource,
  type DiscoveryError,
  type DiscoveryOutcome,
  type DiscoveryRequest,
  type DiscoveryScopeBase,
  type Evidence,
  type EvidenceKind,
  type HealthReport,
  type HealthRequest,
  type SyncOutcome,
  type SyncRequest,
} from '../../src/index.js';
import { auditDenial, beginAudit, runAudited } from '../../src/audited-operation.js';
import { requireAuthorization, type TrustedAllow } from '../../src/authorization-gate.js';
import { ConnectorId, EvidenceId, SourceId, stableDigest, stableId } from '../../src/ids.js';

export const MOCK_CONNECTOR_ID = ConnectorId('xo.connector.test-mock');
export const MOCK_SOURCE_TYPE = 'x-test-mock' as const;
const LIST = 'filesystem.list';
const READ = 'filesystem.read';

export interface MockScope extends DiscoveryScopeBase {
  readonly kind: 'mock_source';
  /** An absolute, never-touched path used only as the scope the gate is asked about. */
  readonly path: string;
}

/**
 * Ways a NON-CONFORMING connector can misbehave. These exist so the framework's verification can be proven to reject them; a
 * mock built without `rogue` is an honest test double that does everything the contract requires.
 */
export type RogueBehavior =
  | 'skip_authorization' //   never asks the gate; fabricates an allow
  | 'direct_port_call' //     asks the port directly and ignores the enforcement point
  | 'list_instead_of_read' // spends the list permission where read is required
  | 'foreign_principal' //    asks the gate as a different (authenticated) principal
  | 'skip_audit' //           reads and returns without any attempt/terminal audit record
  | 'foreign_source' //       returns results naming a different source
  | 'foreign_connector'; //   claims to be a different connector

export interface MockConnectorOptions {
  readonly items?: Readonly<Record<string, string>>;
  /** Default true. When false the operation is declared `unsupported` and the method is absent. */
  readonly sync?: boolean;
  readonly health?: boolean;
  readonly rogue?: Partial<Record<ConnectorOperation, RogueBehavior>>;
  readonly otherPrincipal?: AuthenticatedPrincipal;
}

const OTHER_SOURCE = SourceId(stableId('src', [MOCK_SOURCE_TYPE, '/mock/someone-else']));

export class MockConnector implements Connector<MockScope> {
  readonly descriptor: ConnectorDescriptor;
  /** Every operation the framework actually invoked on this connector, in order. */
  readonly calls: ConnectorOperation[] = [];
  incrementalSync?: (request: SyncRequest<MockScope>, ctx: ConnectorContext) => Promise<Result<SyncOutcome, DiscoveryError>>;
  health?: (request: HealthRequest<MockScope>, ctx: ConnectorContext) => Promise<Result<HealthReport, DiscoveryError>>;
  private readonly items = new Map<string, string>();

  constructor(private readonly options: MockConnectorOptions = {}) {
    for (const [k, v] of Object.entries(options.items ?? { 'a.txt': 'alpha', 'b.txt': 'beta' })) this.items.set(k, v);
    const sync = options.sync !== false;
    const health = options.health !== false;
    this.descriptor = Object.freeze({
      id: MOCK_CONNECTOR_ID,
      version: '0.0.1',
      displayName: 'In-memory mock connector (test double)',
      sourceTypes: [MOCK_SOURCE_TYPE],
      authMethods: ['operator_scope_grant'],
      configFields: [],
      requiredPermissions: {
        detect: LIST,
        validate_connection: LIST,
        discover: LIST,
        acquire_content: READ,
        ...(sync ? { incremental_sync: READ } : {}),
        ...(health ? { health: LIST } : {}),
      },
      operations: {
        detect: 'supported',
        validate_connection: 'supported',
        discover: 'supported',
        acquire_content: 'supported',
        incremental_sync: sync ? 'supported' : 'unsupported',
        health: health ? 'supported' : 'unsupported',
      },
      evidenceKinds: ['resource_inventory', 'document_content'],
      sideEffects: 'none',
      documentation: { scope: 'An in-memory map. Test double only.', detects: ['keys'], cannotDetermine: [], limitations: ['test double'] },
    } as ConnectorDescriptor);
    if (sync) this.incrementalSync = (request, ctx) => this.doSync(request, ctx);
    if (health) this.health = (request, ctx) => this.doHealth(request, ctx);
  }

  /** Simulates a change at the source (used by sync tests). */
  append(key: string, content: string): void {
    this.items.set(key, content);
  }

  static sourceIdFor(path: string): SourceId {
    return SourceId(stableId('src', [MOCK_SOURCE_TYPE, path]));
  }

  private rogue(operation: ConnectorOperation): RogueBehavior | undefined {
    return this.options.rogue?.[operation];
  }

  private fabricated(ctx: ConnectorContext): TrustedAllow {
    return {
      decision: { effect: 'allow', reason: 'fabricated by a non-conforming connector' },
      authority: 'development_unverified',
      principal: toPrincipalSnapshot(ctx.principal as AuthenticatedPrincipal),
      grant: {},
    };
  }

  private async authorize(
    ctx: ConnectorContext,
    operation: ConnectorOperation,
    permission: string,
    path: string,
  ): Promise<Result<TrustedAllow, DiscoveryError>> {
    const rogue = this.rogue(operation);
    const scope = pathScope(path);
    if (rogue === 'skip_authorization') return ok(this.fabricated(ctx));
    if (rogue === 'direct_port_call') {
      await ctx.authorization.decide({
        connectorId: MOCK_CONNECTOR_ID,
        operation,
        permission,
        scope,
        ...(ctx.principal !== undefined ? { principal: ctx.principal } : {}),
        reason: 'direct call',
      });
      return ok(this.fabricated(ctx));
    }
    const asked = rogue === 'list_instead_of_read' ? LIST : permission;
    const principal = rogue === 'foreign_principal' ? this.options.otherPrincipal : ctx.principal;
    const decided = await requireAuthorization(ctx.authorization, {
      connectorId: MOCK_CONNECTOR_ID,
      operation,
      permission: asked,
      scope,
      ...(principal !== undefined ? { principal } : {}),
      reason: `mock ${operation}`,
    });
    if (!decided.ok) await auditDenial(ctx, { operation, connectorId: MOCK_CONNECTOR_ID, permission: asked, scope, error: decided.error });
    return decided;
  }

  private sourceFor(path: string, ctx: ConnectorContext): DetectedSource {
    return {
      sourceId: MockConnector.sourceIdFor(path),
      sourceType: MOCK_SOURCE_TYPE,
      displayName: 'mock',
      locator: path,
      detectedBy: this.rogue('detect') === 'foreign_connector' ? ConnectorId('xo.connector.someone-else') : MOCK_CONNECTOR_ID,
      detectedAt: ctx.clock.now().toISOString(),
      fingerprint: stableDigest([MOCK_SOURCE_TYPE, path]),
    };
  }

  private evidence(
    operation: ConnectorOperation,
    permission: string,
    kind: EvidenceKind,
    sourceId: SourceId,
    key: string,
    payload: Evidence['payload'],
    allow: TrustedAllow,
    ctx: ConnectorContext,
  ): Evidence {
    const named = this.rogue(operation) === 'foreign_source' ? OTHER_SOURCE : sourceId;
    return Object.freeze({
      id: EvidenceId(stableId('ev', [named, kind, key, JSON.stringify(payload)])),
      kind,
      sourceId: named,
      resourceKey: key,
      payload,
      sensitivity: kind === 'document_content' ? ('derived_from_content' as const) : ('metadata' as const),
      provenance: {
        sourceId: named,
        connectorId: MOCK_CONNECTOR_ID,
        connectorVersion: '0.0.1',
        locator: key,
        observedAt: ctx.clock.now().toISOString(),
        access: { operation, permission, authority: allow.authority, decisionReason: allow.decision.reason, principal: allow.principal },
        transformationChain: [],
      },
    });
  }

  private async audited<T extends DiscoveryOutcome | AcquisitionOutcome | SyncOutcome>(
    ctx: ConnectorContext,
    operation: 'discover' | 'acquire_content' | 'incremental_sync',
    permission: string,
    path: string,
    allow: TrustedAllow,
    requestedKeys: readonly string[] | undefined,
    run: () => Promise<Result<T, DiscoveryError>>,
  ): Promise<Result<T, DiscoveryError>> {
    if (this.rogue(operation) === 'skip_audit') return run();
    const session = await beginAudit(ctx, {
      operation,
      connectorId: MOCK_CONNECTOR_ID,
      connectorVersion: '0.0.1',
      permission,
      scope: pathScope(path),
      allow,
      sourceId: MockConnector.sourceIdFor(path),
      ...(requestedKeys !== undefined ? { requestedKeys } : {}),
    });
    if (!session.ok) return session;
    return runAudited(session.value, run);
  }

  private limits(n: number): DiscoveryOutcome['limits'] {
    return { hit: [], entriesVisited: n, elapsedMs: 0 };
  }

  async detectSource(request: DiscoveryRequest<MockScope>, ctx: ConnectorContext): Promise<Result<DetectedSource, DiscoveryError>> {
    this.calls.push('detect');
    const a = await this.authorize(ctx, 'detect', LIST, request.scope.path);
    return a.ok ? ok(this.sourceFor(request.scope.path, ctx)) : a;
  }

  async validateConnection(
    request: DiscoveryRequest<MockScope>,
    ctx: ConnectorContext,
  ): Promise<Result<ConnectionValidation, DiscoveryError>> {
    this.calls.push('validate_connection');
    const a = await this.authorize(ctx, 'validate_connection', LIST, request.scope.path);
    if (!a.ok) return a;
    return ok({
      sourceId: MockConnector.sourceIdFor(request.scope.path),
      validatedAt: ctx.clock.now().toISOString(),
      details: { readable: true },
    });
  }

  async discover(request: DiscoveryRequest<MockScope>, ctx: ConnectorContext): Promise<Result<DiscoveryOutcome, DiscoveryError>> {
    this.calls.push('discover');
    const path = request.scope.path;
    const a = await this.authorize(ctx, 'discover', LIST, path);
    if (!a.ok) return a;
    const sourceId = MockConnector.sourceIdFor(path);
    return this.audited(ctx, 'discover', LIST, path, a.value, undefined, async () => {
      const evidence = [...this.items].map(([key, content]) =>
        this.evidence('discover', LIST, 'resource_inventory', sourceId, key, { name: key, sizeBytes: content.length }, a.value, ctx),
      );
      const contentFingerprint = stableDigest([...this.items].map(([k, v]) => `${k}:${v.length}`));
      return ok({
        status: 'complete' as const,
        sources: [this.sourceFor(path, ctx)],
        scans: [{ sourceId, contentFingerprint }],
        evidence,
        skipped: { byReason: {} },
        limits: this.limits(evidence.length),
        errors: [],
      });
    });
  }

  async acquireContent(
    request: AcquisitionRequest & { readonly scope: MockScope },
    ctx: ConnectorContext,
  ): Promise<Result<AcquisitionOutcome, DiscoveryError>> {
    this.calls.push('acquire_content');
    const path = request.scope.path;
    const a = await this.authorize(ctx, 'acquire_content', READ, path);
    if (!a.ok) return a;
    const sourceId = MockConnector.sourceIdFor(path);
    if (sourceId !== request.sourceId)
      return err(
        discoveryError(DiscoveryErrorCode.SCOPE_VIOLATION, 'request names a different source than the approved scope', {
          reason: 'source_mismatch',
        }),
      );
    return this.audited(ctx, 'acquire_content', READ, path, a.value, request.resourceKeys, async () => {
      const evidence: Evidence[] = [];
      let missing = 0;
      for (const key of request.resourceKeys) {
        const content = this.items.get(key);
        if (content === undefined) {
          missing += 1;
          continue;
        }
        const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
        evidence.push(this.evidence('acquire_content', READ, 'document_content', sourceId, key, { digest, identifiers: [] }, a.value, ctx));
      }
      return ok({
        status: 'complete' as const,
        evidence,
        skipped: { byReason: missing > 0 ? { not_found: missing } : {} },
        limits: this.limits(evidence.length),
        errors: [],
      });
    });
  }

  private async doSync(request: SyncRequest<MockScope>, ctx: ConnectorContext): Promise<Result<SyncOutcome, DiscoveryError>> {
    this.calls.push('incremental_sync');
    const path = request.scope.path;
    const a = await this.authorize(ctx, 'incremental_sync', READ, path);
    if (!a.ok) return a;
    const sourceId = MockConnector.sourceIdFor(path);
    const start = request.cursor === undefined ? 0 : /^c\d{1,6}$/.test(request.cursor) ? Number(request.cursor.slice(1)) : -1;
    if (start < 0) return err(discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'unrecognised cursor', { field: 'cursor' }));
    return this.audited(ctx, 'incremental_sync', READ, path, a.value, undefined, async () => {
      const keys = [...this.items.keys()];
      const evidence = keys.slice(start).map((key) => {
        const digest = `sha256:${createHash('sha256')
          .update(this.items.get(key) ?? '')
          .digest('hex')}`;
        return this.evidence('incremental_sync', READ, 'document_content', sourceId, key, { digest, identifiers: [] }, a.value, ctx);
      });
      return ok({
        status: 'complete' as const,
        evidence,
        skipped: { byReason: {} },
        limits: this.limits(evidence.length),
        errors: [],
        nextCursor: `c${keys.length}`,
      });
    });
  }

  private async doHealth(request: HealthRequest<MockScope>, ctx: ConnectorContext): Promise<Result<HealthReport, DiscoveryError>> {
    this.calls.push('health');
    const a = await this.authorize(ctx, 'health', LIST, request.scope.path);
    if (!a.ok) return a;
    const sourceId = this.rogue('health') === 'foreign_source' ? OTHER_SOURCE : MockConnector.sourceIdFor(request.scope.path);
    return ok({ sourceId, status: 'healthy', checkedAt: ctx.clock.now().toISOString(), details: { items: this.items.size } });
  }
}
