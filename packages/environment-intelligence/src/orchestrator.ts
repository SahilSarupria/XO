import { err, ok, type Result } from '@xo/types';
import {
  MAX_SYNC_CURSOR_LENGTH,
  type AcquisitionOutcome,
  type AcquisitionRequest,
  type Connector,
  type ConnectorContext,
  type ConnectorOperation,
  type DetectedSource,
  type DiscoveryOutcome,
  type DiscoveryRequest,
  type DiscoveryScopeBase,
  type HealthReport,
  type HealthRequest,
  type SyncOutcome,
  type SyncRequest,
} from './connector.js';
import { evidenceIdentityProblem, identityMismatch, runEnforced } from './connector-enforcement.js';
import { DiscoveryErrorCode, discoveryError, internalError, type DiscoveryError } from './errors.js';
import type { Evidence } from './evidence.js';
import type { EnvironmentInventory } from './inventory.js';
import { type SourceRecord } from './inventory.js';
import { ConnectorId, type SourceId } from './ids.js';
import { resourceScope } from '@xo/permissions';
import { requireAuthenticatedPrincipal, requireAuthorization } from './authorization-gate.js';
import { planConnection, type ConnectionPlan, type ConnectorRegistry } from './registry.js';
import type { SourceEvent } from './source-state.js';
import { isStateRepresentableId, rejectedForState, requireOperationalState, trustFromContext } from './state-journal.js';

export interface DiscoveryDeps {
  readonly registry: ConnectorRegistry;
  readonly inventory: EnvironmentInventory;
}

export interface DiscoveryRun {
  readonly record: SourceRecord;
  readonly plan: ConnectionPlan;
  /** Present only when authorized discovery actually ran. */
  readonly outcome?: DiscoveryOutcome;
  /** The reason the run stopped short of acquisition, if it did. The source is still in the inventory in its honest state. */
  readonly stoppedBecause?: DiscoveryError;
  readonly evidence: readonly Evidence[];
}

/** Which lifecycle event a connector failure corresponds to. `undefined` = leave state unchanged (e.g. cancellation). */
function eventFor(error: DiscoveryError): SourceEvent | undefined {
  switch (error.code) {
    case DiscoveryErrorCode.AUTHORIZATION_REQUIRED:
    case DiscoveryErrorCode.UNAUTHENTICATED:
      return 'authorization_required';
    case DiscoveryErrorCode.AUTHORIZATION_DENIED:
      return 'authorization_denied';
    case DiscoveryErrorCode.SOURCE_UNAVAILABLE:
      return 'source_unavailable';
    case DiscoveryErrorCode.CONNECTION_FAILED:
    case DiscoveryErrorCode.INTERNAL:
      return 'connection_failed';
    default:
      return undefined;
  }
}

function applyOrFail(
  deps: DiscoveryDeps,
  sourceId: SourceId,
  event: SourceEvent,
  at: string,
  options?: { connectorId?: Connector['descriptor']['id']; error?: DiscoveryError },
): Result<SourceRecord, DiscoveryError> {
  return deps.inventory.apply(sourceId, event, at, options);
}

/**
 * Drives one source through detect -> match -> plan -> validate ->
 * discover, recording each step as its own state transition. Nothing here
 * decides authorization (the connector asks the gate, separately for each
 * operation; decisions are never cached or reused).
 *
 * ORDERING (F12): the connector's `detectSource` authorizes the caller's
 * requested scope BEFORE it touches the filesystem, and this function creates
 * an inventory record only AFTER `detectSource` succeeds. A first-contact
 * request that is denied, unauthenticated, or malformed therefore returns
 * `Result.err` with NO inventory record, no evidence, and no probing of the
 * requested path. This covers `discoverSource` only: `registerDeclaredSources`
 * is a different entry point, gated separately (see its doc comment).
 *
 * `Result.err` means no source was established (unsupported type, invalid
 * scope, denied or unauthenticated, nonexistent root after authorization).
 * `ok` with `stoppedBecause` means the source was authorized to be detected
 * and IS in the inventory, and a LATER gate (validate/discover) stopped the
 * run. Denial auditing depends on the separately designed M2.2 audit port and
 * is not implemented here.
 */
