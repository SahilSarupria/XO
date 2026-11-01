import { createHash } from 'node:crypto';
import { resourceScope, type Principal } from '@xo/permissions';
import { err, ok, type Result } from '@xo/types';
import { auditDenial, beginAudit, type AuditSession } from '../audited-operation.js';
import { requireAuthenticatedPrincipal, requireAuthorization } from '../authorization-gate.js';
import type { ConnectorContext } from '../connector.js';
import { DiscoveryErrorCode, discoveryError, internalError, type DiscoveryError } from '../errors.js';
import type { Evidence } from '../evidence.js';
import { ConnectorId, stableDigest, type EvidenceId, type SourceId } from '../ids.js';
import { contentHashOf, provenanceDigestOf, resourceDigestOf, type IngestedItem, type IngestionResult } from '../ingestion.js';
import type { DiscoveryDeps } from '../orchestrator.js';
import { isStateRepresentableId, requireOperationalState } from '../state-journal.js';
import { StructuredRecordDeriver, type Deriver } from './deriver.js';
import { identifierKey, isStrongScheme, entityIdOfKey, schemeOfKey, validIdentifier } from './identifiers.js';
import type { KnowledgeModel } from './model.js';
import type { EvidenceReader } from './staging.js';
import {
  ENTITY_KINDS,
  KNOWLEDGE_KINDS,
  RELATIONSHIP_TYPES,
  type Assertion,
  type BatchRecord,
  type Candidate,
  type EntityKind,
  type EvidenceSupport,
  type Identifier,
  type KnowledgeItem,
  type KnowledgeKind,
  type RelationshipType,
  type ReviewDecision,
  type Scalar,
} from './types.js';
import { buildView, valueDigest, type View } from './view.js';

/**
 * C5 - the knowledge service. THREE separate authority boundaries, each its own decision, own audit trail and own resource scope:
 *
 *   derive  (`derive_knowledge`, data.write on `environment-intelligence/knowledge/derive/<sourceId>`)
 *   query   (`query_knowledge`,  data.read  on `environment-intelligence/knowledge/query`, plus one decision per source resource)
 *   review  (`review_knowledge`, data.write on `environment-intelligence/knowledge/review`)
 *
 * Ingestion (C4) is a fourth, separate one. None implies another, and NONE of them is permission to act on what the knowledge says:
 * EI never executes business actions, and a confidence value is information, never authorization. `data.write` / `data.read` are the
 * same provisional platform permissions every EI lifecycle operation reuses; a dedicated catalog entry is a shared-catalog change that
 * was not made here.
 */
export const KNOWLEDGE_RESOURCE = 'environment-intelligence/knowledge';
export const DERIVE_PERMISSION = 'data.write';
export const REVIEW_PERMISSION = 'data.write';
export const QUERY_PERMISSION = 'data.read';
const KNOWLEDGE_CONNECTOR = ConnectorId('xo.environment-intelligence');

export interface KnowledgeLimits {
  /** Evidence items one derivation call may consider. */
  readonly maxEvidence: number;
  /** Items one query may return. */
  readonly maxResults: number;
  /** Distinct source resources one query may need an access decision for. Beyond it the query is refused (fail closed), never truncated. */
  readonly maxAccessChecks: number;
  /** Wall-clock budget of one derivation or query. */
  readonly timeBudgetMs: number;
}
export const DEFAULT_KNOWLEDGE_LIMITS: KnowledgeLimits = Object.freeze({
  maxEvidence: 5000,
  maxResults: 1000,
  maxAccessChecks: 2000,
  timeBudgetMs: 10_000,
});
export const HARD_KNOWLEDGE_LIMITS: KnowledgeLimits = Object.freeze({
  maxEvidence: 5000,
  maxResults: 5000,
  maxAccessChecks: 5000,
  timeBudgetMs: 120_000,
});

function resolveLimits(requested: Partial<KnowledgeLimits> | undefined): Result<KnowledgeLimits, DiscoveryError> {
  const m = { ...DEFAULT_KNOWLEDGE_LIMITS, ...(requested ?? {}) };
  const okN = (n: number, max: number, min = 1): boolean => Number.isSafeInteger(n) && n >= min && n <= max;
  if (
    !okN(m.maxEvidence, HARD_KNOWLEDGE_LIMITS.maxEvidence) ||
    !okN(m.maxResults, HARD_KNOWLEDGE_LIMITS.maxResults) ||
    !okN(m.maxAccessChecks, HARD_KNOWLEDGE_LIMITS.maxAccessChecks) ||
    !okN(m.timeBudgetMs, HARD_KNOWLEDGE_LIMITS.timeBudgetMs, 0)
  )
    return err(discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'the knowledge limits are not acceptable', { field: 'limits' }));
  return ok(Object.freeze(m));
}

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x !== null && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );

