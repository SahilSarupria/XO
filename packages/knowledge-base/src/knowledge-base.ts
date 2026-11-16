/**
 * The BKB service (spec §4.6 "Required BKB APIs/services"): one class over one tenant's store.
 *
 *   KnowledgeChangeSetService  propose → validate → approve / reject; nothing reaches the active state any other way
 *   KnowledgeStateService      immutable states with reproducible digests; verify; compare; the head is the last approved
 *   EntityResolutionService    exact identifier or exact name → link; similar names → candidates for review, never a merge
 *   ConflictReconciliation     competing claims are both kept; resolved only by a declared precedence policy or a ruling
 *   KnowledgeQueryService      structured filters and BM25 search, pinned to a state id, returning evidence and authority
 *
 * Every domain-specific question (is this attribute valid for this entity type?) is delegated to the active packs.
 */
import { digestOf, idOf, type Digest } from './canonical.js';
import { checkTyped, PackSet, validatePackArtifact, type PackArtifact } from './packs.js';
import { IntegrityError, type KnowledgeStore } from './store.js';
import type {
  ChangeOperation,
  ChangeSet,
  ClaimRecord,
  Conflict,
  EntityRecord,
  KnowledgeRecord,
  KnowledgeState,
  PrecedencePolicy,
  ReconciliationReport,
  StateEntry,
  ValidationFinding,
} from './types.js';
import { TYPE_ID } from './types.js';

export type Actor = { readonly id: string; readonly kind: string };

export const NO_PRECEDENCE: PrecedencePolicy = { version: 'none', order: [] };

export class KnowledgeError extends Error {
  constructor(
    readonly code: 'not_found' | 'stale_base' | 'already_decided' | 'invalid_change_set' | 'integrity',
    message: string,
  ) {
    super(message);
  }
}