async function discoverSourceCore<TScope extends DiscoveryScopeBase>(
  deps: DiscoveryDeps,
  request: DiscoveryRequest<TScope>,
  ctx: ConnectorContext,
): Promise<Result<DiscoveryRun, DiscoveryError>> {
  // M2.1: identity first. An unauthenticated caller gets the same answer whatever it asked about (no registry,
  // inventory or filesystem lookup happens), and a discovered/detected source never stands in for a principal.
  const who = requireAuthenticatedPrincipal(ctx.principal);
  if (!who.ok) return who;
  const connector = deps.registry.findFor(request.sourceType)[0] as Connector<TScope> | undefined;
  if (connector === undefined) {
    return err(
      discoveryError(DiscoveryErrorCode.UNSUPPORTED_SOURCE, `no connector is registered for source type "${request.sourceType}"`, {
        sourceType: request.sourceType,
      }),
    );
  }
  // C1: the connector's own success is not enough. The framework must have observed the expected authorization honoured, and the
  // identity the connector claims (which connector detected it, what type it is) is checked against what the framework knows.
  const detected = await runEnforced(connector, 'detect', ctx, (c) => connector.detectSource(request, c), { audited: false });
  if (!detected.ok) return detected;
  const source = detected.value;
  if (source.detectedBy !== connector.descriptor.id || source.sourceType !== request.sourceType)
    return err(identityMismatch('detected_source'));
  const now = (): string => ctx.clock.now().toISOString();
  const connectorId = connector.descriptor.id;

  deps.inventory.observe(source, now());
  const matched = applyOrFail(deps, source.sourceId, 'connector_matched', now(), { connectorId });
  if (!matched.ok) return matched;
  const plan = planConnection(source, deps.registry, ['resource_inventory']);

  const missingConfig = connector.descriptor.configFields.filter(
    (f) => f.required && !Object.prototype.hasOwnProperty.call(request.scope, f.name),
  );
  if (missingConfig.length > 0) {
    const r = applyOrFail(deps, source.sourceId, 'connection_required', now());
    if (!r.ok) return r;
    return ok({
      record: r.value,
      plan,
      evidence: [],
      stoppedBecause: discoveryError(DiscoveryErrorCode.INVALID_SCOPE, 'required connection configuration is missing', {
        missing: missingConfig.map((f) => f.name).join(','),
      }),
    });
  }
  const configured = applyOrFail(deps, source.sourceId, 'connection_configured', now());
  if (!configured.ok) return configured;

  const stop = (error: DiscoveryError): Result<DiscoveryRun, DiscoveryError> => {
    const event = eventFor(error);
    const rec =
      event === undefined
        ? deps.inventory.get(source.sourceId)
        : applyOrFail(deps, source.sourceId, event, now(), { error }).ok
          ? deps.inventory.get(source.sourceId)
          : undefined;
    if (rec === undefined) return err(internalError(new Error('inventory record missing'), 'discoverSource'));
    return ok({ record: rec, plan, evidence: [], stoppedBecause: error });
  };

  // C1: `authorization_granted` / `connection_validated` are applied only after the framework observed the list permission being
  // spent for validation. A connector that skips authorization fails here with a typed error and the source stays unvalidated.
  const validation = await runEnforced(connector, 'validate_connection', ctx, (c) => connector.validateConnection(request, c), {
    audited: false,
  });
  if (!validation.ok) return stop(validation.error);
  if (validation.value.sourceId !== source.sourceId) return stop(identityMismatch('validated_source'));
  const granted = applyOrFail(deps, source.sourceId, 'authorization_granted', now());
  if (!granted.ok) return granted;
  const validated = applyOrFail(deps, source.sourceId, 'connection_validated', now());
  if (!validated.ok) return validated;

  const discovery = await runEnforced(connector, 'discover', ctx, (c) => connector.discover(request, c), {
    audited: true,
    sourceId: source.sourceId,
    evidenceOf: (v: DiscoveryOutcome) => v.evidence,
    expectedSourceIds: [source.sourceId],
  });
  if (!discovery.ok) {
    const e = discovery.error;
    if (
      e.code === DiscoveryErrorCode.AUTHORIZATION_REQUIRED ||
      e.code === DiscoveryErrorCode.AUTHORIZATION_DENIED ||
      e.code === DiscoveryErrorCode.AUTHORIZATION_UNVERIFIED
    )
      return stop(e);
    const failed = applyOrFail(
      deps,
      source.sourceId,
      e.code === DiscoveryErrorCode.CANCELLED ? 'acquisition_partial' : 'acquisition_failed',
      now(),
      { error: e },
    );
    if (!failed.ok) return failed;
    return ok({ record: failed.value, plan, evidence: [], stoppedBecause: e });
  }
  const outcome = discovery.value;
  const foreign =
    outcome.sources.some((s) => s.sourceId !== source.sourceId || s.detectedBy !== connectorId) ||
    outcome.scans.some((sc) => sc.sourceId !== source.sourceId)
      ? identityMismatch('discovery_source')
      : evidenceIdentityProblem(outcome.evidence, { connectorId, principal: who.value, sourceIds: [source.sourceId] });
  if (foreign !== undefined) return stop(foreign);
  for (const scan of outcome.scans) deps.inventory.recordScan(scan.sourceId, scan.contentFingerprint, now());
  const done = applyOrFail(deps, source.sourceId, outcome.status === 'complete' ? 'acquisition_succeeded' : 'acquisition_partial', now());
  if (!done.ok) return done;
  const record = deps.inventory.get(source.sourceId);
  if (record === undefined) return err(internalError(new Error('inventory record missing'), 'discoverSource'));
  return ok({ record, plan, outcome, evidence: outcome.evidence });
}