class Deadline {
  private readonly end: number;
  constructor(ms: number) {
    this.end = performance.now() + ms;
  }
  expired(): boolean {
    return performance.now() >= this.end;
  }
}

/** Common preconditions of every knowledge operation: authenticated caller, durable state operational and attached. Nothing is looked up before they hold. */
function preconditions(ctx: ConnectorContext, permission: string): Result<Principal, DiscoveryError> {
  const who = requireAuthenticatedPrincipal(ctx.principal, permission);
  // (equivalent mutant: `requireAuthorization` re-checks identity before consulting the port and returns the identical error; kept so the refusal precedes every other step)
  // ENFORCE:knowledge-identity
  if (!who.ok) return who;
  // Knowledge is derived from DURABLE lifecycle state; there is no memory-only mode.
  if (ctx.state === undefined || ctx.ledger === undefined)
    return err(
      discoveryError(DiscoveryErrorCode.STATE_UNAVAILABLE, 'knowledge requires a durable lifecycle state store', {
        phase: 'knowledge',
        outcome: 'config',
      }),
    );
  const guard = requireOperationalState(ctx);
  // ENFORCE:knowledge-state-operational
  if (!guard.ok) return guard;
  return who;
}

async function authorizeFor(
  ctx: ConnectorContext,
  operation: 'derive_knowledge' | 'query_knowledge' | 'review_knowledge',
  permission: string,
  resource: string,
  reason: string,
  _principal: Principal,
) {
  const scope = resourceScope(resource);
  const gate = await requireAuthorization(ctx.authorization, {
    connectorId: KNOWLEDGE_CONNECTOR,
    operation,
    permission,
    scope,
    ...(ctx.principal !== undefined ? { principal: ctx.principal } : {}),
    reason,
  });
  return { gate, scope };
}

// ── derive ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DeriveRequest {
  readonly sourceId: SourceId;
  /** Where payloads come from. The shipped reader is `EvidenceStaging` (connector-captured); a host may supply a re-reading reader after a restart. */
  readonly reader: EvidenceReader;
  /** The C4 result of the ingestion call whose evidence is being derived: its provenance is recorded and verified against the journal. */
  readonly ingestion?: IngestionResult;
  /** Re-hydration (no ingestion result): derive these ids, anchored by the durable resource index only. Exactly one of `ingestion` / `evidenceIds`. */
  readonly evidenceIds?: readonly EvidenceId[];
  readonly deriver?: Deriver;
  readonly limits?: Partial<KnowledgeLimits>;
}

export interface DeriveResult {
  readonly operationId: string;
  readonly evidenceUsed: number;
  readonly assertionsAdded: number;
  readonly assertionsUnchanged: number;
  /** Evidence not used, by reason (ineligible, not_indexed, not_read, mismatch, wrong_source). Counts only. */
  readonly skipped: Readonly<Record<string, number>>;
  /** Evidence the deriver refused (malformed / unsupported / limit): flagged, never guessed at. */
  readonly refused: Readonly<Record<string, number>>;
  readonly anchoring: { readonly journalCheckpoint: number; readonly journalIndex: number };
}

const bump = (m: Record<string, number>, k: string): void => {
  m[k] = (m[k] ?? 0) + 1;
};

