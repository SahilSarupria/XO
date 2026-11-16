import type { JournalEntry } from './journal.js';

/**
 * UW-7 (ADR 0033) — one effect vocabulary. The owner-approved effect model (P1.1 O-3, ADR 0015) names six states; the run journal,
 * the `@xo/adapters` ledger and P1.1 procedures each record effects in their own terms. This module is the single table that maps
 * all three onto the six, and `effectsOf` applies it to a run's journal so a run report shows one state per external call.
 *
 * Two rules hold throughout and are tested (`test/effects.test.ts`):
 *  - nothing is reported as confirmed unless something positively confirmed it (an outcome, a destination lookup, a person);
 *  - a call that may have left the machine and has no recorded outcome is never "failed" or "cancelled": it is `dispatch_attempted`
 *    while the run can still settle it, and `outcome_unknown` (or `reconciliation_required`, once the runner has stopped on it) after.
 */

export const EFFECT_STATES = [
  'intent_recorded',
  'dispatch_attempted',
  'confirmed_success',
  'confirmed_failure_no_effect',
  'outcome_unknown',
  'reconciliation_required',
] as const;
export type EffectState = (typeof EFFECT_STATES)[number];

/** Settled: nothing further will change the state without a person. */
export const SETTLED_EFFECT_STATES: readonly EffectState[] = ['confirmed_success', 'confirmed_failure_no_effect'];
/** Blocking: the call may have taken effect and a person must establish what happened before the case can go on. */
export const BLOCKING_EFFECT_STATES: readonly EffectState[] = ['outcome_unknown', 'reconciliation_required'];

export interface EffectMappingRow {
  /** Where the fact is recorded. */
  readonly source: 'journal' | 'adapter' | 'procedure';
  /** The fact, as that source records it. */
  readonly fact: string;
  readonly state: EffectState;
  readonly meaning: string;
}

/**
 * The mapping table. `docs/EFFECTS.md` is generated from it, and the consistency tests check that every journal entry type the
 * runner writes about a call, every adapter result and every procedure effect code appears here exactly once.
 */