/**
 * Persists the inventory changes a core operation made, when a durable state store is configured (C0.4). Identity is checked
 * first (an unauthenticated caller learns nothing); then a non-operational store refuses the operation BEFORE anything runs
 * (no memory-only fallback); after the core ran, changed sources are journaled. A journal failure is returned as an error.
 */
async function withDurableInventory<T>(
  ctx: ConnectorContext,
  permission: string | undefined,
  run: () => Promise<Result<T, DiscoveryError>>,
  /** Optional refusal evaluated after identity and the state guard but BEFORE anything runs or is mutated. */
  precheck?: () => DiscoveryError | undefined,
): Promise<Result<T, DiscoveryError>> {
  const state = ctx.state;
  if (state === undefined) return run();
  const who = requireAuthenticatedPrincipal(ctx.principal, permission);
  if (!who.ok) return who;
  const guard = requireOperationalState(ctx);
  if (!guard.ok) return guard;
  const refused = precheck?.();
  if (refused !== undefined) return err(refused);
  const result = await run();
  const trust = trustFromContext(ctx);
  if (trust === undefined) return result;
  const synced = await state.syncInventory(trust);
  if (!synced.ok) return synced;
  return result;
}

/** Drives one source through detect -> match -> plan -> validate -> discover; see `discoverSourceCore`. With a durable state store the touched inventory is journaled afterwards. */
export async function discoverSource<TScope extends DiscoveryScopeBase>(
  deps: DiscoveryDeps,
  request: DiscoveryRequest<TScope>,
  ctx: ConnectorContext,
): Promise<Result<DiscoveryRun, DiscoveryError>> {
  return withDurableInventory(ctx, undefined, () => discoverSourceCore(deps, request, ctx));
}

/** Provisional bound on one declaration call (pure check, before any authorization or record). */
export const MAX_DECLARED_SOURCES_PER_CALL = 500;