export async function deriveKnowledge(
  model: KnowledgeModel,
  deps: DiscoveryDeps,
  request: DeriveRequest,
  ctx: ConnectorContext,
): Promise<Result<DeriveResult, DiscoveryError>> {
  const who = preconditions(ctx, DERIVE_PERMISSION);
  if (!who.ok) return who;
  const principal = who.value;
  const state = ctx.state;
  const ledger = ctx.ledger;
  if (state === undefined || ledger === undefined)
    return err(discoveryError(DiscoveryErrorCode.STATE_UNAVAILABLE, 'knowledge requires a durable lifecycle state store'));
  if (!isStateRepresentableId(request.sourceId))
    return err(discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'the source id is not acceptable', { field: 'sourceId' }));
  const limits = resolveLimits(request.limits);
  if (!limits.ok) return limits;
  if ((request.ingestion === undefined) === (request.evidenceIds === undefined))
    return err(discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'give exactly one of ingestion / evidenceIds', { field: 'request' }));

  const { gate, scope } = await authorizeFor(
    ctx,
    'derive_knowledge',
    DERIVE_PERMISSION,
    `${KNOWLEDGE_RESOURCE}/derive/${request.sourceId}`,
    'derive organizational knowledge from eligible evidence of one source',
    principal,
  );
  // ENFORCE:derive-decision-gate
  if (!gate.ok) {
    await auditDenial(ctx, {
      operation: 'derive_knowledge',
      connectorId: KNOWLEDGE_CONNECTOR,
      permission: DERIVE_PERMISSION,
      scope,
      error: gate.error,
    });
    return gate;
  }

  const record = deps.inventory.get(request.sourceId);
  // ENFORCE:derive-source-authorized
  if (record === undefined || record.axes.authorization !== 'granted' || record.axes.connection !== 'validated')
    return err(
      discoveryError(DiscoveryErrorCode.AUTHORIZATION_REQUIRED, 'the source has not been authorized and validated', { phase: 'derive' }),
    );

  const session = await beginAudit(ctx, {
    operation: 'derive_knowledge',
    connectorId: KNOWLEDGE_CONNECTOR,
    connectorVersion: '1',
    permission: DERIVE_PERMISSION,
    scope,
    allow: gate.value,
    sourceId: request.sourceId,
  });
  if (!session.ok) return session;
  return finishWork(
    session.value,
    () => deriveWork(model, deps, request, ctx, principal, limits.value, session.value.operationId),
    (r) => ({
      counts: {
        evidence: r.evidenceUsed,
        skipped: Object.values(r.skipped).reduce((a, b) => a + b, 0),
        errors: Object.values(r.refused).reduce((a, b) => a + b, 0),
      },
    }),
  );
}

/** Runs the work, then closes the audit. The work's own state change is applied by `commit`, ONLY after the terminal record was accepted. */
async function finishWork<T extends { readonly commit?: () => void }>(
  session: AuditSession,
  work: () => Promise<Result<T, DiscoveryError>>,
  detail: (v: T) => { counts: { evidence: number; skipped: number; errors: number } },
): Promise<Result<T, DiscoveryError>> {
  let outcome: Result<T, DiscoveryError>;
  try {
    outcome = await work();
  } catch (e) {
    outcome = err(internalError(e, 'knowledge operation'));
  }
  if (!outcome.ok) {
    await session.closeWithoutRelease('failed', { counts: {}, errorCode: outcome.error.code });
    return outcome;
  }
  const closed = await session.closeWithoutRelease('completed', detail(outcome.value));
  // ENFORCE:knowledge-terminal-audit
  if (!closed)
    return err(
      discoveryError(
        DiscoveryErrorCode.AUDIT_UNAVAILABLE,
        'the completion audit was not accepted; the operation is not reported as completed',
        {
          phase: 'completion',
          operationId: session.operationId,
        },
      ),
    );
  outcome.value.commit?.();
  return outcome;
}

type DeriveWork = DeriveResult & { readonly commit: () => void };

