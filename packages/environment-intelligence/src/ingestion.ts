import { createHash } from 'node:crypto';
import { resourceScope, type Principal } from '@xo/permissions';
import { err, ok, type Result } from '@xo/types';
import { auditDenial, beginAudit } from './audited-operation.js';
import { requireAuthenticatedPrincipal, requireAuthorization } from './authorization-gate.js';
import type { Connector, ConnectorContext, DiscoveryScopeBase, RemovedResource, SyncOutcome, SyncRequest } from './connector.js';
import { DiscoveryErrorCode, discoveryError, internalError, type DiscoveryError } from './errors.js';
import type { Evidence, EvidenceKind } from './evidence.js';
import { ConnectorId, stableDigest, type EvidenceId, type SourceId } from './ids.js';
import { syncSource, type DiscoveryDeps } from './orchestrator.js';
import {
  isPersistableCursor,
  isStateRepresentableId,
  requireOperationalState,
  trustFromContext,
  type RetireReason,
} from './state-journal.js';

/**
 * C4 - provider-independent ingestion and incremental synchronization.
 *
 * AUTHORITY BOUNDARIES (kept separate, never inferred from one another):
 *   1. source access   - the connection is validated and the source's authorization axis is `granted` (C1/C3);
 *   2. content read    - the connector spends its own `incremental_sync` permission for each batch (C1, framework-verified);
 *   3. ingestion       - THIS module's own decision, `data.write` on `environment-intelligence/ingestion/<sourceId>`, requested
 *                        for EVERY batch and audited (write-ahead attempt + terminal) around the checkpoint commit;
 *   4. action          - not part of C4 and not reachable from here (EI never executes business actions).
 * A connection, a validated source or a granted read therefore never implies permission to ingest, and the principal and scope of
 * each call are the ones the decision was made for.
 *
 * DURABILITY: ingestion REQUIRES a started `EiStateStore`. A checkpoint that dies with the process is not a checkpoint, so there is no
 * memory-only mode: without a durable store the call is refused (`EI_STATE_UNAVAILABLE`).
 *
 * CHECKPOINTS: the cursor is untrusted provider data. It is never taken from the caller (there is no cursor field on the request), is
 * persisted only after the batch was accepted and the retirements were journaled, never advances on any failure, and is bound by a
 * digest to source + connector + authenticated principal + evidence kind + scope. A different principal or scope therefore has a
 * separate checkpoint chain; it can neither read nor advance this one.
 *
 * LIMITATIONS (documented, not hidden):
 *  - CRASH WINDOW. A connector releases its evidence in its OWN completion audit, BEFORE EI journals the checkpoint. A crash in
 *    between leaves that evidence released (it WAS authorized and audited) but un-indexed, and a version that batch would have
 *    superseded stays eligible until the next `ingestSource` replays the cursor (idempotent; the crash tests prove the replay reaches
 *    the uninterrupted end state). It cannot be closed inside C4: quarantining only the un-indexed new version on recovery would leave
 *    the STALE one eligible, which is worse. Closing it needs a two-phase release in the Connector contract (stage, then release
 *    on commit) and is deliberately left as a contract-change decision.
 *  - TERMINAL AUDIT. If only the terminal audit record is refused after the checkpoint committed, the caller gets the audit error with
 *    `context.committed = true`; the batch is not reported as ingested, and re-running is a no-op.
 *  - CURSORS must be persistable: the journal's `id` alphabet (`[A-Za-z0-9._:@+-]`), at most 200 characters, and free of secret-like
 *    content. A connector whose provider cursor is richer (base64 `=`, URLs) must return an opaque handle it can map back itself;
 *    anything else is refused (`cursor_not_persistable`) and the batch is contained.
 *  - TIMEOUT. A read that overruns its budget is abandoned. If it later completes, its evidence is contained (never checkpointed).
 *  - PERMISSION. The ingestion decision reuses the platform's `data.write` (the same provisional choice as every other EI lifecycle
 *    operation), distinguished by its own operation (`ingest_source`) and per-source resource. A dedicated catalog permission is a
 *    change to the shared `@xo/permissions` catalog and was not made here.
 *  - JOURNAL COMPATIBILITY. Older builds cannot read a journal containing C4 records; they fail closed rather than guess.
 */
