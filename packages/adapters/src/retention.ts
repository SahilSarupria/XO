import type { DispatchEvidence, DispatchLedger } from './contract.js';

/**
 * Operator-controlled, NON-DESTRUCTIVE retention assessment for dispatch evidence.
 *
 * This module only REPORTS which dispatch keys could be considered for removal. Nothing in this package deletes ledger entries: entries are
 * immutable and the ledger interface has no delete. Whether and when to remove anything is the operator's decision, made with whatever
 * tooling they own, using this report as a conservative filter. There is no default period: with no `retentionMs` nothing is a candidate.
 *
 * A key is a candidate only if ALL hold:
 *  - the operator supplied `retentionMs` (no built-in value exists);
 *  - the key is SETTLED (`confirmed_success` / `confirmed_failure_no_effect`) — never `dispatch_attempted`, `outcome_unknown`, or an
 *    `unresolved` reconciliation (which leaves the key unknown), i.e. never an unresolved outcome or a pending reconciliation;
 *  - its last entry is at least `retentionMs` old, with a parseable timestamp (unknown age => retained);
 *  - no other key `follows` it (a later attempt still references it);
 *  - it is not the most recent settled `confirmed_failure_no_effect` of its capability (the fresh-approval rule reads that entry).
 * The host must additionally confirm that no active or resumable procedure execution refers to the key (the ledger cannot know), and that
 * the audit/recovery process does not require it; this report never claims either.
 */
export interface RetentionPolicy {
  /** Operator-chosen minimum age (ms since the key's last entry) before a settled key becomes a candidate. REQUIRED for any candidate. */
  readonly retentionMs?: number;
}

export interface RetentionItem {
  readonly dispatchKey: string;
  readonly capabilityId: string;
  readonly candidate: boolean;
  /** Why the key is retained (empty for a candidate). */
  readonly retainedBecause: readonly string[];
}

export async function assessRetention(
  ledger: DispatchLedger,
  capabilityIds: readonly string[],
  policy: RetentionPolicy,
  now: Date = new Date(),
): Promise<readonly RetentionItem[]> {
  const items: RetentionItem[] = [];
  const valid = policy.retentionMs !== undefined && Number.isFinite(policy.retentionMs) && policy.retentionMs >= 0;
  for (const capabilityId of capabilityIds) {
    const last = new Map<string, DispatchEvidence>();
    const referenced = new Set<string>();
    for (const e of await ledger.readByCapability(capabilityId)) {
      last.set(e.dispatchKey, e);
      if (e.follows !== undefined) referenced.add(e.follows.dispatchKey);
    }
    let newestNoEffect: DispatchEvidence | undefined;
    for (const e of last.values()) {
      if (
        e.state === 'confirmed_failure_no_effect' &&
        (newestNoEffect === undefined || (e.recordedAt ?? '') > (newestNoEffect.recordedAt ?? ''))
      ) {
        newestNoEffect = e;
      }
    }
    for (const [dispatchKey, e] of last) {
      const why: string[] = [];
      if (!valid) why.push('no operator retention period configured');
      if (e.state !== 'confirmed_success' && e.state !== 'confirmed_failure_no_effect') {
        why.push(`unresolved or pending reconciliation (${e.state})`);
      }
      const at = Date.parse(e.recordedAt ?? '');
      if (Number.isNaN(at)) why.push('age unknown');
      else if (valid && now.getTime() - at < (policy.retentionMs as number)) why.push('within the retention period');
      if (referenced.has(dispatchKey)) why.push('referenced by a later attempt');
      if (newestNoEffect?.dispatchKey === dispatchKey)
        why.push('most recent confirmed no-effect failure for its capability (fresh-approval rule)');
      items.push({ dispatchKey, capabilityId, candidate: why.length === 0, retainedBecause: why });
    }
  }
  return items;
}
