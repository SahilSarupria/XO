import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CapabilityInputSchema } from '@xo/types';
import { validateCapabilityInput } from '../src/input-schema.js';

/**
 * `validateCapabilityInput` is R2's enforcement boundary
 * (`@xo/runtime`'s `ExecutionPipeline.runDeterministicRuleExecution`
 * calls it before any deterministic binding runs), but had zero direct
 * test coverage prior to this file — flagged by the R1/R2/R3 freeze
 * audit. These tests cover the function in isolation; the fact that the
 * runtime actually calls it is covered separately by
 * `@xo/runtime`'s `execution-pipeline-r1-r3-closure.test.ts`.
 */

const schema: CapabilityInputSchema = {
  type: 'object',
  properties: {
    claimed_loss_amount: { type: 'number' },
    policy_holder_name: { type: 'string' },
    is_repeat_claim: { type: 'boolean' },
  },
  required: ['claimed_loss_amount'],
};

test('accepts an input satisfying every required and typed property', () => {
  const result = validateCapabilityInput(schema, { claimed_loss_amount: 15000, policy_holder_name: 'Jane Doe', is_repeat_claim: false });
  assert.equal(result.valid, true);
});

test('accepts an input that omits an optional property entirely', () => {
  const result = validateCapabilityInput(schema, { claimed_loss_amount: 15000 });
  assert.equal(result.valid, true);
});

test('rejects a missing required property', () => {
  const result = validateCapabilityInput(schema, { policy_holder_name: 'Jane Doe' });
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]?.property, 'claimed_loss_amount');
  assert.match(result.issues[0]?.message ?? '', /missing required property/);
});

test('rejects a wrong-typed property', () => {
  const result = validateCapabilityInput(schema, { claimed_loss_amount: 'fifteen thousand' });
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.issues[0]?.property, 'claimed_loss_amount');
  assert.match(result.issues[0]?.message ?? '', /expected number, got string/);
});

test('rejects a required property that is present but null', () => {
  const result = validateCapabilityInput(schema, { claimed_loss_amount: null });
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.issues[0]?.property, 'claimed_loss_amount');
});

test('rejects an unknown property not declared in the schema', () => {
  const result = validateCapabilityInput(schema, { claimed_loss_amount: 15000, extra_undeclared_field: 'x' });
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]?.property, 'extra_undeclared_field');
  assert.match(result.issues[0]?.message ?? '', /unknown property/);
});

test('rejects a non-object input (array)', () => {
  const result = validateCapabilityInput(schema, [1, 2, 3]);
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.issues[0]?.property, '$');
  assert.match(result.issues[0]?.message ?? '', /got array/);
});

test('rejects a non-object input (null)', () => {
  const result = validateCapabilityInput(schema, null);
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.match(result.issues[0]?.message ?? '', /got null/);
});

test('rejects a non-object input (primitive string)', () => {
  const result = validateCapabilityInput(schema, 'not an object');
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.match(result.issues[0]?.message ?? '', /got string/);
});

test('reports every issue at once rather than stopping at the first', () => {
  const result = validateCapabilityInput(schema, { claimed_loss_amount: 'bad', unknown_field: true });
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.issues.length, 2);
  const properties = result.issues.map((issue) => issue.property).sort();
  assert.deepEqual(properties, ['claimed_loss_amount', 'unknown_field']);
});

test('an empty schema (no required, no properties) accepts an empty input object', () => {
  const emptySchema: CapabilityInputSchema = { type: 'object', properties: {}, required: [] };
  const result = validateCapabilityInput(emptySchema, {});
  assert.equal(result.valid, true);
});

test('an empty schema still rejects an object carrying any property at all', () => {
  const emptySchema: CapabilityInputSchema = { type: 'object', properties: {}, required: [] };
  const result = validateCapabilityInput(emptySchema, { anything: 1 });
  assert.equal(result.valid, false);
});