export const INGEST_PERMISSION = 'data.write';
export const INGEST_RESOURCE = 'environment-intelligence/ingestion';
const INGEST_CONNECTOR = ConnectorId('xo.environment-intelligence');

/** Hard ceilings (a journal record holds at most this many pairs). Requested limits are clamped to them, never raised. */
export const MAX_INGESTION_BATCH_ITEMS = 5000;
export const MAX_INGESTION_BATCHES = 1000;
export const MAX_INGESTION_RESOURCE_KEY = 1024;

export interface IngestionLimits {
  /** Batches processed by one `ingestSource` call. Reaching it ends the call with `more_available`. */
  readonly maxBatches: number;
  /** Evidence items one batch may carry. A larger batch is discarded (contained), not truncated. */
  readonly maxEvidencePerBatch: number;
  /** Removal entries one batch may carry. */
  readonly maxRemovedPerBatch: number;
  /** Wall-clock budget of ONE batch. */
  readonly batchTimeoutMs: number;
}

export const DEFAULT_INGESTION_LIMITS: IngestionLimits = Object.freeze({
  maxBatches: 100,
  maxEvidencePerBatch: 1000,
  maxRemovedPerBatch: 1000,
  batchTimeoutMs: 60_000,
});

export interface IngestionRequest<TScope extends DiscoveryScopeBase = DiscoveryScopeBase> {
  readonly sourceId: SourceId;
  readonly kind: EvidenceKind;
  readonly scope: TScope;
  readonly limits?: Partial<IngestionLimits>;
}

/** Provenance of one ingested item. Content is never included: only identifiers, digests and times. */
export interface IngestedItem {
  readonly evidenceId: EvidenceId;
  readonly resourceDigest: string;
  readonly sourceId: SourceId;
  readonly connectorId: string;
  readonly connectorVersion: string;
  readonly principal: Principal;
  readonly scopeDigest: string;
  /** The cursor this batch was read from (absent = from the beginning) and the one it produced. */
  readonly cursorBefore?: string;
  readonly cursorAfter?: string;
  readonly observedAt: string;
  readonly ingestedAt: string;
  readonly contentHash: string;
  /** Audit operation id of the ingestion batch that committed it. */
  readonly operationId: string;
}

export interface RetiredItem {
  readonly evidenceId: EvidenceId;
  readonly resourceDigest: string;
  readonly reason: RetireReason;
}

export interface IngestionCheckpoint {
  readonly seq: number;
  readonly cursor?: string;
  readonly complete: boolean;
  /** Provenance digest of the batch that produced this checkpoint (`provenanceDigestOf` of that batch's items). */
  readonly provenance?: string;
}

export type IngestionStatus = 'caught_up' | 'more_available' | 'partial' | 'stopped';

export interface IngestionResult {
  readonly sourceId: SourceId;
  readonly binding: string;
  readonly status: IngestionStatus;
  /** Batches that were COMMITTED (a batch that failed is not counted). */
  readonly batches: number;
  readonly items: readonly IngestedItem[];
  readonly retired: readonly RetiredItem[];
  readonly checkpoint?: IngestionCheckpoint;
  /** Why the run stopped early, when it did. Earlier committed batches stand; the checkpoint is the last good one. */
  readonly stoppedBecause?: DiscoveryError;
  /** True when authorization loss was observed and the source was marked revoked. */
  readonly sourceRevoked: boolean;
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x !== null && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );

/** Digest of a scope. The scope itself (which may be a host path) is never persisted. */
export function ingestionScopeDigest(scope: unknown): string | undefined {
  try {
    const text = canonical(scope);
    return text === undefined ? undefined : stableDigest(['ei-ingest-scope-v1', text]);
  } catch {
    return undefined;
  }
}

/** The checkpoint binding: source + connector + authenticated principal + evidence kind + scope. */
export function ingestionBinding(args: {
  sourceId: string;
  connectorId: string;
  principal: Principal;
  kind: string;
  scopeDigest: string;
}): string {
  return stableDigest([
    'ei-ingest-binding-v1',
    args.sourceId,
    args.connectorId,
    args.principal.kind,
    args.principal.id,
    args.principal.orgId ?? '',
    args.kind,
    args.scopeDigest,
  ]);
}

