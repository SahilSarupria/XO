import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CapabilityDeclaration, CapabilityExecutionDeclaration, CapabilityExecutionMode } from '../src/xo-capability.js';

/**
 * Human-in-the-Loop Execution Class Lowering milestone: `CapabilityExecutionMode`
 * gained a fourth member, `'human_in_the_loop'`, alongside the existing
 * `'deterministic_rule'` | `'model'` | `'hybrid'`. These are compile-time
 * (type-level) tests -- the assertions below exist to fail a `tsc` build
 * if the union is ever narrowed back, not to test runtime logic (there is
 * none here; this module is pure types). Kept as `node:test` cases rather
 * than a bare `.d.ts`-only check so `npm test` surfaces a regression the
 * same way every other package's tests do.
 */

test('CapabilityExecutionMode accepts human_in_the_loop', () => {
  const mode: CapabilityExecutionMode = 'human_in_the_loop';
  assert.equal(mode, 'human_in_the_loop');
});

test('CapabilityExecutionMode still accepts every pre-existing member unchanged', () => {
  const modes: readonly CapabilityExecutionMode[] = ['deterministic_rule', 'model', 'hybrid', 'human_in_the_loop'];
  assert.deepEqual(modes, ['deterministic_rule', 'model', 'hybrid', 'human_in_the_loop']);
});

test('a CapabilityExecutionDeclaration with mode human_in_the_loop type-checks with the same optional fields deterministic_rule uses', () => {
  const execution: CapabilityExecutionDeclaration = {
    mode: 'human_in_the_loop',
    bindingId: 'binding_capability:x_action-escalation-resolver',
    contractId: 'capability:x',
  };
  assert.equal(execution.mode, 'human_in_the_loop');
  assert.equal('inputSchema' in execution, false);
  assert.equal('hybridSteps' in execution, false);
});

test('a full CapabilityDeclaration with execution.mode human_in_the_loop type-checks', () => {
  const declaration: CapabilityDeclaration = {
    id: 'capability:reconcile-invoice',
    name: 'Reconcile the invoice balance',
    description: 'Reconciles the invoice balance against payments received.',
    providerCompatibility: [],
    requiredComponents: ['knowledge_graph'],
    estimatedCost: { currency: 'USD', amount: 0 },
    estimatedLatencyMs: 0,
    confidence: { score: 0.65, basis: 'self_reported' },
    execution: { mode: 'human_in_the_loop', bindingId: 'binding_capability:reconcile-invoice_action-escalation-resolver', contractId: 'capability:reconcile-invoice' },
  };
  assert.equal(declaration.execution!.mode, 'human_in_the_loop');
});