async function deriveWork(
  model: KnowledgeModel,
  deps: DiscoveryDeps,
  request: DeriveRequest,
  ctx: ConnectorContext,
  principal: Principal,
  limits: KnowledgeLimits,
  operationId: string,
): Promise<Result<DeriveWork, DiscoveryError>> {
  const state = ctx.state;
  const ledger = ctx.ledger;
  if (state === undefined || ledger === undefined)
    return err(discoveryError(DiscoveryErrorCode.STATE_UNAVAILABLE, 'knowledge requires a durable lifecycle state store'));
  const deriver = request.deriver ?? new StructuredRecordDeriver();
  const deadline = new Deadline(limits.timeBudgetMs);
  const sourceId = request.sourceId as string;
  const now = ctx.clock.now().toISOString();

  const items = request.ingestion?.items ?? [];
  const ids: readonly EvidenceId[] = request.ingestion !== undefined ? items.map((i) => i.evidenceId) : (request.evidenceIds ?? []);
  // ENFORCE:derive-input-bounded
  if (!Array.isArray(ids) || ids.length > limits.maxEvidence)
    return err(discoveryError(DiscoveryErrorCode.LIMIT_EXCEEDED, 'too much evidence for one derivation', { limit: 'derive_evidence' }));

  // The ingestion result is data the caller handed us. Its provenance must be internally consistent and, where the durable
  // checkpoint still holds that batch's digest, equal to it. A forged or altered result cannot match.
  const itemOf = new Map<string, IngestedItem>();
  const batches = new Map<string, IngestedItem[]>();
  for (const it of items) {
    // ENFORCE:derive-item-source
    if (it.sourceId !== request.sourceId)
      return err(
        discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'an ingestion item belongs to another source', { reason: 'wrong_source' }),
      );
    itemOf.set(it.evidenceId, it);
    batches.set(it.operationId, [...(batches.get(it.operationId) ?? []), it]);
  }
  const batchRecords: BatchRecord[] = [];
  const checkpointBatches = new Set<string>();
  for (const [op, list] of batches) {
    const digest = provenanceDigestOf(list);
    const binding = request.ingestion?.binding ?? '';
    batchRecords.push({ operationId: op, binding, items: list, digest });
    const durable = state.checkpointOf(binding)?.provenance;
    // ENFORCE:derive-provenance-anchor
    if (durable !== undefined && durable === digest) checkpointBatches.add(op);
  }

  const index = state.ingestedResources(sourceId);
  const skipped: Record<string, number> = {};
  const refused: Record<string, number> = {};
  const staged = request.reader.read(ids);
  const byId = new Map<string, Evidence>();
  for (const e of staged) byId.set(e.id, e);
  const fresh: Assertion[] = [];
  const usedIds: string[] = [];
  const anchoring = { journalCheckpoint: 0, journalIndex: 0 };

  for (const id of [...new Set(ids)].sort()) {
    // ENFORCE:derive-time-budget
    if (deadline.expired())
      return err(discoveryError(DiscoveryErrorCode.LIMIT_EXCEEDED, 'the derivation exceeded its time budget', { limit: 'derive_time' }));
    // ENFORCE:derive-eligible-only
    if (!ledger.isEligible(id)) {
      bump(skipped, 'ineligible');
      continue;
    }
    const e = byId.get(id);
    if (e === undefined) {
      bump(skipped, 'not_read');
      continue;
    }
    // ENFORCE:derive-evidence-binding
    if (e.id !== id || e.sourceId !== request.sourceId || typeof e.resourceKey !== 'string' || e.resourceKey.length === 0) {
      bump(skipped, 'mismatch');
      continue;
    }
    const rd = resourceDigestOf(sourceId, e.kind, e.resourceKey);
    // ENFORCE:derive-journal-indexed
    if (index.get(rd)?.includes(id) !== true) {
      bump(skipped, 'not_indexed');
      continue;
    }
    const contentHash = contentHashOf(e);
    const item = itemOf.get(id);
    // ENFORCE:derive-content-hash
    if (item !== undefined && item.contentHash !== contentHash) {
      bump(skipped, 'mismatch');
      continue;
    }
    const batchAnchored = item !== undefined && checkpointBatches.has(item.operationId);
    const derived = deriver.derive(e);
    if (!derived.ok) {
      bump(refused, derived.error);
      continue;
    }
    const support: EvidenceSupport = {
      evidenceId: id,
      sourceId,
      resourceDigest: rd,
      contentHash,
      observedAt: item?.observedAt ?? e.provenance.observedAt,
      ...(item !== undefined ? { batchOperationId: item.operationId } : {}),
      anchoring: batchAnchored ? 'journal_checkpoint' : 'journal_index',
    };
    const built = bindCandidates(derived.value, support, deriver, principal, now, operationId);
    if (!built.ok) {
      bump(refused, built.error);
      continue;
    }
    fresh.push(...built.value);
    usedIds.push(id);
    anchoring[batchAnchored ? 'journalCheckpoint' : 'journalIndex'] += 1;
  }

  // ENFORCE:derive-model-bounded
  if (model.wouldExceed(fresh))
    return err(discoveryError(DiscoveryErrorCode.LIMIT_EXCEEDED, 'the knowledge model is full', { limit: 'model_size' }));
  const preview = fresh.filter((a) => !model.has(a.id)).length;
  return ok({
    operationId,
    evidenceUsed: usedIds.length,
    assertionsAdded: preview,
    assertionsUnchanged: fresh.length - preview,
    skipped,
    refused,
    anchoring,
    // Applied only after the completion audit was accepted: a refused audit leaves the model untouched.
    commit: () => {
      model.add(fresh, batchRecords);
      model.sweep(ledger);
    },
  });
}

function bindCandidates(
  candidates: readonly Candidate[],
  support: EvidenceSupport,
  deriver: Deriver,
  principal: Principal,
  now: string,
  _operationId: string,
): Result<readonly Assertion[], 'malformed'> {
  const out: Assertion[] = [];
  for (const candidate of candidates) {
    if (!validCandidate(candidate)) return err('malformed');
    const derivationId = stableDigest(['ei-derivation-v1', deriver.id, deriver.version, support.evidenceId]).slice(0, 24);
    out.push({
      id: `asr_${createHash('sha256')
        .update(canonical([deriver.id, deriver.version, support.evidenceId, candidate]))
        .digest('hex')
        .slice(0, 32)}`,
      candidate,
      support,
      derivation: { deriverId: deriver.id, deriverVersion: deriver.version, derivationId, principalId: principal.id, derivedAt: now },
    });
  }
  return ok(out);
}