/** Digest of one resource of a source. The resource key is untrusted provider data and is only ever digested. */
export const resourceDigestOf = (sourceId: string, kind: string, resourceKey: string): string =>
  stableDigest(['ei-ingest-resource-v1', sourceId, kind, resourceKey]).slice(0, 24);

function contentHashOf(e: Evidence): string {
  const d = e.payload['digest'];
  if (typeof d === 'string' && /^sha256:[0-9a-f]{64}$/.test(d)) return d;
  return `sha256:${createHash('sha256').update(canonical(e.payload)).digest('hex')}`;
}

/**
 * Digest over the provenance of ONE batch's items (evidence id, resource digest, content hash, cursors, observation time). It is
 * persisted with the checkpoint, so the provenance returned to a caller can be verified against the durable journal later without
 * the journal ever storing per-item provenance.
 */
export function provenanceDigestOf(items: readonly IngestedItem[]): string {
  return stableDigest([
    'ei-ingest-provenance-v1',
    ...items.map((i) =>
      [
        i.evidenceId,
        i.resourceDigest,
        i.contentHash,
        i.connectorId,
        i.connectorVersion,
        i.scopeDigest,
        i.cursorBefore ?? '',
        i.cursorAfter ?? '',
        i.observedAt,
      ].join('|'),
    ),
  ]);
}

const validResourceKey = (k: unknown): k is string =>
  typeof k === 'string' && k.length >= 1 && k.length <= MAX_INGESTION_RESOURCE_KEY && !k.includes('\u0000');

function resolveLimits(requested: Partial<IngestionLimits> | undefined): Result<IngestionLimits, DiscoveryError> {
  const merged = { ...DEFAULT_INGESTION_LIMITS, ...(requested ?? {}) };
  const ok1 = (n: number, max: number): boolean => Number.isSafeInteger(n) && n >= 1 && n <= max;
  if (
    !ok1(merged.maxBatches, MAX_INGESTION_BATCHES) ||
    !ok1(merged.maxEvidencePerBatch, MAX_INGESTION_BATCH_ITEMS) ||
    !ok1(merged.maxRemovedPerBatch, MAX_INGESTION_BATCH_ITEMS) ||
    !ok1(merged.batchTimeoutMs, 3_600_000)
  )
    return err(discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'the ingestion limits are not acceptable', { field: 'limits' }));
  return ok(Object.freeze(merged));
}

type Deadline<T> = { readonly timedOut: true; readonly late: Promise<T> } | { readonly timedOut: false; readonly value: T };

/** Runs `run` with a deadline and the caller's cancellation. A late result of an abandoned run is ignored. */
async function withDeadline<T>(
  ms: number,
  parent: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<Deadline<T>> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const onParent = (): void => controller.abort();
  if (parent?.aborted === true) controller.abort();
  parent?.addEventListener('abort', onParent, { once: true });
  let running: Promise<{ timedOut: false; value: T }>;
  const timeout = new Promise<{ timedOut: true; late: Promise<T> }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ timedOut: true, late: running.then((r) => r.value) });
    }, ms);
  });
  running = run(controller.signal).then((value) => ({ timedOut: false as const, value }));
  running.catch(() => undefined);
  try {
    return await Promise.race([running, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parent?.removeEventListener('abort', onParent);
  }
}

// ── one batch ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface BatchDone {
  readonly status: 'complete' | 'partial';
  /** Present only to satisfy the audit session's completion shape; ingestion releases nothing (the connector's own audit did). */
  readonly evidence: readonly Evidence[];
  readonly skipped: { readonly byReason: Readonly<Record<string, number>> };
  readonly errors: readonly DiscoveryError[];
  readonly limits: { readonly hit: readonly string[] };
  readonly items: readonly IngestedItem[];
  readonly retired: readonly RetiredItem[];
  readonly checkpoint: IngestionCheckpoint;
  /** True when this batch ended the pass (caught up, or no further progress was possible). */
  readonly done: boolean;
}

interface BatchEnv<TScope extends DiscoveryScopeBase> {
  readonly deps: DiscoveryDeps;
  readonly request: IngestionRequest<TScope>;
  readonly ctx: ConnectorContext;
  readonly principal: Principal;
  readonly limits: IngestionLimits;
  readonly scopeDigest: string;
}

