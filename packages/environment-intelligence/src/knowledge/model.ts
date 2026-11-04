import { stableDigest } from '../ids.js';
import type { EvidenceLedger } from '../evidence-ledger.js';
import { NO_AUTOMATIC_RESOLUTION, type ResolutionPolicy } from './view.js';
import type { Assertion, BatchRecord, ReviewDecision } from './types.js';

/** Hard ceilings. Requested limits are clamped to them, never raised. */
export const MAX_ASSERTIONS = 50_000;
export const MAX_DECISIONS = 2_000;
export const MAX_BATCHES = 5_000;

/**
 * The model's ONLY state: atomic assertions (one evidence each), the batch records that let provenance be re-verified, and the
 * explicit review decisions. Entities, relationships, facts and conflicts are NOT stored: they are views computed from the assertions
 * that are eligible and visible at the moment of each query (`buildView`), so there is nothing that can go stale, nothing that can
 * keep serving a tombstoned or revoked item, and replaying the same evidence cannot create a duplicate.
 *
 * Persistence: NONE. The model holds no content-derived state that must outlive the process. Eligibility is the ledger's (durable),
 * and the model is recomputed from eligible evidence after a restart (`deriveKnowledge` with an evidence reader). Review decisions are
 * memory-only in C5 (see the C5 limitations): a restart REOPENS conflicts, it never silently resolves them.
 */
export class KnowledgeModel {
  private readonly byId = new Map<string, Assertion>();
  private readonly batchRecords = new Map<string, BatchRecord>();
  private readonly reviewDecisions = new Map<string, ReviewDecision>();
  readonly policy: ResolutionPolicy;
  /** Assertion ceiling. May be lowered (tests, small deployments); never raised above `MAX_ASSERTIONS`. */
  readonly maxAssertions: number;

  constructor(options: { readonly policy?: ResolutionPolicy; readonly maxAssertions?: number } = {}) {
    this.policy = options.policy ?? NO_AUTOMATIC_RESOLUTION;
    this.maxAssertions = Math.max(1, Math.min(options.maxAssertions ?? MAX_ASSERTIONS, MAX_ASSERTIONS));
  }

  get size(): number {
    return this.byId.size;
  }

  assertions(): readonly Assertion[] {
    return [...this.byId.values()];
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Counts how many of these are new. The caller has already checked the ceiling (`wouldExceed`). */
  add(list: readonly Assertion[], batches: readonly BatchRecord[]): { readonly added: number; readonly unchanged: number } {
    let added = 0;
    for (const a of list) {
      if (this.byId.has(a.id)) continue;
      this.byId.set(a.id, a);
      added += 1;
    }
    for (const b of batches) this.batchRecords.set(b.operationId, b);
    while (this.batchRecords.size > MAX_BATCHES) {
      const oldest = this.batchRecords.keys().next();
      if (oldest.done === true) break;
      this.batchRecords.delete(oldest.value);
    }
    return { added, unchanged: list.length - added };
  }

  wouldExceed(list: readonly Assertion[]): boolean {
    let fresh = 0;
    for (const a of list) if (!this.byId.has(a.id)) fresh += 1;
    return this.byId.size + fresh > this.maxAssertions;
  }

  batch(operationId: string): BatchRecord | undefined {
    return this.batchRecords.get(operationId);
  }

  /**
   * Hygiene only (the enforcement is the query-time ledger check): drops assertions whose evidence the ledger EXPLICITLY holds as
   * revoked / purged / quarantined. An id the ledger has not got, or any state while the ledger's gate is closed, is left alone, so an
   * outage can never wipe the model.
   */
  sweep(ledger: EvidenceLedger): number {
    let removed = 0;
    for (const [id, a] of this.byId) {
      const state = ledger.stateOf(a.support.evidenceId as Parameters<EvidenceLedger['stateOf']>[0]);
      if (state === 'revoked' || state === 'purged' || state === 'quarantined') {
        this.byId.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /** `EvidencePurgeTarget`: the lifecycle's purge asks every holder to delete its copies; the model deletes every assertion resting on these ids. */
  async purge(ids: readonly string[]): Promise<void> {
    const gone = new Set(ids);
    for (const [id, a] of this.byId) if (gone.has(a.support.evidenceId)) this.byId.delete(id);
  }

  decisions(): readonly ReviewDecision[] {
    return [...this.reviewDecisions.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  addDecision(d: ReviewDecision): boolean {
    if (this.reviewDecisions.size >= MAX_DECISIONS && !this.reviewDecisions.has(d.id)) return false;
    this.reviewDecisions.set(d.id, d);
    return true;
  }

  removeDecision(id: string): boolean {
    return this.reviewDecisions.delete(id);
  }

  /** Digest of what the model holds (ids only): equal digests mean equal state. Used by the idempotence tests. */
  stateDigest(): string {
    return stableDigest(['ei-knowledge-state-v1', ...[...this.byId.keys()].sort(), '|', ...[...this.reviewDecisions.keys()].sort()]);
  }
}
