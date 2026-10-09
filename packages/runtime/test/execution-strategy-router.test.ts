import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CapabilityExecutionMode } from '@xo/types';
import { ExecutionStrategyRouter } from '../src/execution/execution-strategy-router.js';

/**
 * R4/R5/HITL: proves `ExecutionStrategyRouter` resolves all four
 * currently-registered strategies (`'deterministic_rule'`, `'model'`,
 * `'hybrid'` (R5), and `'human_in_the_loop'` (Human-in-the-Loop
 * Execution Class Lowering milestone)), preserves the `undefined` →
 * `'model'` default, and fails closed (never defaulting to `'model'`)
 * for a mode string outside the closed `CapabilityExecutionMode` union.
 * That last case is simulated with a type cast, per the R4 brief — a
 * *genuinely* unrecognized value (`'future_strategy'`), now that
 * `'hybrid'`/`'human_in_the_loop'` are real, registered members.
 */

test("ExecutionStrategyRouter: 'deterministic_rule' resolves to the deterministic strategy", () => {
  const router = new ExecutionStrategyRouter();
  const result = router.resolve('deterministic_rule');
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, 'deterministic_rule');
});

test("ExecutionStrategyRouter: 'model' resolves to the model strategy", () => {
  const router = new ExecutionStrategyRouter();
  const result = router.resolve('model');
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, 'model');
});

test("ExecutionStrategyRouter: 'hybrid' resolves to the hybrid strategy (R5)", () => {
  const router = new ExecutionStrategyRouter();
  const result = router.resolve('hybrid');
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, 'hybrid');
});

test("ExecutionStrategyRouter: 'human_in_the_loop' resolves to the human_in_the_loop strategy (Human-in-the-Loop Execution Class Lowering milestone)", () => {
  const router = new ExecutionStrategyRouter();
  const result = router.resolve('human_in_the_loop');
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, 'human_in_the_loop');
});

test('ExecutionStrategyRouter: undefined (execution absent) resolves to the model strategy', () => {
  const router = new ExecutionStrategyRouter();
  const result = router.resolve(undefined);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, 'model');
});

test('ExecutionStrategyRouter: an unknown runtime mode string fails closed with RUNTIME_UNSUPPORTED_EXECUTION_MODE, never defaulting to model', () => {
  const router = new ExecutionStrategyRouter();
  // Simulates a still-wider future `CapabilityExecutionMode` value
  // reaching this runtime before it's taught how to run it — 'hybrid'
  // itself is now a real, registered member as of R5, so this uses a
  // name no phase has claimed. Cast past the type system deliberately —
  // the union itself stays 'deterministic_rule' | 'model' | 'hybrid';
  // this proves the runtime behavior for a value that isn't a member of
  // it.
  const futureMode = 'future_strategy' as unknown as CapabilityExecutionMode;
  const result = router.resolve(futureMode);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'XO_RUNTIME_UNSUPPORTED_EXECUTION_MODE');
});