/**
 * The authorization the declaration path asks for. PROVISIONAL: `data.write`
 * on the resource `environment-intelligence/inventory` reuses the existing
 * closed permission vocabulary (adding a permission id is a P1.0 owner
 * decision). Declaring a system writes to the inventory; it is not a read of
 * the declared system. Needs P1.0 owner confirmation.
 */
export const DECLARE_SOURCES_PERMISSION = 'data.write';
export const DECLARE_SOURCES_RESOURCE = 'environment-intelligence/inventory';
const DECLARE_SOURCES_CONNECTOR = ConnectorId('xo.environment-intelligence');

/**
 * Registers sources that were declared rather than detected by a connector
 * (an administrator-provided application inventory, a future cloud API
 * listing). They enter the inventory as `detected`, are matched against
 * the registry, and - if no connector exists - are honestly marked
 * `unsupported_or_inaccessible`. Declaring a system grants nothing.
 *
 * AUTHORIZATION (F2/M2.1): inventory writes are gated. After a pure size
 * bound, ONE decision is requested for the whole call through the same
 * enforcement point as the connectors (`requireAuthorization`), so a
 * caller-forged decision is not honoured. Records are created only after an
 * allow; a denial returns `err` and creates nothing. A declaration that would replace a record established by a
 * different connector or source type is refused for the whole call. The timestamp comes from
 * the injected clock, not the caller. The caller-supplied `DetectedSource`
 * values are data, never proof of permission.
 */
export async function registerDeclaredSources(
  deps: DiscoveryDeps,
  sources: readonly DetectedSource[],
  ctx: ConnectorContext,
): Promise<Result<readonly SourceRecord[], DiscoveryError>> {
  return withDurableInventory(
    ctx,
    DECLARE_SOURCES_PERMISSION,
    () => registerDeclaredSourcesCore(deps, sources, ctx),
    // A source the journal cannot key must never enter the inventory: it could not be persisted and would wedge every later sync.
    () => (sources.every((s) => isStateRepresentableId(s?.sourceId)) ? undefined : rejectedForState('inventory')),
  );
}

async function registerDeclaredSourcesCore(
  deps: DiscoveryDeps,
  sources: readonly DetectedSource[],
  ctx: ConnectorContext,
): Promise<Result<readonly SourceRecord[], DiscoveryError>> {
  const who = requireAuthenticatedPrincipal(ctx.principal, DECLARE_SOURCES_PERMISSION);
  if (!who.ok) return who;
  if (sources.length > MAX_DECLARED_SOURCES_PER_CALL) {
    return err(
      discoveryError(DiscoveryErrorCode.LIMIT_EXCEEDED, `at most ${MAX_DECLARED_SOURCES_PER_CALL} sources can be declared per call`, {
        limit: MAX_DECLARED_SOURCES_PER_CALL,
      }),
    );
  }
  const gate = await requireAuthorization(ctx.authorization, {
    connectorId: DECLARE_SOURCES_CONNECTOR,
    operation: 'declare_sources',
    permission: DECLARE_SOURCES_PERMISSION,
    scope: resourceScope(DECLARE_SOURCES_RESOURCE),
    ...(ctx.principal !== undefined ? { principal: ctx.principal } : {}),
    reason: 'register administrator-declared sources in the environment inventory',
  });
  if (!gate.ok) return gate;
  // Integrity: a declaration may repeat-observe its OWN earlier declaration, but never replace a record that a
  // different connector or source type established (`observe` overwrites the stored source). Checked for the whole
  // call before anything is written, so a conflicting call is atomic: it writes nothing.
  for (const source of sources) {
    const existing = deps.inventory.get(source.sourceId);
    if (existing !== undefined && (existing.source.detectedBy !== source.detectedBy || existing.source.sourceType !== source.sourceType)) {
      return err(discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'a declared source conflicts with an existing inventory record', {}));
    }
  }
  const at = ctx.clock.now().toISOString();
  const records: SourceRecord[] = [];
  for (const source of sources) {
    deps.inventory.observe(source, at);
    const connector = deps.registry.findFor(source.sourceType)[0];
    const applied =
      connector === undefined
        ? deps.inventory.apply(source.sourceId, 'connector_missing', at)
        : deps.inventory.apply(source.sourceId, 'connector_matched', at, { connectorId: connector.descriptor.id });
    if (applied.ok) records.push(applied.value);
  }
  return ok(records);
}