const lossCodes: ReadonlySet<string> = new Set([DiscoveryErrorCode.AUTHORIZATION_DENIED, DiscoveryErrorCode.AUTHORIZATION_UNVERIFIED]);

async function ingestOneBatch<TScope extends DiscoveryScopeBase>(
  env: BatchEnv<TScope>,
): Promise<Result<{ done: BatchDone; binding: string }, DiscoveryError>> {
  const { deps, request, ctx, principal, limits } = env;
  const state = ctx.state;
  const trust = trustFromContext(ctx);
  // (type-narrowing guard: `ingestSource` already refuses a missing store with the identical error, so this is not an independent enforcement)
  if (state === undefined || trust === undefined)
    return err(
      discoveryError(DiscoveryErrorCode.STATE_UNAVAILABLE, 'ingestion requires a durable lifecycle state store', {
        phase: 'ingestion',
        outcome: 'config',
      }),
    );
  const guard = requireOperationalState(ctx);
  if (!guard.ok) return guard;
  const caller = ctx.principal;
  if (caller === undefined)
    return err(
      discoveryError(DiscoveryErrorCode.UNAUTHENTICATED, 'an authenticated principal is required', {
        permission: INGEST_PERMISSION,
        authority: 'none',
      }),
    );

  // Boundary 3: the INGESTION decision. Asked for every batch, before the source is even looked up, so a caller without it learns nothing.
  const scope = resourceScope(`${INGEST_RESOURCE}/${request.sourceId}`);
  const gate = await requireAuthorization(ctx.authorization, {
    connectorId: INGEST_CONNECTOR,
    operation: 'ingest_source',
    permission: INGEST_PERMISSION,
    scope,
    principal: caller,
    reason: 'ingest one batch of source content into environment evidence',
  });
  // ENFORCE:ingest-decision-gate
  if (!gate.ok) {
    await auditDenial(ctx, {
      operation: 'ingest_source',
      connectorId: INGEST_CONNECTOR,
      permission: INGEST_PERMISSION,
      scope,
      error: gate.error,
    });
    return gate;
  }

  // Boundary 1: source access. The source must be matched, validated and still authorized.
  const record = deps.inventory.get(request.sourceId);
  if (record === undefined || record.connectorId === undefined)
    return err(discoveryError(DiscoveryErrorCode.INVALID_TRANSITION, 'source is not in the inventory or has no matched connector', {}));
  // ENFORCE:source-authorized
  if (record.axes.authorization !== 'granted' || record.axes.connection !== 'validated')
    return err(
      discoveryError(DiscoveryErrorCode.AUTHORIZATION_REQUIRED, 'the source has not been authorized and validated', {
        status: record.status,
      }),
    );
  const connector = deps.registry.get(record.connectorId) as Connector<TScope> | undefined;
  if (connector === undefined)
    return err(discoveryError(DiscoveryErrorCode.UNSUPPORTED_SOURCE, 'matched connector is no longer registered'));
  // ENFORCE:connector-supports-sync
  if (connector.descriptor.operations.incremental_sync !== 'supported')
    return err(
      discoveryError(DiscoveryErrorCode.UNSUPPORTED_OPERATION, 'connector does not support incremental sync', {
        connector: connector.descriptor.id,
      }),
    );

  const binding = ingestionBinding({
    sourceId: request.sourceId,
    connectorId: connector.descriptor.id,
    principal,
    kind: request.kind,
    scopeDigest: env.scopeDigest,
  });
  const checkpoint = state.checkpointOf(binding);
  const cursorBefore = checkpoint?.cursor;
  const expectedSeq = checkpoint?.seq ?? 0;

  const session = await beginAudit(ctx, {
    operation: 'ingest_source',
    connectorId: INGEST_CONNECTOR,
    connectorVersion: '1',
    permission: INGEST_PERMISSION,
    scope,
    allow: gate.value,
    sourceId: request.sourceId,
  });
  if (!session.ok) return session;
  const operationId = session.value.operationId;

  const work = async (): Promise<Result<BatchDone, DiscoveryError>> => {
    const syncRequest: SyncRequest<TScope> = {
      sourceId: request.sourceId,
      kind: request.kind,
      scope: request.scope,
      ...(cursorBefore !== undefined ? { cursor: cursorBefore } : {}),
    };
    const ran = await withDeadline(limits.batchTimeoutMs, ctx.signal, (signal) => syncSource(deps, syncRequest, { ...ctx, signal }));
    // ENFORCE:batch-timeout
    if (ran.timedOut) {
      // The abandoned read may still finish and have its evidence released by the connector's own audit. It was never checkpointed,
      // so when it lands it is contained (evidence an earlier committed batch already owns is left alone).
      void ran.late
        .then(async (late) => {
          // ENFORCE:late-result-contained
          if (late.ok) await containBatch(env, trust, late.value.evidence);
        })
        .catch(() => undefined);
      return err(
        discoveryError(DiscoveryErrorCode.LIMIT_EXCEEDED, 'the batch exceeded its time budget and was discarded', {
          limit: 'batch_timeout',
        }),
      );
    }
    const synced = ran.value;
    if (!synced.ok) {
      // Authorization LOSS (an explicit denial, or a result the framework could not verify): mark the source revoked, keep the last good checkpoint.
      // ENFORCE:loss-marks-revoked
      if (lossCodes.has(synced.error.code)) await markRevoked(env, trust);
      return synced;
    }
    const out: SyncOutcome = synced.value;
    const contain = (): Promise<void> => containBatch(env, trust, out.evidence);
    const reject = async (error: DiscoveryError): Promise<Result<BatchDone, DiscoveryError>> => {
      await contain();
      return err(error);
    };

    // Size and shape, checked BEFORE anything is committed. An oversized or malformed batch is discarded whole, never truncated.
    const removed: readonly RemovedResource[] = out.removed ?? [];
    if (!Array.isArray(out.evidence) || !Array.isArray(removed))
      return reject(discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'the batch is not well formed', { reason: 'shape' }));
    // ENFORCE:batch-size-limit
    if (out.evidence.length > limits.maxEvidencePerBatch || removed.length > limits.maxRemovedPerBatch)
      return reject(
        discoveryError(DiscoveryErrorCode.LIMIT_EXCEEDED, 'the batch exceeds the configured size limit', { limit: 'batch_size' }),
      );
    // ENFORCE:cursor-persistable
    if (out.nextCursor !== undefined && !isPersistableCursor(out.nextCursor))
      return reject(
        discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'the cursor cannot be persisted as a checkpoint', {
          field: 'nextCursor',
          reason: 'cursor_not_persistable',
        }),
      );

    const sourceId = request.sourceId as string;
    const byResource = new Map<string, Evidence[]>();
    for (const e of out.evidence) {
      // ENFORCE:item-acceptable
      if (e.kind !== request.kind || !validResourceKey(e.resourceKey))
        return reject(discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'a batch item is not acceptable', { reason: 'item' }));
      const rd = resourceDigestOf(sourceId, request.kind, e.resourceKey);
      byResource.set(rd, [...(byResource.get(rd) ?? []), e]);
    }
    const removals = new Map<string, RemovedResource['reason']>();
    for (const r of removed) {
      // ENFORCE:removal-acceptable
      if (r === null || typeof r !== 'object' || !validResourceKey(r.resourceKey) || (r.reason !== 'deleted' && r.reason !== 'access_lost'))
        return reject(discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'a removal entry is not acceptable', { reason: 'removed' }));
      const rd = resourceDigestOf(sourceId, request.kind, r.resourceKey);
      // A resource cannot be both present and gone in one batch: contradictory provider data is refused, not interpreted.
      // ENFORCE:no-present-and-removed
      if (byResource.has(rd))
        return reject(
          discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'a resource is both present and removed', { reason: 'contradiction' }),
        );
      removals.set(rd, r.reason);
    }

    // Authorization may have been lost WHILE the connector was reading: re-check the source before accepting anything.
    const after = deps.inventory.get(request.sourceId);
    // ENFORCE:revoked-mid-read
    if (after === undefined || after.axes.authorization !== 'granted' || after.axes.connection !== 'validated')
      return reject(
        discoveryError(DiscoveryErrorCode.AUTHORIZATION_REQUIRED, 'authorization was lost during the sync; the batch was discarded', {
          reason: 'revoked_mid_sync',
        }),
      );

    const known = state.ingestedResources(sourceId);
    const upserts: { rd: string; evidenceId: string }[] = [];
    const retire: { rd: string; evidenceId: string; reason: RetireReason }[] = [];
    for (const [rd, evs] of byResource) {
      const fresh = new Set(evs.map((e) => e.id as string));
      for (const id of fresh) upserts.push({ rd, evidenceId: id });
      for (const old of known.get(rd) ?? []) if (!fresh.has(old)) retire.push({ rd, evidenceId: old, reason: 'superseded' });
    }
    for (const [rd, reason] of removals) for (const old of known.get(rd) ?? []) retire.push({ rd, evidenceId: old, reason });

    const advancing = out.status === 'complete' && out.nextCursor !== undefined;
    const noProgress =
      out.nextCursor === undefined || out.nextCursor === cursorBefore || (out.evidence.length === 0 && removals.size === 0);
    const done = out.status === 'complete' ? noProgress : true;
    const at = ctx.clock.now().toISOString();
    const items: IngestedItem[] = out.evidence.map((e) => ({
      evidenceId: e.id,
      resourceDigest: resourceDigestOf(sourceId, request.kind, e.resourceKey),
      sourceId: request.sourceId,
      connectorId: connector.descriptor.id,
      connectorVersion: connector.descriptor.version,
      principal,
      scopeDigest: env.scopeDigest,
      ...(cursorBefore !== undefined ? { cursorBefore } : {}),
      ...(advancing && out.nextCursor !== undefined ? { cursorAfter: out.nextCursor } : {}),
      observedAt: e.provenance.observedAt,
      ingestedAt: at,
      contentHash: contentHashOf(e),
      operationId,
    }));
    const committed = await state.commitIngestion(trust, {
      operationId,
      sourceId,
      binding,
      expectedSeq,
      ...(advancing && out.nextCursor !== undefined ? { cursor: out.nextCursor } : {}),
      complete: out.status === 'complete' && noProgress,
      provenance: provenanceDigestOf(items),
      upserts,
      retire,
    });
    // ENFORCE:commit-failure-contains
    if (!committed.ok) {
      await contain();
      return committed;
    }
    const retired: RetiredItem[] = retire.map((r) => ({ evidenceId: r.evidenceId as EvidenceId, resourceDigest: r.rd, reason: r.reason }));
    const current = state.checkpointOf(binding);
    return ok({
      status: out.status,
      evidence: [],
      skipped: { byReason: {} },
      errors: [],
      limits: { hit: ctx.signal?.aborted === true ? ['cancelled'] : [] },
      items,
      retired,
      checkpoint: {
        seq: current?.seq ?? expectedSeq,
        ...(current?.cursor !== undefined ? { cursor: current.cursor } : {}),
        complete: current?.complete ?? false,
        ...(current?.provenance !== undefined ? { provenance: current.provenance } : {}),
      },
      done,
    });
  };

  let outcome: Result<BatchDone, DiscoveryError>;
  try {
    outcome = await work();
  } catch (e) {
    outcome = err(internalError(e, 'ingestion batch'));
  }
  // The terminal audit record closes the batch. If it cannot be accepted the batch is NOT reported as ingested.
  const finished = await session.value.finish(outcome);
  if (!finished.ok) {
    // The checkpoint may ALREADY be committed when only the terminal audit record was refused. The batch is not reported as
    // ingested, but the caller is told the truth so it can reconcile (re-running is idempotent): the state did advance.
    // ENFORCE:terminal-audit-committed-context
    if (outcome.ok)
      return err(
        discoveryError(finished.error.code, finished.error.message, {
          ...(finished.error.context ?? {}),
          committed: true,
          checkpointSeq: outcome.value.checkpoint.seq,
        }),
      );
    return finished;
  }
  return ok({ done: finished.value, binding });
}

