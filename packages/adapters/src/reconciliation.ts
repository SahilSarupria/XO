import type { DispatchEvidence, DispatchLedger, ReconciliationDecision } from './contract.js';

/**
 * Reconciliation: the ONLY way an unsettled dispatch (`outcome_unknown`, or `dispatch_attempted` with no terminal evidence) is ever
 * settled. It records a decision about an external effect that XO could not observe; it never calls the adapter, never redispatches,
 * and never deletes or rewrites evidence — the decision is a new, immutable entry carrying the actor, reason and evidence examined.
 *
 * WHAT A DECISION MEANS (delegated design decision of this milestone, NOT a verified requirement of the unavailable O-3 / Review §5.3 /
 * N-3 / E-1–E-9 texts):
 *  - `confirmed_success`            — the actor examined authoritative external evidence that the effect happened. Settles the key.
 *  - `confirmed_failure_no_effect`  — the actor examined authoritative external evidence that the effect did NOT happen. Settles the key.
 *  - `unresolved`                   — the actor looked and could not establish the outcome. Settles nothing; the key stays blocked.
 *  Absence of evidence is not a decision: `confirmed_failure_no_effect` requires the actor to state the evidence that shows no effect.
 *
 * REDISPATCH. Reconciliation never reopens a dispatch key: one key is one dispatch, ever. Even `confirmed_failure_no_effect` only
 * UNBLOCKS THE CAPABILITY; any further attempt must be a NEW dispatch identity (a new procedure execution), which passes the full
 * approval / authorization / input checks again. A settled key can never be re-resolved to a different decision (no reopening).
 *
 * AUTHORIZATION is the caller's job (the API route: authenticated human principal, workspace ownership). This function trusts that the
 * `actor` was minted from an authenticated principal and does no authorization of its own.
 */

export interface ReconcileRequest {
  readonly dispatchKey: string;
  readonly actor: { readonly kind: 'human' | 'service' | 'system'; readonly id: string };
  readonly decision: ReconciliationDecision;
  readonly reason: string;
  readonly evidenceExamined: string;
}

export type ReconcileOutcome =
  | { readonly kind: 'recorded'; readonly state: DispatchEvidence['state']; readonly seq: number }
  /** Idempotent: the key was already settled with exactly this decision (by an earlier reconciliation, a concurrent one, or the adapter). Nothing was written. */
  | { readonly kind: 'already_resolved'; readonly state: DispatchEvidence['state'] }
  /** The key is settled differently from the requested decision (or a settled key cannot take `unresolved`). Nothing was written. */
  | { readonly kind: 'conflict'; readonly state: DispatchEvidence['state']; readonly reason: string }
  | { readonly kind: 'not_found'; readonly reason: string }
  | { readonly kind: 'invalid_request'; readonly reason: string }
  | { readonly kind: 'ledger_unavailable'; readonly reason: string };

export const MAX_RECONCILE_REASON = 1_000;
export const MAX_RECONCILE_EVIDENCE = 4_000;
const DECISIONS: ReadonlySet<string> = new Set(['confirmed_success', 'confirmed_failure_no_effect', 'unresolved']);
const isSettled = (state: string): boolean => state === 'confirmed_success' || state === 'confirmed_failure_no_effect';

export async function reconcileDispatch(ledger: DispatchLedger, request: ReconcileRequest): Promise<ReconcileOutcome> {
  if (typeof request.dispatchKey !== 'string' || request.dispatchKey.length === 0) {
    return { kind: 'invalid_request', reason: 'dispatchKey is required' };
  }
  if (typeof request.decision !== 'string' || !DECISIONS.has(request.decision)) {
    return { kind: 'invalid_request', reason: 'decision must be confirmed_success, confirmed_failure_no_effect or unresolved' };
  }
  if (typeof request.actor?.id !== 'string' || request.actor.id.length === 0) {
    return { kind: 'invalid_request', reason: 'an authenticated actor is required' };
  }
  const reason = typeof request.reason === 'string' ? request.reason.trim() : '';
  if (reason.length === 0 || reason.length > MAX_RECONCILE_REASON) {
    return { kind: 'invalid_request', reason: `reason is required (1-${MAX_RECONCILE_REASON} characters)` };
  }
  const evidence = typeof request.evidenceExamined === 'string' ? request.evidenceExamined.trim() : '';
  if (evidence.length > MAX_RECONCILE_EVIDENCE) {
    return { kind: 'invalid_request', reason: `evidenceExamined must be at most ${MAX_RECONCILE_EVIDENCE} characters` };
  }
  if (request.decision !== 'unresolved' && evidence.length === 0) {
    return { kind: 'invalid_request', reason: 'a resolving decision must state the authoritative evidence examined' };
  }
  if (ledger.appendAfter === undefined) {
    return {
      kind: 'ledger_unavailable',
      reason: 'this evidence ledger cannot perform a compare-and-append, so it cannot reconcile safely',
    };
  }

  // Bounded retry on a lost compare-and-append (a concurrent reconciliation or terminal write). Each pass re-reads and re-decides, so a
  // concurrent identical decision becomes `already_resolved` and a concurrent different one becomes `conflict` — never a second write.
  for (let attempt = 0; attempt < 6; attempt++) {
    let entries: readonly DispatchEvidence[];
    try {
      entries = await ledger.read(request.dispatchKey);
    } catch (cause) {
      return {
        kind: 'ledger_unavailable',
        reason: `evidence ledger unreadable: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
    const last = entries[entries.length - 1];
    if (last === undefined) {
      return {
        kind: 'not_found',
        reason: 'no dispatch evidence exists for this key; absence of evidence is not proof that nothing happened, so nothing was recorded',
      };
    }
    if (isSettled(last.state)) {
      if (request.decision === last.state) return { kind: 'already_resolved', state: last.state };
      return {
        kind: 'conflict',
        state: last.state,
        reason: `the dispatch is already settled as ${last.state}; a settled dispatch cannot be re-resolved as ${request.decision}`,
      };
    }
    const resulting = request.decision === 'unresolved' ? last.state : request.decision;
    try {
      const res = await ledger.appendAfter(request.dispatchKey, last.seq, {
        dispatchKey: last.dispatchKey,
        capabilityId: last.capabilityId,
        adapterId: last.adapterId,
        state: resulting,
        detail: `reconciliation: ${request.decision}`,
        ...(entries[0]?.inputFingerprint !== undefined ? { inputFingerprint: entries[0].inputFingerprint } : {}),
        reconciliation: {
          actorKind: request.actor.kind,
          actorId: request.actor.id,
          decision: request.decision,
          reason,
          evidenceExamined: evidence,
        },
      });
      if (res.appended) return { kind: 'recorded', state: resulting, seq: last.seq + 1 };
    } catch (cause) {
      return {
        kind: 'ledger_unavailable',
        reason: `reconciliation could not be recorded: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
  }
  return {
    kind: 'ledger_unavailable',
    reason: 'reconciliation could not be recorded under persistent write contention; nothing was changed',
  };
}
