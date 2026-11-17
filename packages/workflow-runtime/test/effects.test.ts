/**
 * UW-7 (ADR 0033, UAC-9, UAC-22) — the effect-state mapping table is complete and consistent with what the runner writes, and
 * `effectsOf` applies it: one state per external call, nothing confirmed without confirmation, nothing open reported as settled.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  BLOCKING_EFFECT_STATES,
  EFFECT_JOURNAL_TYPES,
  EFFECT_STATES,
  EFFECT_STATE_MAPPING,
  SETTLED_EFFECT_STATES,
  effectMappingMarkdown,
  effectsOf,
  type JournalEntry,
} from '../src/index.js';

let seq = 0;
const at = (n: number) => new Date(Date.UTC(2026, 10, 16, 0, 0, n)).toISOString();
const e = (type: string, data: Record<string, unknown>, n = ++seq): JournalEntry =>
  ({ seq: n, ts: at(n), type, data, prev: '', hash: '' }) as JournalEntry;
const intent = (step = 's', extra: Record<string, unknown> = {}) =>
  e('call_intent', { step, connector: 'mail', operation: 'send', requestHash: 'h', key: 'k', ...extra });

describe('the mapping table', () => {
  it('every journal entry type the runner writes about a call is in the table, and only those', () => {
    const source = readFileSync(new URL('../src/runner.ts', import.meta.url), 'utf8');
    const written = new Set([...source.matchAll(/'((?:call|effect)_[a-z_]+)'/g)].map((m) => m[1]));
    assert.deepEqual([...written].sort(), [...EFFECT_JOURNAL_TYPES].sort());
    for (const t of EFFECT_JOURNAL_TYPES)
      assert.ok(
        EFFECT_STATE_MAPPING.some((r) => r.source === 'journal' && r.fact.split(' ')[0] === t),
        `${t} is mapped`,
      );
  });

  it('maps only onto the six owner-approved states, and every state is reachable', () => {
    for (const r of EFFECT_STATE_MAPPING) assert.ok((EFFECT_STATES as readonly string[]).includes(r.state), r.fact);
    for (const s of EFFECT_STATES)
      assert.ok(
        EFFECT_STATE_MAPPING.some((r) => r.state === s),
        `${s} is used`,
      );
    assert.equal(new Set(EFFECT_STATE_MAPPING.map((r) => `${r.source}|${r.fact}`)).size, EFFECT_STATE_MAPPING.length, 'no duplicate rows');
    assert.deepEqual(
      [...SETTLED_EFFECT_STATES, ...BLOCKING_EFFECT_STATES].filter((s) => !(EFFECT_STATES as readonly string[]).includes(s)),
      [],
    );
  });

  it('docs/EFFECTS.md carries the table exactly as the code defines it', () => {
    const doc = readFileSync(new URL('../../../docs/EFFECTS.md', import.meta.url), 'utf8');
    assert.ok(doc.includes(effectMappingMarkdown()), 'regenerate it: npx tsx packages/workflow-runtime/scripts/render-effects-doc.ts');
  });
});

describe('effectsOf', () => {
  it('an intent alone is dispatch_attempted while the run is open, and outcome_unknown once it has ended', () => {
    const open = [e('run_started', {}), intent()];
    assert.deepEqual(
      effectsOf(open).map((x) => x.state),
      ['dispatch_attempted'],
    );
    assert.deepEqual(
      effectsOf([...open, e('run_state', { state: 'escalated' })]).map((x) => x.state),
      ['outcome_unknown'],
    );
  });

  it('only an outcome, a lookup or a person confirms', () => {
    assert.deepEqual(
      effectsOf([intent(), e('call_outcome', { step: 's', ok: true, data: {} })]).map((x) => x.state),
      ['confirmed_success'],
    );
    assert.deepEqual(
      effectsOf([intent(), e('call_outcome', { step: 's', ok: false, code: 'INVALID' })]).map((x) => x.state),
      ['confirmed_failure_no_effect'],
    );
    assert.deepEqual(
      effectsOf([intent(), e('call_not_sent', { step: 's', code: 'CANCELLED' })]).map((x) => x.state),
      ['confirmed_failure_no_effect'],
    );
    const adopted = effectsOf([
      intent(),
      e('effect_lookup', { step: 's', found: true }),
      e('call_outcome', { step: 's', ok: true, adopted: true }),
    ]);
    assert.equal(adopted[0]?.state, 'confirmed_success');
    assert.match(adopted[0]!.detail, /adopted, no second write/);
  });

  it('an ambiguous earlier attempt needs reconciliation; a cancel in flight is unknown; a person settles either', () => {
    const amb = [intent(), e('effect_ambiguous', { step: 's', reason: 'no dedupe' })];
    assert.deepEqual(
      effectsOf(amb).map((x) => x.state),
      ['reconciliation_required'],
    );
    const unk = [intent(), e('effect_unknown', { step: 's', reason: 'cancelled in flight' })];
    assert.deepEqual(
      effectsOf(unk).map((x) => x.state),
      ['outcome_unknown'],
    );
    const looked = [...unk, e('effect_reconciled', { step: 's', decision: 'unresolved', by: 'p', reason: 'cannot tell' })];
    assert.deepEqual(
      effectsOf(looked).map((x) => x.state),
      ['reconciliation_required'],
    );
    const settled = [...looked, e('effect_reconciled', { step: 's', decision: 'confirmed_success', by: 'p', reason: 'found it' })];
    assert.deepEqual(
      effectsOf(settled).map((x) => [x.state, x.reconciledBy]),
      [['confirmed_success', 'p']],
    );
  });

  it('a retry counts attempts; shadow and dry-run calls are not effects', () => {
    const retried = effectsOf([
      intent(),
      intent('s'),
      e('effect_retry_same_key', { step: 's' }),
      e('call_outcome', { step: 's', ok: true }),
    ]);
    assert.deepEqual(
      retried.map((x) => [x.state, x.attempts]),
      [['confirmed_success', 2]],
    );
    assert.deepEqual(effectsOf([e('shadow_action', { step: 'x' }), e('call_outcome', { step: 'x', ok: true, dryRun: true })]), []);
    assert.deepEqual(effectsOf([intent('d'), e('call_outcome', { step: 'd', ok: true, dryRun: true })]), []);
  });
});