function stateDigest(s: Omit<KnowledgeState, 'stateId' | 'createdAt' | 'digest'>): Digest {
  return digestOf(s);
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export class KnowledgeBase {
  constructor(
    readonly store: KnowledgeStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  get tenantId(): string {
    return this.store.tenantId;
  }

  // ── packs ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Installs (stores and activates) a pack for this tenant. Installation grants no authority; it only adds semantics. */
  installPack(pack: PackArtifact, actor: Actor): Promise<void> {
    return this.store.exclusive(() => this.installPackLocked(pack, actor));
  }

  private async installPackLocked(pack: PackArtifact, actor: Actor): Promise<void> {
    const problems = validatePackArtifact(pack);
    if (problems.length > 0) throw new KnowledgeError('integrity', `pack ${pack.manifest.packId}: ${problems.join('; ')}`);
    const active = await this.packs();
    active.activate(pack); // throws on a namespace collision: never settled by install order
    await this.store.putPack(pack);
    await this.store.appendEvent({
      type: 'pack.installed',
      at: this.now(),
      actor,
      subjectId: pack.manifest.packId,
      subjectDigest: pack.digest,
    });
  }

  async packs(): Promise<PackSet> {
    return new PackSet(await this.store.listPacks());
  }

  // ── states ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The empty root state of this tenant (deterministic: the same for every store of the same tenant). */
  rootState(): KnowledgeState {
    const body = {
      schema: 'xo.knowledge-state.v1' as const,
      tenantId: this.tenantId,
      parentStateId: null,
      entries: [],
      conflicts: [],
      packBindings: [],
      precedencePolicy: NO_PRECEDENCE,
      changeSetId: null,
    };
    const digest = stateDigest(body);
    return { ...body, stateId: `ks_${digest.slice(7, 31)}`, createdAt: '1970-01-01T00:00:00.000Z', digest };
  }

  /** The current approved state: the one created by the last approval in the event log (the root when there is none). */
  async head(): Promise<KnowledgeState> {
    const events = await this.store.events();
    const last = [...events].reverse().find((e) => e.type === 'state.created');
    if (last === undefined) return this.rootState();
    const s = await this.store.getState(last.subjectId);
    if (s === undefined) throw new KnowledgeError('integrity', `the head state ${last.subjectId} is missing`);
    return s;
  }

  async state(stateId: string): Promise<KnowledgeState> {
    const root = this.rootState();
    if (stateId === root.stateId) return root;
    const s = await this.store.getState(stateId);
    if (s === undefined) throw new KnowledgeError('not_found', `knowledge state ${stateId}`);
    return s;
  }

  /**
   * Integrity of a state: its digest; every entry's record exists, belongs to this tenant and hashes to the recorded
   * digest; every relationship endpoint and claim entity is in the state; every active claim has authority; every
   * evidence link names a source version in `knownSourceDigests` (when given). An empty result means it verifies.
   */
  async verifyState(stateId: string, knownSourceDigests?: ReadonlySet<string>): Promise<readonly ValidationFinding[]> {
    const out: ValidationFinding[] = [];
    let s: KnowledgeState;
    try {
      s = await this.state(stateId);
    } catch (e) {
      return [{ severity: 'error', code: 'state-missing', message: (e as Error).message }];
    }
    const { stateId: _id, createdAt: _at, digest, ...body } = s;
    if (stateDigest(body) !== digest || `ks_${digest.slice(7, 31)}` !== s.stateId)
      out.push({ severity: 'error', code: 'state-digest', message: `state ${stateId} does not match its digest` });
    const ids = new Set(s.entries.map((e) => e.id));
    for (const e of s.entries) {
      let r: KnowledgeRecord | undefined;
      try {
        r = await this.store.getRecord(e.id);
      } catch (err) {
        out.push({ severity: 'error', code: 'record-unreadable', message: (err as Error).message, ref: e.id });
        continue;
      }
      if (r === undefined) {
        out.push({ severity: 'error', code: 'record-missing', message: `record ${e.id} is missing`, ref: e.id });
        continue;
      }
      if (digestOf(r) !== e.recordDigest)
        out.push({ severity: 'error', code: 'record-digest', message: `record ${e.id} was altered`, ref: e.id });
      if (r.kind === 'relationship' && (!ids.has(r.from) || !ids.has(r.to)))
        out.push({ severity: 'error', code: 'dangling-relationship', message: `relationship ${r.id} points outside the state`, ref: r.id });
      if (r.kind === 'claim') {
        if ('entityId' in r.subject && !ids.has(r.subject.entityId))
          out.push({ severity: 'error', code: 'dangling-claim', message: `claim ${r.id} is about an entity outside the state`, ref: r.id });
        if (e.lifecycle === 'active' && (r.authority === undefined || r.authority.basis.length === 0))
          out.push({ severity: 'error', code: 'claim-without-authority', message: `active claim ${r.id} has no authority`, ref: r.id });
      }
      if (r.evidence.length === 0 && r.derivation !== 'human')
        out.push({ severity: 'error', code: 'no-evidence', message: `record ${r.id} has no evidence`, ref: r.id });
      if (knownSourceDigests !== undefined)
        for (const ev of r.evidence)
          if (!knownSourceDigests.has(ev.sourceDigestSha256))
            out.push({
              severity: 'error',
              code: 'orphan-evidence',
              message: `record ${r.id} cites a source version that is not known (${ev.sourceDigestSha256.slice(0, 12)}…)`,
              ref: r.id,
            });
    }
    return out;
  }

  // ── change sets ────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Proposes a change set against the current head. It is validated now (findings recorded with it); nothing changes the
   * active state until it is approved. An empty change set is not stored: the report says everything was unchanged.
   */
  propose(input: {
    readonly operations: readonly ChangeOperation[];
    readonly origin: ChangeSet['origin'];
    readonly report?: ReconciliationReport;
    readonly proposedBy: Actor;
  }): Promise<ChangeSet | undefined> {
    return this.store.exclusive(() => this.proposeLocked(input));
  }

  private async proposeLocked(input: {
    readonly operations: readonly ChangeOperation[];
    readonly origin: ChangeSet['origin'];
    readonly report?: ReconciliationReport;
    readonly proposedBy: Actor;
  }): Promise<ChangeSet | undefined> {
    if (input.operations.length === 0) return undefined;
    const head = await this.head();
    const findings = await this.validate(head, input.operations);
    const identity = { tenantId: this.tenantId, baseStateId: head.stateId, operations: input.operations, origin: input.origin };
    const digest = digestOf(identity);
    const changeSet: ChangeSet = {
      schema: 'xo.knowledge-change-set.v1',
      changeSetId: `cs_${digest.slice(7, 31)}`,
      tenantId: this.tenantId,
      baseStateId: head.stateId,
      operations: input.operations,
      origin: input.origin,
      ...(input.report !== undefined ? { report: input.report } : {}),
      findings,
      status: 'proposed',
      proposedBy: input.proposedBy,
      proposedAt: this.now(),
      digest,
    };
    const existing = await this.store.getChangeSet(changeSet.changeSetId);
    if (existing !== undefined) return this.withDecision(existing);
    // Records naming another tenant are never written (the change set carries a cross-tenant error and cannot be approved).
    for (const op of input.operations) for (const r of recordsOf(op)) if (r.tenantId === this.tenantId) await this.store.putRecord(r);
    await this.store.putChangeSet(changeSet);
    await this.store.appendEvent({
      type: 'change-set.proposed',
      at: changeSet.proposedAt,
      actor: input.proposedBy,
      subjectId: changeSet.changeSetId,
      subjectDigest: digest,
    });
    return changeSet;
  }

  async changeSet(id: string): Promise<ChangeSet> {
    const c = await this.store.getChangeSet(id);
    if (c === undefined) throw new KnowledgeError('not_found', `change set ${id}`);
    return this.withDecision(c);
  }

  async changeSets(): Promise<readonly ChangeSet[]> {
    return Promise.all((await this.store.listChangeSets()).map((c) => this.withDecision(c)));
  }

  private async withDecision(c: ChangeSet): Promise<ChangeSet> {
    const d = await this.store.getDecision(c.changeSetId);
    return d === undefined
      ? c
      : {
          ...c,
          status: d.status,
          decision: {
            by: d.by,
            at: d.at,
            reason: d.reason,
            ...(d.resultingStateId !== undefined ? { resultingStateId: d.resultingStateId } : {}),
          },
        };
  }

  /**
   * Approves a proposed change set: refused when it has error findings, when it was decided already, or when the head has
   * moved since it was proposed (re-propose against the new head). Creates the next immutable state.
   */
  approve(changeSetId: string, reviewer: Actor, reason: string, policy: PrecedencePolicy = NO_PRECEDENCE): Promise<KnowledgeState> {
    return this.store.exclusive(() => this.approveLocked(changeSetId, reviewer, reason, policy));
  }

  private async approveLocked(changeSetId: string, reviewer: Actor, reason: string, policy: PrecedencePolicy): Promise<KnowledgeState> {
    const cs = await this.changeSet(changeSetId);
    if (cs.status !== 'proposed') throw new KnowledgeError('already_decided', `change set ${changeSetId} is already ${cs.status}`);
    const errors = cs.findings.filter((f) => f.severity === 'error');
    if (errors.length > 0)
      throw new KnowledgeError(
        'invalid_change_set',
        `change set ${changeSetId} has ${errors.length} error finding(s): ${errors.map((e) => e.message).join('; ')}`,
      );
    const head = await this.head();
    if (head.stateId !== cs.baseStateId)
      throw new KnowledgeError(
        'stale_base',
        `change set ${changeSetId} was proposed against ${cs.baseStateId}; the head is now ${head.stateId}. Propose it again.`,
      );
    const packs = await this.packs();
    const next = await this.apply(head, cs, packs, policy, reviewer);
    await this.store.putState(next);
    await this.store.putDecision({ changeSetId, status: 'approved', by: reviewer, at: this.now(), reason, resultingStateId: next.stateId });
    await this.store.appendEvent({
      type: 'change-set.approved',
      at: this.now(),
      actor: reviewer,
      subjectId: changeSetId,
      subjectDigest: cs.digest,
    });
    await this.store.appendEvent({
      type: 'state.created',
      at: this.now(),
      actor: reviewer,
      subjectId: next.stateId,
      subjectDigest: next.digest,
    });
    return next;
  }

  /** Rejects a proposed change set. Its records stay stored (auditable) but never enter a state through it. */
  reject(changeSetId: string, reviewer: Actor, reason: string): Promise<void> {
    return this.store.exclusive(() => this.rejectLocked(changeSetId, reviewer, reason));
  }

  private async rejectLocked(changeSetId: string, reviewer: Actor, reason: string): Promise<void> {
    const cs = await this.changeSet(changeSetId);
    if (cs.status !== 'proposed') throw new KnowledgeError('already_decided', `change set ${changeSetId} is already ${cs.status}`);
    await this.store.putDecision({ changeSetId, status: 'rejected', by: reviewer, at: this.now(), reason });
    await this.store.appendEvent({
      type: 'change-set.rejected',
      at: this.now(),
      actor: reviewer,
      subjectId: changeSetId,
      subjectDigest: cs.digest,
    });
  }

  private async validate(head: KnowledgeState, ops: readonly ChangeOperation[]): Promise<readonly ValidationFinding[]> {
    const out: ValidationFinding[] = [];
    const packs = await this.packs();
    const inState = new Set(head.entries.filter((e) => e.lifecycle === 'active' || e.lifecycle === 'needs_review').map((e) => e.id));
    const added = new Set(ops.flatMap((o) => recordsOf(o).map((r) => r.id)));
    const known = (id: string): boolean => inState.has(id) || added.has(id);
    for (const op of ops) {
      for (const r of recordsOf(op)) {
        if (r.tenantId !== this.tenantId)
          out.push({ severity: 'error', code: 'cross-tenant', message: `record ${r.id} names another tenant`, ref: r.id });
        if (!TYPE_ID.test(r.type))
          out.push({ severity: 'error', code: 'bad-type', message: `"${r.type}" is not a namespaced type id`, ref: r.id });
        if (r.evidence.length === 0 && r.derivation !== 'human')
          out.push({
            severity: 'error',
            code: 'no-evidence',
            message: `record ${r.id} has no evidence (only a person may assert without a source)`,
            ref: r.id,
          });
        const group = r.kind === 'entity' ? 'entityTypes' : r.kind === 'claim' ? 'predicates' : 'relationshipTypes';
        const value = r.kind === 'entity' ? r.attributes : r.kind === 'claim' ? ('value' in r.object ? r.object.value : null) : null;
        const check = checkTyped(packs, group, r.kind === 'claim' ? r.predicate : r.type, value);
        if (check.status === 'invalid')
          out.push({ severity: 'error', code: 'schema', message: `record ${r.id}: ${check.problems.join('; ')}`, ref: r.id });
        if (check.status === 'unsupported')
          out.push({
            severity: 'warning',
            code: 'unsupported-namespace',
            message: `no installed pack defines "${(r.kind === 'claim' ? r.predicate : r.type).split(':')[0]}"; record ${r.id} is kept but not interpreted`,
            ref: r.id,
          });
        if (r.kind === 'relationship' && (!known(r.from) || !known(r.to)))
          out.push({
            severity: 'error',
            code: 'dangling-relationship',
            message: `relationship ${r.id} points at a record that is not in the state or the change set`,
            ref: r.id,
          });
        if (r.kind === 'claim' && 'entityId' in r.subject && !known(r.subject.entityId))
          out.push({
            severity: 'error',
            code: 'dangling-claim',
            message: `claim ${r.id} is about an entity that is not in the state or the change set`,
            ref: r.id,
          });
      }
      if ((op.op === 'supersede' || op.op === 'retire') && !inState.has(op.recordId))
        out.push({
          severity: 'error',
          code: 'unknown-record',
          message: `${op.op} names ${op.recordId}, which is not active in the base state`,
          ref: op.recordId,
        });
      if (op.op === 'merge-entities')
        for (const id of [...op.from, op.into])
          if (!known(id))
            out.push({ severity: 'error', code: 'unknown-record', message: `merge names ${id}, which is not in the state`, ref: id });
      if (op.op === 'resolve-conflict' && !head.conflicts.some((c) => c.id === op.conflictId))
        out.push({
          severity: 'error',
          code: 'unknown-conflict',
          message: `conflict ${op.conflictId} is not in the base state`,
          ref: op.conflictId,
        });
    }
    return out;
  }

  private async apply(
    head: KnowledgeState,
    cs: ChangeSet,
    packs: PackSet,
    policy: PrecedencePolicy,
    reviewer: Actor,
  ): Promise<KnowledgeState> {
    const entries = new Map<string, StateEntry>(head.entries.map((e) => [e.id, e]));
    const conflicts = new Map<string, Conflict>(head.conflicts.map((c) => [c.id, c]));
    const entryFor = (r: KnowledgeRecord, lifecycle: StateEntry['lifecycle']): StateEntry => {
      const group = r.kind === 'entity' ? 'entityTypes' : r.kind === 'claim' ? 'predicates' : 'relationshipTypes';
      const unsupported = checkTyped(packs, group, r.kind === 'claim' ? r.predicate : r.type, null).status === 'unsupported';
      return {
        id: r.id,
        kind: r.kind,
        recordDigest: digestOf(r),
        lifecycle,
        ...(unsupported ? { interpretation: 'unsupported' as const } : {}),
      };
    };
    for (const op of cs.operations) {
      switch (op.op) {
        case 'add': {
          const current = entries.get(op.record.id);
          if (current === undefined || current.lifecycle === 'rejected') entries.set(op.record.id, entryFor(op.record, 'active'));
          break;
        }
        case 'supersede': {
          const old = entries.get(op.recordId)!;
          entries.set(op.recordId, { ...old, lifecycle: 'superseded' });
          entries.set(op.by.id, entryFor(op.by, 'active'));
          break;
        }
        case 'retire':
          entries.set(op.recordId, { ...entries.get(op.recordId)!, lifecycle: op.lifecycle });
          break;
        case 'merge-entities':
          for (const id of op.from) entries.set(id, { ...entries.get(id)!, lifecycle: 'superseded', mergedInto: op.into });
          break;
        case 'split-entity':
          entries.set(op.entityId, { ...entries.get(op.entityId)!, lifecycle: 'superseded' });
          for (const e of op.into) entries.set(e.id, entryFor(e, 'active'));
          break;
        case 'resolve-conflict': {
          const c = conflicts.get(op.conflictId)!;
          conflicts.set(op.conflictId, {
            ...c,
            status: 'resolved-by-ruling',
            prevailing: op.prevailing,
            resolution: { by: reviewer.id, at: this.now(), rationale: op.rationale },
          });
          break;
        }
      }
    }
    // Conflicts among active claims: kept, never overwritten; resolutions carried forward.
    const claims: ClaimRecord[] = [];
    for (const e of entries.values()) {
      if (e.kind !== 'claim' || e.lifecycle !== 'active') continue;
      const r = (await this.store.getRecord(e.id)) as ClaimRecord | undefined;
      if (r !== undefined) claims.push(r);
    }
    for (const c of detectConflicts(claims, policy)) if (!conflicts.has(c.id)) conflicts.set(c.id, c);
    const activeIds = new Set(claims.map((c) => c.id));
    for (const [id, c] of conflicts) if (!activeIds.has(c.claims[0]) || !activeIds.has(c.claims[1])) conflicts.delete(id);
    const body = {
      schema: 'xo.knowledge-state.v1' as const,
      tenantId: this.tenantId,
      parentStateId: head.stateId,
      entries: [...entries.values()].sort((a, b) => a.id.localeCompare(b.id)),
      conflicts: [...conflicts.values()].sort((a, b) => a.id.localeCompare(b.id)),
      packBindings: packs.bindings(),
      precedencePolicy: policy,
      changeSetId: cs.changeSetId,
    };
    const digest = stateDigest(body);
    return { ...body, stateId: `ks_${digest.slice(7, 31)}`, createdAt: this.now(), digest };
  }

  // ── reading ────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The records of a state with their entries, optionally filtered. Only that state's content: never later knowledge. */
  async records(
    stateId: string,
    filter: { readonly kind?: KnowledgeRecord['kind']; readonly type?: string; readonly lifecycle?: StateEntry['lifecycle'] | 'any' } = {},
  ): Promise<readonly { readonly entry: StateEntry; readonly record: KnowledgeRecord }[]> {
    const s = await this.state(stateId);
    const out: { entry: StateEntry; record: KnowledgeRecord }[] = [];
    for (const entry of s.entries) {
      if (filter.kind !== undefined && entry.kind !== filter.kind) continue;
      if ((filter.lifecycle ?? 'active') !== 'any' && entry.lifecycle !== (filter.lifecycle ?? 'active')) continue;
      const record = await this.store.getRecord(entry.id);
      if (record === undefined) throw new KnowledgeError('integrity', `record ${entry.id} of state ${stateId} is missing`);
      if (digestOf(record) !== entry.recordDigest)
        throw new KnowledgeError('integrity', `record ${entry.id} of state ${stateId} was altered`);
      if (filter.type !== undefined && (record.kind === 'claim' ? record.predicate : record.type) !== filter.type) continue;
      out.push({ entry, record });
    }
    return out;
  }

  /**
   * Entity resolution against a state: an exact strong identifier links; an exact name or alias of the same type links
   * when it is the only one; several exact matches, or only similar names, return candidates and `unresolved` — a person
   * decides. Nothing is ever merged here.
   */
  async resolveEntity(
    stateId: string,
    query: { readonly name: string; readonly type?: string; readonly identifiers?: readonly { scheme: string; value: string }[] },
  ): Promise<{
    readonly status: 'linked' | 'unresolved';
    readonly entityId?: string;
    readonly method?: 'identifier' | 'exact-name';
    readonly candidates: readonly { readonly entityId: string; readonly score: number; readonly method: string }[];
  }> {
    const entities = (await this.records(stateId, { kind: 'entity' }))
      .map((x) => x.record as EntityRecord)
      .filter((e) => query.type === undefined || e.type === query.type);
    for (const id of query.identifiers ?? []) {
      const hits = entities.filter((e) => e.identifiers.some((x) => x.scheme === id.scheme && x.value === id.value));
      if (hits.length === 1) return { status: 'linked', entityId: hits[0]!.id, method: 'identifier', candidates: [] };
      if (hits.length > 1)
        return { status: 'unresolved', candidates: hits.map((h) => ({ entityId: h.id, score: 1, method: 'identifier (duplicate)' })) };
    }
    const n = norm(query.name);
    const exact = entities.filter((e) => norm(e.canonicalName) === n || e.aliases.some((a) => norm(a) === n));
    if (exact.length === 1) return { status: 'linked', entityId: exact[0]!.id, method: 'exact-name', candidates: [] };
    if (exact.length > 1)
      return { status: 'unresolved', candidates: exact.map((e) => ({ entityId: e.id, score: 1, method: 'exact-name (ambiguous)' })) };
    const similar = entities
      .map((e) => ({ entityId: e.id, score: Math.max(jaccard(n, norm(e.canonicalName)), ...e.aliases.map((a) => jaccard(n, norm(a)))) }))
      .filter((c) => c.score >= 0.5)
      .sort((a, b) => b.score - a.score)
      .map((c) => ({ ...c, method: 'similar-name' }));
    return { status: 'unresolved', candidates: similar };
  }

  /** BM25 search over a state's active records (a derived index, rebuilt from the state on every call). */
  async search(stateId: string, text: string, limit = 10): Promise<readonly SearchHit[]> {
    const docs = (await this.records(stateId)).map(({ entry, record }) => ({ entry, record, tokens: tokens(searchText(record)) }));
    const q = [...new Set(tokens(text))];
    if (q.length === 0 || docs.length === 0) return [];
    const avg = docs.reduce((n, d) => n + d.tokens.length, 0) / docs.length;
    const df = new Map<string, number>();
    for (const d of docs) for (const t of new Set(d.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
    const k1 = 1.2;
    const b = 0.75;
    const scored = docs
      .map((d) => {
        let score = 0;
        for (const t of q) {
          const f = d.tokens.filter((x) => x === t).length;
          if (f === 0) continue;
          const idf = Math.log(1 + (docs.length - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
          score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.tokens.length) / avg)));
        }
        return { d, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b2) => b2.score - a.score || a.d.record.id.localeCompare(b2.d.record.id))
      .slice(0, limit);
    return scored.map(({ d, score }) => ({
      stateId,
      recordId: d.record.id,
      kind: d.record.kind,
      type: d.record.kind === 'claim' ? d.record.predicate : d.record.type,
      text: searchText(d.record),
      lifecycle: d.entry.lifecycle,
      ...(d.record.kind === 'claim' ? { authority: d.record.authority } : {}),
      evidence: d.record.evidence,
      score: Math.round(score * 1000) / 1000,
    }));
  }
}

export interface SearchHit {
  readonly stateId: string;
  readonly recordId: string;
  readonly kind: KnowledgeRecord['kind'];
  readonly type: string;
  readonly text: string;
  readonly lifecycle: StateEntry['lifecycle'];
  readonly authority?: ClaimRecord['authority'];
  readonly evidence: KnowledgeRecord['evidence'];
  readonly score: number;
}

function recordsOf(op: ChangeOperation): readonly KnowledgeRecord[] {
  if (op.op === 'add') return [op.record];
  if (op.op === 'supersede') return [op.by];
  if (op.op === 'split-entity') return op.into;
  return [];
}

function searchText(r: KnowledgeRecord): string {
  if (r.kind === 'entity') return [r.canonicalName, ...r.aliases].join(' ');
  if (r.kind === 'claim') return r.text;
  return r.type;
}

function tokens(s: string): string[] {
  return norm(s)
    .split(' ')
    .filter((t) => t.length > 1);
}

function jaccard(a: string, b: string): number {
  const A = new Set(a.split(' '));
  const B = new Set(b.split(' '));
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / (A.size + B.size - inter || 1);
}

function overlaps(a: ClaimRecord['validity'], b: ClaimRecord['validity']): boolean {
  const aFrom = a?.from ?? '0000';
  const aTo = a?.to ?? '9999';
  const bFrom = b?.from ?? '0000';
  const bTo = b?.to ?? '9999';
  return aFrom <= bTo && bFrom <= aTo;
}

const subjectKey = (c: ClaimRecord): string => ('entityId' in c.subject ? `e:${c.subject.entityId}` : `l:${norm(c.subject.literal)}`);

/**
 * Two active claims conflict when they are about the same subject, with the same predicate and scope, valid at overlapping
 * times, and say different things (object or polarity). With a precedence policy the claim whose authority level or source
 * ranks higher prevails; otherwise the conflict stays unresolved for a person.
 */
export function detectConflicts(claims: readonly ClaimRecord[], policy: PrecedencePolicy = NO_PRECEDENCE): readonly Conflict[] {
  const groups = new Map<string, ClaimRecord[]>();
  for (const c of claims) {
    const k = `${subjectKey(c)}|${c.predicate}|${c.scope ?? ''}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const out: Conflict[] = [];
  for (const list of groups.values()) {
    for (let i = 0; i < list.length; i += 1)
      for (let j = i + 1; j < list.length; j += 1) {
        const [a, b] = [list[i]!, list[j]!].sort((x, y) => x.id.localeCompare(y.id)) as [ClaimRecord, ClaimRecord];
        const differs = digestOf(a.object) !== digestOf(b.object) || a.polarity !== b.polarity;
        if (!differs || !overlaps(a.validity, b.validity)) continue;
        const rank = (c: ClaimRecord): number =>
          Math.max(policy.order.indexOf(c.authority.level), ...c.evidence.map((e) => policy.order.indexOf(e.sourceName)));
        const ra = rank(a);
        const rb = rank(b);
        const id = idOf('cfl', [a.id, b.id]);
        const reason = `both are about the same subject and predicate at overlapping times but say different things`;
        if (policy.order.length > 0 && ra !== rb && Math.max(ra, rb) >= 0)
          out.push({
            id,
            claims: [a.id, b.id],
            reason,
            status: 'resolved-by-precedence',
            prevailing: ra > rb ? a.id : b.id,
            resolution: {
              by: `precedence policy ${policy.version}`,
              at: '',
              rationale: `ranks higher in precedence policy ${policy.version}`,
            },
          });
        else out.push({ id, claims: [a.id, b.id], reason, status: 'unresolved' });
      }
  }
  return out;
}

export { IntegrityError };