/** Marks the source revoked in the inventory and journals the snapshot (best effort on top of an already failed batch). */
async function markRevoked<TScope extends DiscoveryScopeBase>(
  env: BatchEnv<TScope>,
  trust: NonNullable<ReturnType<typeof trustFromContext>>,
): Promise<void> {
  try {
    env.deps.inventory.apply(env.request.sourceId, 'authorization_revoked', env.ctx.clock.now().toISOString());
    await env.ctx.state?.syncInventory(trust);
  } catch {
    // A failure here cannot loosen anything: the batch already failed and the checkpoint did not move.
  }
}

/** Quarantines evidence of a discarded batch that no earlier committed batch owns (never downgrades evidence that was already good). */
async function containBatch<TScope extends DiscoveryScopeBase>(
  env: BatchEnv<TScope>,
  trust: NonNullable<ReturnType<typeof trustFromContext>>,
  evidence: readonly Evidence[],
): Promise<void> {
  const state = env.ctx.state;
  if (state === undefined || !Array.isArray(evidence) || evidence.length === 0) return;
  const owned = new Set<string>();
  for (const ids of state.ingestedResources(env.request.sourceId).values()) for (const id of ids) owned.add(id);
  const fresh = evidence.filter((e) => !owned.has(e.id as string));
  if (fresh.length === 0) return;
  const operationId = `ingq_${stableDigest(fresh.map((e) => e.id as string).sort()).slice(0, 24)}`;
  try {
    await state.quarantine(trust, operationId, fresh);
  } catch {
    // Containment is best effort on top of a rejection that already withholds the result.
  }
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Ingests a source from its last good checkpoint: initial ingestion when there is none, incremental synchronization otherwise.
 *
 * `Result.err` means nothing ran or the FIRST batch failed (unauthenticated, no durable store, denied, source not authorized, connector
 * without sync, malformed/oversized/timed-out first batch). `ok` with `stoppedBecause` means earlier batches were committed and a
 * later one stopped; the checkpoint in the result is the last good one. A failed batch never advances any state.
 */
export async function ingestSource<TScope extends DiscoveryScopeBase>(
  deps: DiscoveryDeps,
  request: IngestionRequest<TScope>,
  ctx: ConnectorContext,
): Promise<Result<IngestionResult, DiscoveryError>> {
  const who = requireAuthenticatedPrincipal(ctx.principal, INGEST_PERMISSION);
  // ENFORCE:ingest-identity
  if (!who.ok) return who;
  // (equivalent to the per-batch guard below, which returns the identical error; kept so the refusal happens before any other work)
  if (ctx.state === undefined)
    return err(
      discoveryError(DiscoveryErrorCode.STATE_UNAVAILABLE, 'ingestion requires a durable lifecycle state store', {
        phase: 'ingestion',
        outcome: 'config',
      }),
    );
  const guard = requireOperationalState(ctx);
  if (!guard.ok) return guard;
  if (!isStateRepresentableId(request.sourceId))
    return err(discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'the source id is not acceptable', { field: 'sourceId' }));
  const limits = resolveLimits(request.limits);
  if (!limits.ok) return limits;
  const scopeDigest = ingestionScopeDigest(request.scope);
  if (scopeDigest === undefined)
    return err(discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'the ingestion scope is not acceptable', { field: 'scope' }));

  const env: BatchEnv<TScope> = { deps, request, ctx, principal: who.value, limits: limits.value, scopeDigest };
  const items: IngestedItem[] = [];
  const retired: RetiredItem[] = [];
  let binding = '';
  let checkpoint: IngestionCheckpoint | undefined;
  let batches = 0;
  let stoppedBecause: DiscoveryError | undefined;
  let status: IngestionStatus = 'more_available';

  for (let i = 0; i < limits.value.maxBatches; i += 1) {
    const step = await ingestOneBatch(env);
    if (!step.ok) {
      if (batches === 0) return step;
      stoppedBecause = step.error;
      status = 'stopped';
      break;
    }
    batches += 1;
    binding = step.value.binding;
    items.push(...step.value.done.items);
    retired.push(...step.value.done.retired);
    checkpoint = step.value.done.checkpoint;
    // ENFORCE:partial-never-advances-run
    if (step.value.done.status === 'partial') {
      status = 'partial';
      break;
    }
    if (step.value.done.done) {
      status = 'caught_up';
      break;
    }
  }
  return ok({
    sourceId: request.sourceId,
    binding,
    status,
    batches,
    items,
    retired,
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    ...(stoppedBecause !== undefined ? { stoppedBecause } : {}),
    sourceRevoked: deps.inventory.get(request.sourceId)?.axes.authorization === 'revoked',
  });
}