/**
 * Shared preconditions of every operation that reads protected content from an already-validated source (acquire, sync, health).
 * Identity first (so an unauthenticated caller cannot learn which sources exist), then the durable-state guard, then the inventory:
 * the source must be matched to a registered connector that DECLARES the operation, and its axes must show authorization granted
 * and connection validated. A revoked or denied source therefore blocks every one of them, for every connector.
 */
function resolveProtectedSource<TScope extends DiscoveryScopeBase>(
  deps: DiscoveryDeps,
  sourceId: SourceId,
  operation: ConnectorOperation,
  unsupportedMessage: string,
  ctx: ConnectorContext,
): Result<{ readonly connector: Connector<TScope>; readonly principal: NonNullable<ConnectorContext['principal']> }, DiscoveryError> {
  const who = requireAuthenticatedPrincipal(ctx.principal);
  if (!who.ok) return who;
  const stateGuard = requireOperationalState(ctx);
  if (!stateGuard.ok) return stateGuard;
  const record = deps.inventory.get(sourceId);
  if (record === undefined || record.connectorId === undefined) {
    return err(discoveryError(DiscoveryErrorCode.INVALID_TRANSITION, 'source is not in the inventory or has no matched connector', {}));
  }
  if (record.axes.authorization !== 'granted' || record.axes.connection !== 'validated') {
    return err(
      discoveryError(DiscoveryErrorCode.AUTHORIZATION_REQUIRED, 'the source has not been authorized and validated', {
        status: record.status,
      }),
    );
  }
  const connector = deps.registry.get(record.connectorId) as Connector<TScope> | undefined;
  if (connector === undefined)
    return err(discoveryError(DiscoveryErrorCode.UNSUPPORTED_SOURCE, 'matched connector is no longer registered'));
  if (connector.descriptor.operations[operation] !== 'supported') {
    return err(discoveryError(DiscoveryErrorCode.UNSUPPORTED_OPERATION, unsupportedMessage, { connector: connector.descriptor.id }));
  }
  return ok({ connector, principal: ctx.principal as NonNullable<ConnectorContext['principal']> });
}

/**
 * Content acquisition for already-validated sources. Separately gated: the
 * connector asks the authorization gate for a read permission distinct from
 * the listing permission. A denial here does not alter the source's base
 * lifecycle (listing still succeeded); it is returned to the caller.
 *
 * M2.1: a source that was detected, listed and validated is only a CANDIDATE.
 * `axes.authorization === 'granted'` records that LISTING was authorized; it
 * never stands in for the read decision, which the connector requests again,
 * for `filesystem.read`, bound to this caller and this scope.
 *
 * C1: the framework verifies that the READ permission (not the list permission) was spent for this call and that an accepted
 * attempt and terminal audit record exist, before the result is returned (`runEnforced`).
 */
export async function acquireSourceContent<TScope extends DiscoveryScopeBase>(
  deps: DiscoveryDeps,
  request: AcquisitionRequest & { readonly scope: TScope },
  ctx: ConnectorContext,
): Promise<Result<AcquisitionOutcome, DiscoveryError>> {
  const resolved = resolveProtectedSource<TScope>(
    deps,
    request.sourceId,
    'acquire_content',
    'connector does not support content acquisition',
    ctx,
  );
  if (!resolved.ok) return resolved;
  const { connector } = resolved.value;
  const who = requireAuthenticatedPrincipal(ctx.principal);
  if (!who.ok) return who;
  const outcome = await runEnforced(connector, 'acquire_content', ctx, (c) => connector.acquireContent(request, c), {
    audited: true,
    sourceId: request.sourceId,
    evidenceOf: (v: AcquisitionOutcome) => v.evidence,
    expectedSourceIds: [request.sourceId],
  });
  return outcome;
}

