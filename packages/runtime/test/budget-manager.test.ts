import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetManager } from '../src/budget/budget-manager.js';
import type { RetrievedSlice } from '../src/retrieval/retrieved-slice.js';

function slice(kind: RetrievedSlice['componentKind'], tokens: number): RetrievedSlice {
  return { packageName: 'xo_a', packageVersion: '1.0.0', componentKind: kind, content: 'x'.repeat(tokens * 4), estimatedTokens: tokens };
}

test('fit() keeps everything when it all fits within budget', () => {
  const slices = [slice('knowledge_graph', 100), slice('safety_rules', 50)];
  const result = new BudgetManager().fit(slices, 1000);
  assert.equal(result.kept.length, 2);
  assert.deepEqual(result.dropped, []);
  assert.equal(result.degraded, false);
  assert.equal(result.totalEstimatedTokens, 150);
});

test('fit() drops lowest-priority slices first when over budget', () => {
  const slices = [slice('prompt_strategies', 500), slice('safety_rules', 100), slice('knowledge_graph', 500)];
  const result = new BudgetManager().fit(slices, 700);
  assert.equal(result.degraded, true);
  assert.ok(result.kept.some((s) => s.componentKind === 'safety_rules'));
  assert.ok(result.kept.some((s) => s.componentKind === 'knowledge_graph'));
  assert.ok(result.dropped.some((s) => s.componentKind === 'prompt_strategies'));
});

test('fit() always keeps safety_rules even when the budget is smaller than its own size', () => {
  const slices = [slice('safety_rules', 500)];
  const result = new BudgetManager().fit(slices, 10);
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0]?.componentKind, 'safety_rules');
  // Kept, but budget accounting still reflects the overage (not silently pretended-within-budget).
  assert.equal(result.totalEstimatedTokens, 500);
});

test('fit() preserves original relative order of kept slices, not priority order', () => {
  const slices = [slice('prompt_strategies', 10), slice('safety_rules', 10), slice('knowledge_graph', 10)];
  const result = new BudgetManager().fit(slices, 1000);
  assert.deepEqual(
    result.kept.map((s) => s.componentKind),
    ['prompt_strategies', 'safety_rules', 'knowledge_graph'],
  );
});

test('fit() on an empty slice list returns an empty, non-degraded result', () => {
  const result = new BudgetManager().fit([], 1000);
  assert.deepEqual(result.kept, []);
  assert.deepEqual(result.dropped, []);
  assert.equal(result.degraded, false);
});