const validRef = (r: unknown): boolean =>
  r !== null &&
  typeof r === 'object' &&
  (ENTITY_KINDS as readonly string[]).includes((r as { kind?: string }).kind ?? '') &&
  Array.isArray((r as { identifiers?: unknown }).identifiers) &&
  (r as { identifiers: unknown[] }).identifiers.length >= 1 &&
  (r as { identifiers: unknown[] }).identifiers.length <= 8 &&
  (r as { identifiers: unknown[] }).identifiers.every(validIdentifier);

/** A deriver's output is untrusted: it is re-validated here so a (future, model-backed) deriver cannot inject malformed structure. */
function validCandidate(c: Candidate): boolean {
  if (c === null || typeof c !== 'object') return false;
  const okTime = (t: string | undefined): boolean => t === undefined || Number.isFinite(Date.parse(t));
  switch (c.type) {
    case 'entity':
      return validRef(c.ref);
    case 'relationship':
      return (
        (RELATIONSHIP_TYPES as readonly string[]).includes(c.relation) &&
        validRef(c.from) &&
        validRef(c.to) &&
        okTime(c.validFrom) &&
        okTime(c.validTo)
      );
    case 'claim':
      return (
        (KNOWLEDGE_KINDS as readonly string[]).includes(c.kind) &&
        validRef(c.subject) &&
        typeof c.predicate === 'string' &&
        c.predicate.length > 0 &&
        c.predicate.length <= 256 &&
        ['string', 'number', 'boolean'].includes(typeof c.value) &&
        (c.origin === 'observed' || c.origin === 'stated' || c.origin === 'inferred') &&
        okTime(c.validFrom) &&
        okTime(c.validTo)
      );
    default:
      return false;
  }
}

// ── query ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface KnowledgeQuery {
  readonly select: 'entities' | 'relationships' | 'claims' | 'conflicts' | 'documents';
  /** Point in time the answer describes (ISO). Default: now. Only still-eligible evidence can answer, however far back the question reaches. */
  readonly asOf?: string;
  /** Restrict to one entity (as the subject of claims, an endpoint of relationships, or the entity itself). Unknown entities answer exactly like empty ones. */
  readonly entity?: { readonly id: string } | { readonly kind: EntityKind; readonly identifier: Identifier };
  readonly entityKind?: EntityKind;
  readonly predicate?: string;
  readonly claimKind?: KnowledgeKind;
  readonly relation?: RelationshipType;
  readonly limit?: number;
  readonly limits?: Partial<KnowledgeLimits>;
}

export interface KnowledgeAnswer {
  readonly select: KnowledgeQuery['select'];
  readonly asOf: string;
  readonly items: readonly KnowledgeItem[];
  readonly truncated: boolean;
}

const queryResource = `${KNOWLEDGE_RESOURCE}/query`;
const evidenceResource = (sourceId: string, resourceDigest: string): string =>
  `${KNOWLEDGE_RESOURCE}/evidence/${sourceId}/${resourceDigest}`;

interface Visible {
  readonly view: View;
  readonly asOf: string;
  readonly withheld: number;
  readonly visibleAssertions: number;
}

/**
 * The visibility core shared by queries and review. Order is the security property:
 *  1. only assertions whose evidence the LEDGER currently reports eligible (tombstone, supersession, quarantine, revoke and purge all drop out);
 *  2. only assertions whose source resource THIS CALLER is allowed to read (one decision per distinct resource, against the call's own principal);
 *  3. the view (entity merges, relationships, facts, conflicts) is built from that subset ONLY, so nothing derived from evidence the caller
 *     cannot see can appear, and no merge or conflict that rests on hidden evidence can be inferred from the result.
 */