const SYNC_CURSOR = /^[\x21-\x7e]+$/;
const validCursor = (cursor: unknown): boolean =>
  typeof cursor === 'string' && cursor.length >= 1 && cursor.length <= MAX_SYNC_CURSOR_LENGTH && SYNC_CURSOR.test(cursor);

/**
 * C1 - incremental synchronization, for connectors that DECLARE `incremental_sync: 'supported'` (none of the shipped ones do; the
 * filesystem connector stays unsupported). Gated exactly like acquisition: the source must be authorized and validated (a revoked
 * source is refused), the connector must spend its declared sync permission, and an accepted attempt and terminal audit record must
 * exist before the result is returned. The cursor is opaque, bounded and NOT persisted by Environment Intelligence in C1: the caller
 * holds it, and replaying the same cursor must give the same result.
 */
export async function syncSource<TScope extends DiscoveryScopeBase>(
  deps: DiscoveryDeps,
  request: SyncRequest<TScope>,
  ctx: ConnectorContext,
): Promise<Result<SyncOutcome, DiscoveryError>> {
  const resolved = resolveProtectedSource<TScope>(
    deps,
    request.sourceId,
    'incremental_sync',
    'connector does not support incremental sync',
    ctx,
  );
  if (!resolved.ok) return resolved;
  const { connector } = resolved.value;
  const who = requireAuthenticatedPrincipal(ctx.principal);
  if (!who.ok) return who;
  if (request.cursor !== undefined && !validCursor(request.cursor))
    return err(discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'the sync cursor is not acceptable', { field: 'cursor' }));
  if (connector.incrementalSync === undefined) {
    return err(
      discoveryError(DiscoveryErrorCode.UNSUPPORTED_OPERATION, 'connector does not support incremental sync', {
        connector: connector.descriptor.id,
      }),
    );
  }
  const sync = connector.incrementalSync.bind(connector);
  const outcome = await runEnforced(connector, 'incremental_sync', ctx, (c) => sync(request, c), {
    audited: true,
    sourceId: request.sourceId,
    evidenceOf: (v: SyncOutcome) => v.evidence,
    expectedSourceIds: [request.sourceId],
  });
  if (!outcome.ok) return outcome;
  if (outcome.value.nextCursor !== undefined && !validCursor(outcome.value.nextCursor))
    return err(
      discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'the connector returned a cursor that is not acceptable', { field: 'nextCursor' }),
    );
  return outcome;
}

/**
 * C1 - health probe, for connectors that DECLARE `health: 'supported'` (none of the shipped ones do). A probe is itself an
 * authorized operation, so it is gated like acquisition (an authorized, validated source; the declared permission spent) and keeps
 * denial-only audit like detect/validate. It returns no evidence and changes no source state in C1.
 */
export async function checkSourceHealth<TScope extends DiscoveryScopeBase>(
  deps: DiscoveryDeps,
  request: HealthRequest<TScope>,
  ctx: ConnectorContext,
): Promise<Result<HealthReport, DiscoveryError>> {
  const resolved = resolveProtectedSource<TScope>(deps, request.sourceId, 'health', 'connector does not support health checks', ctx);
  if (!resolved.ok) return resolved;
  const { connector } = resolved.value;
  if (connector.health === undefined) {
    return err(
      discoveryError(DiscoveryErrorCode.UNSUPPORTED_OPERATION, 'connector does not support health checks', {
        connector: connector.descriptor.id,
      }),
    );
  }
  const probe = connector.health.bind(connector);
  const report = await runEnforced(connector, 'health', ctx, (c) => probe(request, c), { audited: false });
  if (!report.ok) return report;
  if (report.value.sourceId !== request.sourceId) return err(identityMismatch('health_source'));
  return report;
}
