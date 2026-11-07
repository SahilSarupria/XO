import type { RunStoreLike } from './journal.js';

/**
 * A reconciliation report over the run journals: every external write whose effect is not accounted for, and every one that was settled by something
 * other than a plain recorded outcome. The journal already is a transactional outbox (`call_intent` is durable BEFORE the call, the outcome AFTER), so
 * this reads it; it never calls any external system and never changes anything.
 *
 *  - `pending`   : an intent with no outcome and no decision yet (the process died mid-call, or the run is still retrying). Resuming the run settles it.
 *  - `ambiguous` : the runner stopped and escalated because the destination cannot say whether the effect happened. A PERSON must look. This is the
 *                  residual duplicate-or-missing risk of destinations without idempotency keys or lookup, made visible instead of hidden.
 *  - `resolved`  : settled without a plain outcome: adopted from a destination lookup, or re-sent under the same key to a destination that dedupes.
 */
export type EffectStatus = 'pending' | 'ambiguous' | 'resolved';

export interface EffectRecord {
  readonly runId: string;
  readonly step: string;
  readonly connector: string;
  readonly operation: string;
  readonly status: EffectStatus;
  readonly intentAt: string;
  readonly key?: string;
  readonly requestHash?: string;
  readonly mode?: string;
  /** How it was settled, or why it is not. */
  readonly detail: string;
}

export interface ReconcileReport {
  readonly runs: number;
  readonly effects: readonly EffectRecord[];
  /** `pending` + `ambiguous`: something here needs a decision or a resume. */
  readonly needsAttention: boolean;
}

export async function reconcile(store: Pick<RunStoreLike, 'list' | 'read'>): Promise<ReconcileReport> {
  const ids = await store.list();
  const effects: EffectRecord[] = [];
  for (const runId of ids) {
    const open = new Map<string, EffectRecord>();
    const done: EffectRecord[] = [];
    for (const e of await store.read(runId)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = e.data as Record<string, any>;
      const step = String(d['step'] ?? '');
      switch (e.type) {
        case 'call_intent':
          open.set(step, {
            runId,
            step,
            connector: String(d['connector']),
            operation: String(d['operation']),
            status: 'pending',
            intentAt: e.ts,
            ...(d['key'] !== undefined ? { key: String(d['key']) } : {}),
            ...(d['requestHash'] !== undefined ? { requestHash: String(d['requestHash']) } : {}),
            detail: 'the call was journalled as about to happen and has no recorded outcome yet',
          });
          break;
        case 'call_not_sent':
          open.delete(step); // proven not to have left the machine
          break;
        case 'effect_ambiguous': {
          const o = open.get(step);
          if (o !== undefined) open.set(step, { ...o, status: 'ambiguous', mode: String(d['mode']), detail: String(d['reason']) });
          break;
        }
        case 'effect_retry_same_key': {
          const o = open.get(step);
          if (o !== undefined)
            open.set(step, {
              ...o,
              mode: String(d['mode']),
              detail: 'earlier attempt had no outcome; re-sent under the same key to a destination that deduplicates',
            });
          break;
        }
        case 'effect_lookup': {
          const o = open.get(step);
          if (o !== undefined)
            open.set(step, {
              ...o,
              mode: String(d['mode']),
              detail:
                d['found'] === true
                  ? 'destination lookup found the effect'
                  : 'destination lookup confirmed the effect was absent; written once',
            });
          break;
        }
        case 'call_outcome': {
          const o = open.get(step);
          open.delete(step);
          if (o !== undefined && (d['adopted'] === true || o.mode !== undefined))
            done.push({
              ...o,
              status: 'resolved',
              detail: d['adopted'] === true ? 'adopted the effect found by a destination lookup; no second write' : o.detail,
            });
          break;
        }
        default:
          break;
      }
    }
    effects.push(...done, ...open.values());
  }
  return { runs: ids.length, effects, needsAttention: effects.some((x) => x.status !== 'resolved') };
}