async function visibleView(
  model: KnowledgeModel,
  ctx: ConnectorContext,
  principal: Principal,
  asOf: string,
  limits: KnowledgeLimits,
  deadline: Deadline,
): Promise<Result<Visible, DiscoveryError>> {
  const ledger = ctx.ledger;
  if (ledger === undefined)
    return err(discoveryError(DiscoveryErrorCode.STATE_UNAVAILABLE, 'knowledge requires a durable lifecycle state store'));
  const eligible: Assertion[] = [];
  for (const a of model.assertions()) {
    // ENFORCE:query-eligibility
    if (!ledger.isEligible(a.support.evidenceId as EvidenceId)) continue;
    eligible.push(a);
  }
  const resources = new Map<string, { sourceId: string; resourceDigest: string }>();
  for (const a of eligible)
    resources.set(`${a.support.sourceId}/${a.support.resourceDigest}`, {
      sourceId: a.support.sourceId,
      resourceDigest: a.support.resourceDigest,
    });
  // ENFORCE:query-access-bounded
  if (resources.size > limits.maxAccessChecks)
    return err(discoveryError(DiscoveryErrorCode.LIMIT_EXCEEDED, 'too many source resources for one query', { limit: 'access_checks' }));
  const allowed = new Set<string>();
  let withheld = 0;
  for (const [key, r] of [...resources.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    // ENFORCE:query-time-budget
    if (deadline.expired())
      return err(discoveryError(DiscoveryErrorCode.LIMIT_EXCEEDED, 'the query exceeded its time budget', { limit: 'query_time' }));
    const decided = await requireAuthorization(ctx.authorization, {
      connectorId: KNOWLEDGE_CONNECTOR,
      operation: 'query_knowledge',
      permission: QUERY_PERMISSION,
      scope: resourceScope(evidenceResource(r.sourceId, r.resourceDigest)),
      // The branded principal of THIS call (never a snapshot, never a parameter): the per-resource decision is the caller's own.
      ...(ctx.principal !== undefined ? { principal: ctx.principal } : {}),
      reason: 'read knowledge derived from one source resource',
    });
    if (decided.ok) {
      allowed.add(key);
      continue;
    }
    // ENFORCE:query-authz-outage-fails-closed
    if (decided.error.code === DiscoveryErrorCode.INTERNAL || decided.error.code === DiscoveryErrorCode.UNAUTHENTICATED) return decided;
    withheld += 1;
  }
  const visible: Assertion[] = [];
  for (const a of eligible) {
    // ENFORCE:query-access-carry-through
    if (!allowed.has(`${a.support.sourceId}/${a.support.resourceDigest}`)) continue;
    visible.push(a);
  }
  const view = buildView({
    assertions: visible,
    decisions: model.decisions(),
    policy: model.policy,
    asOf,
    now: ctx.clock.now().toISOString(),
  });
  return ok({ view, asOf, withheld, visibleAssertions: visible.length });
}

function parseAsOf(q: KnowledgeQuery, ctx: ConnectorContext): Result<string, DiscoveryError> {
  if (q.asOf === undefined) return ok(ctx.clock.now().toISOString());
  if (typeof q.asOf !== 'string' || !Number.isFinite(Date.parse(q.asOf)))
    return err(discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'asOf is not an ISO time', { field: 'asOf' }));
  return ok(q.asOf);
}

function entityIdOf(view: View, q: KnowledgeQuery['entity']): string | undefined | null {
  if (q === undefined) return null; // no entity restriction
  if ('id' in q) return view.entityIdFor.get(q.id);
  if (!validIdentifier(q.identifier)) return undefined;
  return view.entityIdFor.get(entityIdOfKey(identifierKey(q.kind, q.identifier)));
}

export async function queryKnowledge(
  model: KnowledgeModel,
  query: KnowledgeQuery,
  ctx: ConnectorContext,
): Promise<Result<KnowledgeAnswer, DiscoveryError>> {
  const who = preconditions(ctx, QUERY_PERMISSION);
  if (!who.ok) return who;
  const principal = who.value;
  const limits = resolveLimits(query.limits);
  if (!limits.ok) return limits;
  const asOf = parseAsOf(query, ctx);
  if (!asOf.ok) return asOf;
  const requested = query.limit ?? limits.value.maxResults;
  if (!Number.isSafeInteger(requested) || requested < 1)
    return err(discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'the result limit is not acceptable', { field: 'limit' }));
  let cap = requested;
  // ENFORCE:query-result-bounded
  if (cap > limits.value.maxResults) cap = limits.value.maxResults;
  if (!['entities', 'relationships', 'claims', 'conflicts', 'documents'].includes(query.select))
    return err(discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'the query selector is not acceptable', { field: 'select' }));

  const { gate, scope } = await authorizeFor(
    ctx,
    'query_knowledge',
    QUERY_PERMISSION,
    queryResource,
    'query derived organizational knowledge',
    principal,
  );
  // ENFORCE:query-decision-gate
  if (!gate.ok) {
    await auditDenial(ctx, {
      operation: 'query_knowledge',
      connectorId: KNOWLEDGE_CONNECTOR,
      permission: QUERY_PERMISSION,
      scope,
      error: gate.error,
    });
    return gate;
  }
  const session = await beginAudit(ctx, {
    operation: 'query_knowledge',
    connectorId: KNOWLEDGE_CONNECTOR,
    connectorVersion: '1',
    permission: QUERY_PERMISSION,
    scope,
    allow: gate.value,
    sourceId: 'knowledge',
  });
  if (!session.ok) return session;

  let withheldCount = 0;
  const answer = await finishWork(
    session.value,
    async (): Promise<Result<KnowledgeAnswer & { commit?: () => void }, DiscoveryError>> => {
      const seen = await visibleView(model, ctx, principal, asOf.value, limits.value, new Deadline(limits.value.timeBudgetMs));
      if (!seen.ok) return seen;
      withheldCount = seen.value.withheld;
      const picked = select(seen.value.view, query);
      const items = picked.slice(0, cap);
      return ok({ select: query.select, asOf: asOf.value, items, truncated: picked.length > cap });
    },
    (a) => ({ counts: { evidence: a.items.length, skipped: withheldCount, errors: 0 } }),
  );
  if (!answer.ok) return answer;
  return ok({ select: answer.value.select, asOf: answer.value.asOf, items: answer.value.items, truncated: answer.value.truncated });
}

