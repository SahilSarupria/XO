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
import { stateContentRoot, StaleHeadError } from './state-root.js';
import {
  buildKnowledgeIndex,
  indexMismatch,
  indexText,
  queryKnowledgeIndex,
  type IndexQuery,
  type KnowledgeIndex,
} from './retrieval-index.js';
import type {
  ChangeOperation,
  ChangeSet,
  ChangeSetPreview,
  StateDiff,
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

  /**
   * The current approved state: the one created by the last approval in the event log (the root when there is none). Reading
   * it verifies the whole event chain, as before. A store with a head pointer (schema 2 SQL) must agree with the log — the
   * pointer is what approvals compare-and-swap, the log is what proves it — and a disagreement is an integrity fault, never
   * silently resolved either way.
   */
  async head(): Promise<KnowledgeState> {
    const fromEvents = await this.headFromEvents();
    if (this.store.getHead !== undefined) {
      const ptr = await this.store.getHead();
      const expected = fromEvents.changeSetId === null ? undefined : fromEvents.stateId;
      if (ptr?.stateId !== expected)
        throw new KnowledgeError(
          'integrity',
          `the knowledge head pointer names ${ptr?.stateId ?? 'the empty root'} but the event log names ${expected ?? 'the empty root'}`,
        );
    }
    return fromEvents;
  }

  private async headFromEvents(): Promise<KnowledgeState> {
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
    /** UW-11a: findings the caller adds (warnings only; an error finding is refused). */
    readonly extraFindings?: readonly ValidationFinding[];
  }): Promise<ChangeSet | undefined> {
    return this.store.exclusive(() => this.proposeLocked(input));
  }

  private async proposeLocked(input: {
    readonly operations: readonly ChangeOperation[];
    readonly origin: ChangeSet['origin'];
    readonly report?: ReconciliationReport;
    readonly proposedBy: Actor;
    readonly extraFindings?: readonly ValidationFinding[];
  }): Promise<ChangeSet | undefined> {
    if (input.operations.length === 0) return undefined;
    if ((input.extraFindings ?? []).some((f) => f.severity === 'error'))
      throw new KnowledgeError('invalid_change_set', 'a caller may add warnings to a change set, never errors');
    const head = await this.head();
    const findings = [...(await this.validate(head, input.operations, input.origin)), ...(input.extraFindings ?? [])];
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
    const created = await this.store.appendEvent({
      type: 'state.created',
      at: this.now(),
      actor: reviewer,
      subjectId: next.stateId,
      subjectDigest: next.digest,
    });
    // Same transaction: the state, its decision, both events and the head move together or not at all.
    if (this.store.casHead !== undefined) {
      try {
        await this.store.casHead(head.changeSetId === null ? null : head.stateId, {
          stateId: next.stateId,
          contentRoot: stateContentRoot(next),
          eventSeq: created.seq,
        });
      } catch (e) {
        if (e instanceof StaleHeadError)
          throw new KnowledgeError('stale_base', `change set ${changeSetId}: ${e.message}. Propose it again.`);
        throw e;
      }
    }
    return next;
  }

  /**
   * UW-11a: the state approval would create, computed against the current head and never stored. `stale` says the head has
   * moved since the change set was proposed (it must be proposed again). When the change set resolves a conflict, the
   * resolution time differs from the approval's, so the preview's digest then differs from the approved state's.
   */
  async previewApproval(changeSetId: string, policy: PrecedencePolicy = NO_PRECEDENCE): Promise<ChangeSetPreview> {
    const cs = await this.changeSet(changeSetId);
    if (cs.status !== 'proposed') throw new KnowledgeError('already_decided', `change set ${changeSetId} is already ${cs.status}`);
    const head = await this.head();
    const packs = await this.packs();
    const next = await this.apply(head, cs, packs, policy, { id: 'preview', kind: 'preview' });
    return {
      changeSetId,
      baseStateId: cs.baseStateId,
      headStateId: head.changeSetId === null ? null : head.stateId,
      stale: head.stateId !== cs.baseStateId,
      nextState: next,
      contentRoot: stateContentRoot(next),
      diff: diffStates(head, next),
      findings: cs.findings,
    };
  }

  private readonly evidenceDigestCache = new Map<string, readonly string[]>();

  /**
   * UW-11a (ADR 0050 decision 1): a digest over the knowledge a certificate depends on: every record whose evidence cites one
   * of `sourceDigests` (id, record digest, lifecycle, merge target), the conflicts naming those records, and the pack bindings.
   * A change anywhere else leaves it unchanged.
   */
  async dependencyRoot(stateId: string, sourceDigests: ReadonlySet<string>): Promise<string> {
    return this.dependencyRootOf(await this.state(stateId), sourceDigests);
  }

  /** As `dependencyRoot`, for a state that may not be stored (a preview). */
  async dependencyRootOf(state: KnowledgeState, sourceDigests: ReadonlySet<string>): Promise<string> {
    const picked: StateEntry[] = [];
    for (const e of state.entries) {
      let digests = this.evidenceDigestCache.get(e.recordDigest);
      if (digests === undefined) {
        const r = await this.store.getRecord(e.id);
        if (r === undefined) throw new KnowledgeError('integrity', `record ${e.id} of state ${state.stateId} is missing`);
        digests = r.evidence.map((x) => x.sourceDigestSha256);
        if (this.evidenceDigestCache.size >= 20000) this.evidenceDigestCache.clear();
        this.evidenceDigestCache.set(e.recordDigest, digests);
      }
      if (digests.some((d) => sourceDigests.has(d))) picked.push(e);
    }
    const ids = new Set(picked.map((e) => e.id));
    const conflicts = state.conflicts.filter((c) => ids.has(c.claims[0]) || ids.has(c.claims[1]));
    return digestOf({
      v: 1,
      entries: picked
        .map((e) => ({ id: e.id, recordDigest: e.recordDigest, lifecycle: e.lifecycle, mergedInto: e.mergedInto ?? null }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      conflicts: conflicts
        .map((c) => ({ id: c.id, claims: c.claims, status: c.status, prevailing: c.prevailing ?? null }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      packs: state.packBindings,
    });
  }

  /**
   * UW-11a (ADR 0050 decision 4): a rollback goes forward. It proposes a change set that brings content and lifecycle back to
   * an ancestor state; approving it creates a new state, and history is never rewritten.
   */
  proposeRollback(
    toStateId: string,
    proposedBy: Actor,
    reason: string,
    extraFindings: readonly ValidationFinding[] = [],
  ): Promise<ChangeSet> {
    return this.store.exclusive(async () => {
      const head = await this.head();
      let cursor: KnowledgeState = head;
      let found: KnowledgeState | undefined;
      while (cursor.parentStateId !== null) {
        cursor = await this.state(cursor.parentStateId);
        if (cursor.stateId === toStateId) {
          found = cursor;
          break;
        }
      }
      if (found === undefined && toStateId === this.rootState().stateId && head.stateId !== toStateId) found = this.rootState();
      if (found === undefined) throw new KnowledgeError('invalid_change_set', 'rollback-target: the state is not an ancestor of the head');
      const target = found;
      const targetEntries = new Map(target.entries.map((e) => [e.id, e]));
      const live = (l: StateEntry['lifecycle']): boolean => l === 'active' || l === 'needs_review';
      const ops: ChangeOperation[] = [];
      for (const e of [...head.entries].sort((a, b) => a.id.localeCompare(b.id))) {
        const t = targetEntries.get(e.id);
        if (t === undefined) {
          if (live(e.lifecycle))
            ops.push({ op: 'retire', recordId: e.id, lifecycle: 'expired', reason: `rollback to ${toStateId}: ${reason}` });
        } else if (e.lifecycle !== t.lifecycle || e.mergedInto !== t.mergedInto) {
          if (live(t.lifecycle)) ops.push({ op: 'restore', recordId: e.id, lifecycle: t.lifecycle as 'active' | 'needs_review', reason });
          else if (live(e.lifecycle))
            ops.push({ op: 'retire', recordId: e.id, lifecycle: 'expired', reason: `rollback to ${toStateId}: ${reason}` });
        }
      }
      if (ops.length === 0) throw new KnowledgeError('invalid_change_set', 'rollback-target: nothing differs from that state');
      const cs = await this.proposeLocked({
        operations: ops,
        origin: { kind: 'rollback', ref: toStateId },
        proposedBy,
        extraFindings,
      });
      return cs!;
    });
  }

  /** UW-11a validators (ADR 0050 decision 3). */
  private async validateChangeManagement(
    head: KnowledgeState,
    ops: readonly ChangeOperation[],
    origin: ChangeSet['origin'],
  ): Promise<readonly ValidationFinding[]> {
    const out: ValidationFinding[] = [];
    const added = ops.flatMap((o) => recordsOf(o));
    const manualOrImport = origin.kind === 'manual' || origin.kind === 'import';
    for (const r of added) {
      if (r.kind === 'claim') {
        if (r.authority.level === 'authoritative' && !manualOrImport)
          out.push({
            severity: 'error',
            code: 'authority-escalation',
            message: `claim ${r.id} asserts authoritative knowledge; only a manual or imported change may`,
            ref: r.id,
          });
        if ((r.derivation === 'model' || origin.kind === 'run-outcome') && r.authority.level !== 'source')
          out.push({
            severity: 'error',
            code: 'authority-escalation',
            message: `claim ${r.id} is model- or run-derived and may not be above source authority until reviewed`,
            ref: r.id,
          });
      }
    }
    for (const op of ops)
      if (op.op === 'restore' && origin.kind !== 'rollback')
        out.push({
          severity: 'error',
          code: 'restore-outside-rollback',
          message: `restore of ${op.recordId} is valid only in a rollback`,
          ref: op.recordId,
        });
    // Implementation choice (recorded in the PR): only retiring an ENTITY that an active record still points at is an error.
    // Superseding keeps the old record resolvable (its replacement exists), and a relationship may point at a claim.
    const removed = new Set<string>();
    const gone = new Set<string>();
    const kindOf = new Map(head.entries.map((e) => [e.id, e.kind]));
    for (const op of ops) {
      if (op.op === 'retire' || op.op === 'supersede') gone.add(op.recordId);
      if (op.op === 'retire' && kindOf.get(op.recordId) === 'entity') removed.add(op.recordId);
    }
    const needsRecords = removed.size > 0 || added.some((r) => r.kind === 'claim');
    if (needsRecords) {
      const live = head.entries.filter((e) => e.lifecycle === 'active');
      const loaded: KnowledgeRecord[] = [];
      for (const e of live) {
        const r = await this.store.getRecord(e.id);
        if (r !== undefined) loaded.push(r);
      }
      for (const r of loaded) {
        if (gone.has(r.id)) continue;
        const refs =
          r.kind === 'relationship'
            ? [r.from, r.to]
            : r.kind === 'claim'
              ? [...('entityId' in r.subject ? [r.subject.entityId] : []), ...('entityId' in r.object ? [r.object.entityId] : [])]
              : [];
        for (const ref of refs)
          if (removed.has(ref))
            out.push({
              severity: 'error',
              code: 'dependency',
              message: `${ref} is still referenced by active record ${r.id}; retire or supersede that too`,
              ref,
            });
      }
      const stripped = (r: KnowledgeRecord): string => {
        const { id: _i, recordedAt: _t, ...rest } = r as unknown as Record<string, unknown>;
        return digestOf(rest as never);
      };
      const liveDigests = new Map(loaded.map((r) => [stripped(r), r.id] as const));
      const liveClaims = loaded.filter((r): r is ClaimRecord => r.kind === 'claim');
      for (const r of added) {
        const dup = liveDigests.get(stripped(r));
        if (dup !== undefined && dup !== r.id)
          out.push({ severity: 'warning', code: 'duplicate-content', message: `record ${r.id} repeats active record ${dup}`, ref: r.id });
        if (r.kind === 'claim')
          for (const c of liveClaims)
            if (
              c.id !== r.id &&
              subjectKey(c) === subjectKey(r) &&
              c.predicate === r.predicate &&
              (c.polarity !== r.polarity || digestOf(c.object) !== digestOf(r.object))
            )
              out.push({
                severity: 'warning',
                code: 'contradiction',
                message: `claim ${r.id} says something different from active claim ${c.id} on the same subject and predicate`,
                ref: r.id,
              });
      }
    }
    return out;
  }

  /**
   * UW-4b: the head pointer agrees with the event log (it names the state of the last `state.created` event, at that event's
   * sequence) and with the state's content. An empty result means it verifies; a store without a pointer always does.
   */
  async verifyHead(): Promise<readonly ValidationFinding[]> {
    if (this.store.getHead === undefined) return [];
    const ptr = await this.store.getHead();
    const events = await this.store.events();
    const last = [...events].reverse().find((e) => e.type === 'state.created');
    const out: ValidationFinding[] = [];
    if (ptr === undefined) {
      if (last !== undefined)
        out.push({
          severity: 'error',
          code: 'head-missing',
          message: `the event log names head ${last.subjectId}, but no head pointer is stored`,
        });
      return out;
    }
    if (last === undefined || last.subjectId !== ptr.stateId || last.seq !== ptr.eventSeq)
      out.push({
        severity: 'error',
        code: 'head-diverged',
        message: `the head pointer names ${ptr.stateId} (event ${ptr.eventSeq}); the event log names ${last?.subjectId ?? 'the root'} (event ${last?.seq ?? 0})`,
      });
    const s = await this.store.getState(ptr.stateId);
    if (s === undefined) out.push({ severity: 'error', code: 'head-missing', message: `the head state ${ptr.stateId} is missing` });
    else if (stateContentRoot(s) !== ptr.contentRoot)
      out.push({ severity: 'error', code: 'head-content-root', message: `the head's content root does not match state ${ptr.stateId}` });
    return out;
  }

  /** The content root of a state (see `stateContentRoot`). */
  async contentRoot(stateId: string): Promise<string> {
    return stateContentRoot(await this.state(stateId));
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

  private async validate(
    head: KnowledgeState,
    ops: readonly ChangeOperation[],
    origin: ChangeSet['origin'],
  ): Promise<readonly ValidationFinding[]> {
    const out: ValidationFinding[] = [];
    out.push(...(await this.validateChangeManagement(head, ops, origin)));
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
      if (op.op === 'restore' && !head.entries.some((e) => e.id === op.recordId))
        out.push({
          severity: 'error',
          code: 'unknown-record',
          message: `restore names ${op.recordId}, which is not in the base state`,
          ref: op.recordId,
        });
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
        case 'restore': {
          const { mergedInto: _m, ...rest } = entries.get(op.recordId)!;
          entries.set(op.recordId, { ...rest, lifecycle: op.lifecycle });
          break;
        }
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

  private readonly indexCache = new Map<string, KnowledgeIndex>();

  /**
   * UW-4c: the retrieval index of a state — read from the store and checked when it was persisted, otherwise built from the
   * state's records and persisted (stores that keep indexes). States are immutable, so an index is never rebuilt for a reason
   * other than not having one; `rebuild` forces it (the result must equal the stored one, or the stored one is refused).
   */
  async index(stateId: string, options: { readonly rebuild?: boolean } = {}): Promise<KnowledgeIndex> {
    const cached = options.rebuild === true ? undefined : this.indexCache.get(stateId);
    if (cached !== undefined) return cached;
    const state = await this.state(stateId);
    const stored = options.rebuild === true ? undefined : await this.store.getIndex?.<KnowledgeIndex>(stateId);
    let index: KnowledgeIndex;
    if (stored !== undefined) {
      const why = indexMismatch(stored, state);
      if (why !== undefined) throw new KnowledgeError('integrity', `the stored index of state ${stateId} cannot be used: ${why}`);
      index = stored;
    } else {
      const records = new Map((await this.records(stateId, { lifecycle: 'any' })).map((x) => [x.record.id, x.record]));
      index = buildKnowledgeIndex(state, records);
      // Write-once and content-addressed: a concurrent builder writes the same bytes; a different stored index is refused.
      if (this.store.putIndex !== undefined) {
        try {
          await this.store.putIndex(stateId, index);
        } catch (e) {
          if (e instanceof IntegrityError)
            throw new KnowledgeError('integrity', `the stored index of state ${stateId} differs from a rebuild: ${e.message}`);
          throw e;
        }
      }
    }
    if (this.indexCache.size >= 16) this.indexCache.delete(this.indexCache.keys().next().value!);
    this.indexCache.set(stateId, index);
    return index;
  }

  /**
   * BM25 search over a state, through its retrieval index. By default only approved (`active`) records are searched; pass
   * `lifecycle` to include others (review screens). Each hit's record is read and checked against the state.
   */
  async search(stateId: string, text: string, limit = 10, options: Omit<IndexQuery, 'text' | 'limit'> = {}): Promise<readonly SearchHit[]> {
    const index = await this.index(stateId);
    const state = await this.state(stateId);
    const entries = new Map(state.entries.map((e) => [e.id, e]));
    const hits = queryKnowledgeIndex(index, { ...options, text, limit });
    const out: SearchHit[] = [];
    for (const h of hits) {
      const entry = entries.get(h.id)!;
      const record = await this.store.getRecord(h.id);
      if (record === undefined) throw new KnowledgeError('integrity', `record ${h.id} of state ${stateId} is missing`);
      if (digestOf(record) !== entry.recordDigest) throw new KnowledgeError('integrity', `record ${h.id} of state ${stateId} was altered`);
      out.push({
        stateId,
        recordId: record.id,
        kind: record.kind,
        type: record.kind === 'claim' ? record.predicate : record.type,
        text: indexText(record),
        lifecycle: entry.lifecycle,
        ...(record.kind === 'claim' ? { authority: record.authority } : {}),
        evidence: record.evidence,
        score: h.score,
      });
    }
    return out;
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

function diffStates(head: KnowledgeState, next: KnowledgeState): StateDiff {
  const before = new Map(head.entries.map((e) => [e.id, e]));
  const live = (l: StateEntry['lifecycle']): boolean => l === 'active' || l === 'needs_review';
  const added: string[] = [];
  const superseded: string[] = [];
  const retired: string[] = [];
  const restored: string[] = [];
  const merged: string[] = [];
  for (const e of next.entries) {
    const b = before.get(e.id);
    if (b === undefined) added.push(e.id);
    else if (e.mergedInto !== undefined && b.mergedInto === undefined) merged.push(e.id);
    else if (b.lifecycle !== e.lifecycle) {
      if (e.lifecycle === 'superseded') superseded.push(e.id);
      else if (e.lifecycle === 'expired' || e.lifecycle === 'rejected') retired.push(e.id);
      else if (live(e.lifecycle) && !live(b.lifecycle)) restored.push(e.id);
    }
  }
  const beforeConflicts = new Map(head.conflicts.map((c) => [c.id, c]));
  const nextConflicts = new Map(next.conflicts.map((c) => [c.id, c]));
  return {
    added,
    superseded,
    retired,
    restored,
    merged,
    conflictsOpened: next.conflicts.filter((c) => !beforeConflicts.has(c.id) && c.status === 'unresolved').map((c) => c.id),
    conflictsResolved: head.conflicts
      .filter((c) => c.status === 'unresolved' && (nextConflicts.get(c.id)?.status ?? 'resolved-by-ruling') !== 'unresolved')
      .map((c) => c.id),
  };
}

function recordsOf(op: ChangeOperation): readonly KnowledgeRecord[] {
  if (op.op === 'add') return [op.record];
  if (op.op === 'supersede') return [op.by];
  if (op.op === 'split-entity') return op.into;
  return [];
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