export const EFFECT_STATE_MAPPING: readonly EffectMappingRow[] = [
  // Workflow IR runtime journal (per step; the latest call of the step decides).
  {
    source: 'journal',
    fact: 'call_intent (no later outcome; the run can still resume)',
    state: 'dispatch_attempted',
    meaning:
      'Written durably immediately before the call. It cannot prove the call was not made, so it is never intent_recorded: the next attempt settles it first (same key, or a destination lookup).',
  },
  {
    source: 'journal',
    fact: 'call_intent (no later outcome; the run has ended)',
    state: 'outcome_unknown',
    meaning: 'The call may have taken effect and nothing will settle it automatically.',
  },
  {
    source: 'journal',
    fact: 'effect_unknown',
    state: 'outcome_unknown',
    meaning: 'The run was cancelled while the call was in flight (ADR 0024). Never reported as cancelled, repeated or undone.',
  },
  {
    source: 'journal',
    fact: 'effect_ambiguous',
    state: 'reconciliation_required',
    meaning:
      'An earlier attempt has no outcome and the destination cannot deduplicate or be checked; the runner stopped and escalated. A person must look.',
  },
  {
    source: 'journal',
    fact: 'effect_retry_same_key',
    state: 'dispatch_attempted',
    meaning: 'Re-sent under the same key to a destination that deduplicates on it.',
  },
  {
    source: 'journal',
    fact: 'effect_lookup (found: false)',
    state: 'dispatch_attempted',
    meaning: 'The destination confirmed the earlier attempt had no effect; written once more.',
  },
  {
    source: 'journal',
    fact: 'call_outcome (ok: true)',
    state: 'confirmed_success',
    meaning: 'The destination answered with a result (or a lookup found the effect and it was adopted, with no second write).',
  },
  {
    source: 'journal',
    fact: 'call_outcome (ok: false)',
    state: 'confirmed_failure_no_effect',
    meaning: 'A permanent refusal by the destination (for example DENIED, INVALID); recorded as final and never retried.',
  },
  {
    source: 'journal',
    fact: 'call_not_sent',
    state: 'confirmed_failure_no_effect',
    meaning: 'The failure provably happened before anything reached the destination.',
  },
  {
    source: 'journal',
    fact: 'effect_reconciled (decision: confirmed_success)',
    state: 'confirmed_success',
    meaning: 'A person checked the destination and recorded that the effect happened.',
  },
  {
    source: 'journal',
    fact: 'effect_reconciled (decision: confirmed_failure_no_effect)',
    state: 'confirmed_failure_no_effect',
    meaning: 'A person checked the destination and recorded that nothing happened. Nothing is re-sent automatically.',
  },
  {
    source: 'journal',
    fact: 'effect_reconciled (decision: unresolved)',
    state: 'reconciliation_required',
    meaning: 'A person looked and could not establish the outcome; it stays blocking.',
  },
  // @xo/adapters dispatch ledger.
  {
    source: 'adapter',
    fact: 'intent_recorded',
    state: 'intent_recorded',
    meaning: 'Reserved by the O-3 model; no component in this repository writes it (the ledger claims a key with dispatch_attempted).',
  },
  { source: 'adapter', fact: 'dispatch_attempted', state: 'dispatch_attempted', meaning: 'Claimed before the adapter is called.' },
  { source: 'adapter', fact: 'confirmed_success', state: 'confirmed_success', meaning: 'The adapter confirmed the effect.' },
  {
    source: 'adapter',
    fact: 'confirmed_failure_no_effect',
    state: 'confirmed_failure_no_effect',
    meaning: 'The adapter positively knows the external system made no change.',
  },
  {
    source: 'adapter',
    fact: 'outcome_unknown',
    state: 'outcome_unknown',
    meaning: 'Anything not positively confirmed, including a throw, a timeout or a malformed reply.',
  },
  {
    source: 'adapter',
    fact: 'reconciliation (decision: unresolved)',
    state: 'reconciliation_required',
    meaning: 'Someone looked and could not establish the outcome.',
  },
  // P1.1 procedures (step status + error code), which dispatch through @xo/adapters.
  {
    source: 'procedure',
    fact: 'step succeeded (external step)',
    state: 'confirmed_success',
    meaning: 'The adapter confirmed the effect.',
  },
  {
    source: 'procedure',
    fact: 'step failed, XO_EXTERNAL_EFFECT_CONFIRMED_FAILURE_NO_EFFECT',
    state: 'confirmed_failure_no_effect',
    meaning: 'The adapter confirmed nothing changed.',
  },
  {
    source: 'procedure',
    fact: 'step failed, XO_EXTERNAL_EFFECT_OUTCOME_UNKNOWN',
    state: 'outcome_unknown',
    meaning: 'Reconciliation is required before any further dispatch (no retry, no automatic recovery).',
  },
  {
    source: 'procedure',
    fact: 'step waiting_for_human (payload_approval)',
    state: 'intent_recorded',
    meaning: 'Nothing was claimed or dispatched; the step waits for a person to approve this exact input.',
  },
];

/** Journal entry types that describe an external call. Every one maps through the table above. */
export const EFFECT_JOURNAL_TYPES = [
  'call_intent',
  'call_outcome',
  'call_not_sent',
  'effect_ambiguous',
  'effect_retry_same_key',
  'effect_lookup',
  'effect_unknown',
  'effect_reconciled',
] as const;

export interface EffectView {
  readonly step: string;
  readonly connector: string;
  readonly operation: string;
  readonly state: EffectState;
  readonly key?: string;
  readonly requestHash?: string;
  readonly intentAt: string;
  readonly settledAt?: string;
  /** Number of `call_intent` entries for this step (more than one: an earlier attempt was settled and the call made again). */
  readonly attempts: number;
  readonly detail: string;
  /** For a person's reconciliation: who and why. */
  readonly reconciledBy?: string;
}

const TERMINAL = new Set(['completed', 'failed', 'escalated', 'cancelled', 'compensated']);

/**
 * The effect report of one run: one row per step that made (or may have made) an external call, in the order the calls began.
 * Dry-run and shadow calls are not effects and are not listed. Pure: reads the journal entries it is given and nothing else.
 */