function select(view: View, q: KnowledgeQuery): readonly KnowledgeItem[] {
  const entity = entityIdOf(view, q.entity);
  if (entity === undefined) return []; // unknown entity: indistinguishable from "nothing known"
  const touches = (...ids: string[]): boolean => entity === null || ids.includes(entity);
  switch (q.select) {
    case 'entities':
      return [...view.entities.values()].filter(
        (e) => (entity === null || e.id === entity) && (q.entityKind === undefined || e.kind === q.entityKind),
      );
    case 'relationships':
      return view.relationships.filter((r) => touches(r.from, r.to) && (q.relation === undefined || r.relation === q.relation));
    case 'claims':
      return view.claims.filter(
        (c) =>
          touches(c.subject) &&
          (q.predicate === undefined || c.predicate === q.predicate) &&
          (q.claimKind === undefined || c.kind === q.claimKind),
      );
    case 'conflicts':
      return view.conflicts.filter((c) => touches(c.subject) && (q.predicate === undefined || c.predicate === q.predicate));
    case 'documents':
      return view.documents;
  }
}

// ── provenance verification ───────────────────────────────────────────────────────────────────────────────────────────────

export interface ProvenanceVerification {
  readonly evidenceId: string;
  /**
   * `verified_against_journal`: the item's ingestion batch digest equals the durable checkpoint's digest now.
   * `batch_superseded`: the batch is internally consistent but the checkpoint has since advanced (C4 keeps only the LATEST batch digest durable).
   * `index_only`: derived without an ingestion result; anchored only by the durable resource index.
   * `mismatch`: the recomputed digest does not match what was recorded (tampering) - the item must not be trusted.
   */
  readonly status: 'verified_against_journal' | 'batch_superseded' | 'index_only' | 'mismatch';
}

/** Re-verifies every support of an item against the durable journal, from the batch records the model kept (digests and ids only). */
export function verifyProvenance(
  model: KnowledgeModel,
  ctx: ConnectorContext,
  support: readonly EvidenceSupport[],
): readonly ProvenanceVerification[] {
  return support.map((s): ProvenanceVerification => {
    const rec = s.batchOperationId === undefined ? undefined : model.batch(s.batchOperationId);
    if (rec === undefined) return { evidenceId: s.evidenceId, status: 'index_only' };
    if (provenanceDigestOf(rec.items) !== rec.digest) return { evidenceId: s.evidenceId, status: 'mismatch' };
    const member = rec.items.find((i) => i.evidenceId === s.evidenceId);
    if (member === undefined || member.contentHash !== s.contentHash) return { evidenceId: s.evidenceId, status: 'mismatch' };
    const durable = ctx.state?.checkpointOf(rec.binding)?.provenance;
    return { evidenceId: s.evidenceId, status: durable === rec.digest ? 'verified_against_journal' : 'batch_superseded' };
  });
}

// ── review ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type ReviewRequest =
  | { readonly action: 'approve_merge' | 'block_merge'; readonly kind: EntityKind; readonly a: Identifier; readonly b: Identifier }
  | { readonly action: 'resolve_conflict'; readonly conflictId: string; readonly winner: Scalar }
  | { readonly action: 'revoke_decision'; readonly decisionId: string };

export interface ReviewResult {
  readonly operationId: string;
  readonly decisionId: string;
}

/**
 * A human-review decision. The reviewer needs the review authority AND must be able to SEE what they decide about (the same per-resource
 * access the query needs): a decision can neither be made about, nor reveal, evidence the reviewer may not read. Decisions are explicit,
 * audited, attributed and reversible; they never alter evidence or derivations.
 */
