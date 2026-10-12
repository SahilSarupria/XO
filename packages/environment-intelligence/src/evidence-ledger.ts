import type { Evidence } from './evidence.js';
import type { EvidenceId, SourceId } from './ids.js';

/**
 * Lifecycle of evidence that EI released to a caller (M2.2).
 *
 *  - `released`:    produced by an operation whose attempt AND completion were accepted by the audit recorder.
 *  - `quarantined`: acquired, but the completion audit was not accepted, so it was withheld (never released).
 *  - `revoked`:     authorization for the source was withdrawn; copies already held must not be used.
 *  - `purged`:      revoked and removed by its holders; terminal until a NEW authorized, audited release.
 *
 * Only `released` is eligible for model input or evidence selection. An id the ledger has never seen is NOT
 * eligible: eligibility is granted by an audited release, never assumed.
 *
 * The ledger stores states keyed by the content-derived evidence id and the owning source - never payloads, so it
 * cannot leak evidence content. Evidence ids are stable across scans, so a fresh, authorized, audited release of
 * the same content after a revoke/purge legitimately makes that id eligible again (it is a new authorization);
 * the severity order below only prevents a quarantine from masking a revoke or purge.
 */
export type EvidenceState = 'released' | 'quarantined' | 'revoked' | 'purged';

export interface EvidenceEligibility {
  isEligible(id: EvidenceId): boolean;
}

interface Entry {
  readonly state: EvidenceState;
  readonly sourceId: SourceId;
  readonly operationId: string;
}

const SEVERITY: Readonly<Record<EvidenceState, number>> = { released: 0, quarantined: 1, revoked: 2, purged: 3 };

export class EvidenceLedger implements EvidenceEligibility {
  private readonly entries = new Map<EvidenceId, Entry>();

  /** Marks evidence as released by an operation whose completion audit was accepted. Supersedes any earlier state (a new authorization). */
  release(operationId: string, evidence: readonly Evidence[]): void {
    for (const e of evidence) this.entries.set(e.id, { state: 'released', sourceId: e.sourceId, operationId });
  }

  /** Withholds evidence whose completion audit was not accepted. Never downgrades a revoked or purged id. */
  quarantine(operationId: string, evidence: readonly Evidence[]): void {
    for (const e of evidence) {
      const current = this.entries.get(e.id);
      if (current !== undefined && SEVERITY[current.state] >= SEVERITY.quarantined) continue;
      this.entries.set(e.id, { state: 'quarantined', sourceId: e.sourceId, operationId });
    }
  }

  /** Revokes every non-terminal item of a source. Returns the ids affected. */
  revokeSource(sourceId: SourceId, operationId: string): readonly EvidenceId[] {
    return this.transition(sourceId, operationId, 'revoked');
  }

  /** Purges every item of a source that is not already purged. Returns the ids affected. */
  purgeSource(sourceId: SourceId, operationId: string): readonly EvidenceId[] {
    return this.transition(sourceId, operationId, 'purged');
  }

  private transition(sourceId: SourceId, operationId: string, to: 'revoked' | 'purged'): readonly EvidenceId[] {
    const affected: EvidenceId[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.sourceId !== sourceId || SEVERITY[entry.state] >= SEVERITY[to]) continue;
      this.entries.set(id, { state: to, sourceId, operationId });
      affected.push(id);
    }
    return affected.sort();
  }

  stateOf(id: EvidenceId): EvidenceState | undefined {
    return this.entries.get(id)?.state;
  }

  /** Evidence ids of a source in any of the given states, sorted. */
  idsOf(sourceId: SourceId, states: readonly EvidenceState[]): readonly EvidenceId[] {
    return [...this.entries.entries()]
      .filter(([, e]) => e.sourceId === sourceId && states.includes(e.state))
      .map(([id]) => id)
      .sort();
  }

  isEligible(id: EvidenceId): boolean {
    return this.entries.get(id)?.state === 'released';
  }

  counts(): Readonly<Record<EvidenceState, number>> {
    const counts: Record<EvidenceState, number> = { released: 0, quarantined: 0, revoked: 0, purged: 0 };
    for (const e of this.entries.values()) counts[e.state] += 1;
    return counts;
  }
}

/** Evidence selection: keeps only items the ledger currently deems eligible. Revoked, purged, quarantined and never-released evidence is dropped. */
export function selectEligibleEvidence(eligibility: EvidenceEligibility, evidence: readonly Evidence[]): readonly Evidence[] {
  return evidence.filter((e) => eligibility.isEligible(e.id));
}