export function effectsOf(entries: readonly JournalEntry[]): EffectView[] {
  let ended = false;
  const rows = new Map<string, { -readonly [K in keyof EffectView]: EffectView[K] } & { open: boolean; simulated: boolean }>();
  for (const e of entries) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = e.data as Record<string, any>;
    if (e.type === 'run_finished' || (e.type === 'run_state' && TERMINAL.has(String(d['state'])))) ended = true;
    const step = typeof d['step'] === 'string' ? d['step'] : undefined;
    if (step === undefined) continue;
    const row = rows.get(step);
    switch (e.type) {
      case 'call_intent':
        rows.set(step, {
          step,
          connector: String(d['connector']),
          operation: String(d['operation']),
          state: 'dispatch_attempted',
          ...(d['key'] !== undefined ? { key: String(d['key']) } : {}),
          ...(d['requestHash'] !== undefined ? { requestHash: String(d['requestHash']) } : {}),
          intentAt: e.ts,
          attempts: (row?.attempts ?? 0) + 1,
          detail: 'sent; no outcome recorded yet',
          open: true,
          simulated: false,
        });
        break;
      case 'call_outcome':
        if (row === undefined) {
          // A shadow or dry-run outcome has no intent: it is not an effect.
          break;
        }
        if (d['dryRun'] === true) {
          row.simulated = true;
          break;
        }
        row.open = false;
        row.settledAt = e.ts;
        row.state = d['ok'] === true ? 'confirmed_success' : 'confirmed_failure_no_effect';
        row.detail =
          d['ok'] === true
            ? d['adopted'] === true
              ? 'the destination already had the effect (found by a lookup); adopted, no second write'
              : 'confirmed by the destination'
            : `refused by the destination (${String(d['code'] ?? 'FAILED')}); final, not retried`;
        break;
      case 'call_not_sent':
        if (row === undefined) break;
        row.open = false;
        row.settledAt = e.ts;
        row.state = 'confirmed_failure_no_effect';
        row.detail = `failed before anything reached the destination (${String(d['code'] ?? 'FAILED')})`;
        break;
      case 'effect_retry_same_key':
        if (row !== undefined) row.detail = 're-sent under the same key to a destination that deduplicates on it';
        break;
      case 'effect_lookup':
        if (row !== undefined && d['found'] !== true) row.detail = 'the destination confirmed the earlier attempt had no effect';
        break;
      case 'effect_ambiguous':
        if (row === undefined) break;
        row.open = false;
        row.state = 'reconciliation_required';
        row.detail = String(d['reason'] ?? 'the outcome cannot be established automatically');
        break;
      case 'effect_unknown':
        if (row === undefined) break;
        row.open = false;
        row.state = 'outcome_unknown';
        row.detail = String(d['reason'] ?? 'sent with no recorded outcome');
        break;
      case 'effect_reconciled':
        if (row === undefined) break;
        row.open = false;
        row.reconciledBy = String(d['by']);
        if (d['decision'] === 'unresolved') {
          row.state = 'reconciliation_required';
          row.detail = `a person looked and could not establish the outcome: ${String(d['reason'] ?? '')}`.trim();
        } else {
          row.state = d['decision'] === 'confirmed_success' ? 'confirmed_success' : 'confirmed_failure_no_effect';
          row.settledAt = e.ts;
          row.detail = `recorded by a person after checking the destination: ${String(d['reason'] ?? '')}`.trim();
        }
        break;
      default:
        break;
    }
  }
  const out: EffectView[] = [];
  for (const r of rows.values()) {
    if (r.simulated && r.open) continue;
    const { open, simulated: _s, ...view } = r;
    // A call that may have left the machine and that nothing will settle any more is unknown, not pending.
    out.push(open && ended ? { ...view, state: 'outcome_unknown', detail: 'sent; the run ended before an outcome was recorded' } : view);
  }
  return out.sort((a, b) => (a.intentAt < b.intentAt ? -1 : a.intentAt > b.intentAt ? 1 : 0));
}

/** Markdown for `docs/EFFECTS.md` (generated, so the document and the code cannot disagree). */
export function effectMappingMarkdown(): string {
  const lines = ['| Source | Recorded fact | Effect state | Meaning |', '| --- | --- | --- | --- |'];
  for (const r of EFFECT_STATE_MAPPING) lines.push(`| ${r.source} | \`${r.fact}\` | \`${r.state}\` | ${r.meaning.replace(/\|/g, '\\|')} |`);
  return lines.join('\n');
}