export async function reviewKnowledge(
  model: KnowledgeModel,
  request: ReviewRequest,
  ctx: ConnectorContext,
): Promise<Result<ReviewResult, DiscoveryError>> {
  const who = preconditions(ctx, REVIEW_PERMISSION);
  if (!who.ok) return who;
  const principal = who.value;
  const { gate, scope } = await authorizeFor(
    ctx,
    'review_knowledge',
    REVIEW_PERMISSION,
    `${KNOWLEDGE_RESOURCE}/review`,
    'record a human-review decision on derived knowledge',
    principal,
  );
  // ENFORCE:review-decision-gate
  if (!gate.ok) {
    await auditDenial(ctx, {
      operation: 'review_knowledge',
      connectorId: KNOWLEDGE_CONNECTOR,
      permission: REVIEW_PERMISSION,
      scope,
      error: gate.error,
    });
    return gate;
  }
  const session = await beginAudit(ctx, {
    operation: 'review_knowledge',
    connectorId: KNOWLEDGE_CONNECTOR,
    connectorVersion: '1',
    permission: REVIEW_PERMISSION,
    scope,
    allow: gate.value,
    sourceId: 'knowledge',
  });
  if (!session.ok) return session;
  const operationId = session.value.operationId;
  return finishWork(
    session.value,
    async (): Promise<Result<ReviewResult & { commit?: () => void }, DiscoveryError>> => {
      const limits = DEFAULT_KNOWLEDGE_LIMITS;
      const seen = await visibleView(model, ctx, principal, ctx.clock.now().toISOString(), limits, new Deadline(limits.timeBudgetMs));
      if (!seen.ok) return seen;
      const at = ctx.clock.now().toISOString();
      const decide = (
        kind: ReviewDecision['kind'],
        subject: readonly string[],
      ): Result<ReviewResult & { commit?: () => void }, DiscoveryError> => {
        const id = `rvw_${stableDigest(['ei-review-v1', kind, ...subject]).slice(0, 24)}`;
        const decision: ReviewDecision = { id, kind, subject, principalId: principal.id, decidedAt: at, operationId };
        if (model.decisions().length >= 2000 && !model.decisions().some((d) => d.id === id))
          return err(discoveryError(DiscoveryErrorCode.LIMIT_EXCEEDED, 'too many review decisions', { limit: 'decisions' }));
        return ok({ operationId, decisionId: id, commit: () => void model.addDecision(decision) });
      };
      const notVisible = (): Result<never, DiscoveryError> =>
        err(
          discoveryError(DiscoveryErrorCode.SCOPE_VIOLATION, 'the subject of the decision is not visible to the reviewer', {
            reason: 'not_visible',
          }),
        );
      switch (request.action) {
        case 'approve_merge':
        case 'block_merge': {
          if (!validIdentifier(request.a) || !validIdentifier(request.b) || !(ENTITY_KINDS as readonly string[]).includes(request.kind))
            return err(
              discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'the merge decision is not acceptable', { field: 'identifiers' }),
            );
          const ka = identifierKey(request.kind, request.a);
          const kb = identifierKey(request.kind, request.b);
          // The reviewer must be able to see BOTH sides (an entity they can see carries each identifier).
          const seesA = [...seen.value.view.entities.values()].some((e) => e.identifiers.includes(ka));
          const seesB = [...seen.value.view.entities.values()].some((e) => e.identifiers.includes(kb));
          // ENFORCE:review-requires-visibility
          if (!seesA || !seesB) return notVisible();
          // Approving a merge on a STRONG pair is pointless and on a unique-scheme clash is refused by the view; only the weak case needs a human.
          if (request.action === 'approve_merge' && isStrongScheme(schemeOfKey(ka)) && isStrongScheme(schemeOfKey(kb)) && ka === kb)
            return err(discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'the two identifiers are the same', { field: 'identifiers' }));
          return decide(request.action, [ka, kb].sort());
        }
        case 'resolve_conflict': {
          const conflict = seen.value.view.conflicts.find((c) => c.id === request.conflictId);
          // ENFORCE:review-conflict-visible
          if (conflict === undefined) return notVisible();
          if (conflict.predicate.startsWith('identity:'))
            return err(
              discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'an identity conflict cannot be resolved by choosing a value', {
                field: 'conflictId',
              }),
            );
          if (!conflict.claims.some((c) => valueDigest(c.value) === valueDigest(request.winner)))
            return err(
              discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'the winning value is not one of the conflicting claims', {
                field: 'winner',
              }),
            );
          return decide('resolve_conflict', [request.conflictId, valueDigest(request.winner)]);
        }
        case 'revoke_decision': {
          const existing = model.decisions().find((d) => d.id === request.decisionId);
          // ENFORCE:review-decision-exists
          if (existing === undefined)
            return err(discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'no such decision', { field: 'decisionId' }));
          return ok({ operationId, decisionId: existing.id, commit: () => void model.removeDecision(existing.id) });
        }
      }
    },
    () => ({ counts: { evidence: 0, skipped: 0, errors: 0 } }),
  );
}
