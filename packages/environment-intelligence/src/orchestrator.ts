import { err, ok, type Result } from '@xo/types';
import type {
  AcquisitionOutcome,
  AcquisitionRequest,
  Connector,
  ConnectorContext,
  DetectedSource,
  DiscoveryOutcome,
  DiscoveryRequest,
  DiscoveryScopeBase,
} from './connector.js';
import { DiscoveryErrorCode, discoveryError, internalError, type DiscoveryError } from './errors.js';
import type { Evidence } from './evidence.js';
import type { EnvironmentInventory } from './inventory.js';
import { type SourceRecord } from './inventory.js';
import { ConnectorId, type SourceId } from './ids.js';
import { resourceScope } from '@xo/permissions';
import { requireAuthenticatedPrincipal, requireAuthorization } from './authorization-gate.js';
import { planConnection, type ConnectionPlan, type ConnectorRegistry } from './registry.js';
import type { SourceEvent } from './source-state.js';

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
export async function discoverSource<TScope extends DiscoveryScopeBase>(
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
  const detected = await connector.detectSource(request, ctx);
  if (!detected.ok) return detected;
  const source = detected.value;
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

  const validation = await connector.validateConnection(request, ctx);
  if (!validation.ok) return stop(validation.error);
  const granted = applyOrFail(deps, source.sourceId, 'authorization_granted', now());
  if (!granted.ok) return granted;
  const validated = applyOrFail(deps, source.sourceId, 'connection_validated', now());
  if (!validated.ok) return validated;

  const discovery = await connector.discover(request, ctx);
  if (!discovery.ok) {
    const e = discovery.error;
    if (e.code === DiscoveryErrorCode.AUTHORIZATION_REQUIRED || e.code === DiscoveryErrorCode.AUTHORIZATION_DENIED) return stop(e);
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
  for (const scan of outcome.scans) deps.inventory.recordScan(scan.sourceId, scan.contentFingerprint, now());
  const done = applyOrFail(deps, source.sourceId, outcome.status === 'complete' ? 'acquisition_succeeded' : 'acquisition_partial', now());
  if (!done.ok) return done;
  const record = deps.inventory.get(source.sourceId);
  if (record === undefined) return err(internalError(new Error('inventory record missing'), 'discoverSource'));
  return ok({ record, plan, outcome, evidence: outcome.evidence });
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
 * Content acquisition for already-validated sources. Separately gated: the
 * connector asks the authorization gate for a read permission distinct from
 * the listing permission. A denial here does not alter the source's base
 * lifecycle (listing still succeeded); it is returned to the caller.
 *
 * M2.1: a source that was detected, listed and validated is only a CANDIDATE.
 * `axes.authorization === 'granted'` records that LISTING was authorized; it
 * never stands in for the read decision, which the connector requests again,
 * for `filesystem.read`, bound to this caller and this scope.
 */
export async function acquireSourceContent<TScope extends DiscoveryScopeBase>(
  deps: DiscoveryDeps,
  request: AcquisitionRequest & { readonly scope: TScope },
  ctx: ConnectorContext,
): Promise<Result<AcquisitionOutcome, DiscoveryError>> {
  // M2.1: identity before any inventory lookup, so an unauthenticated caller cannot learn which sources exist.
  const who = requireAuthenticatedPrincipal(ctx.principal);
  if (!who.ok) return who;
  const record = deps.inventory.get(request.sourceId);
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
  if (connector.descriptor.operations.acquire_content !== 'supported') {
    return err(
      discoveryError(DiscoveryErrorCode.UNSUPPORTED_OPERATION, 'connector does not support content acquisition', {
        connector: connector.descriptor.id,
      }),
    );
  }
  return connector.acquireContent(request, ctx);
}
