import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCondition, resolvePath } from '../src/workflow/workflow-condition.js';

test('resolvePath resolves a simple key', () => {
  assert.equal(resolvePath({ risk: 'high' }, 'risk'), 'high');
});

test('resolvePath resolves a nested dot-path', () => {
  assert.equal(resolvePath({ review: { risk: 'high' } }, 'review.risk'), 'high');
});

test('resolvePath returns undefined for a missing path, never throws', () => {
  assert.equal(resolvePath({ review: {} }, 'review.risk'), undefined);
  assert.equal(resolvePath({}, 'a.b.c'), undefined);
  assert.equal(resolvePath({ review: 'not-an-object' }, 'review.risk'), undefined);
});

test('eq / neq', () => {
  assert.equal(evaluateCondition({ kind: 'expression', field: 'x', operator: 'eq', value: 5 }, { x: 5 }), true);
  assert.equal(evaluateCondition({ kind: 'expression', field: 'x', operator: 'eq', value: 5 }, { x: 6 }), false);
  assert.equal(evaluateCondition({ kind: 'expression', field: 'x', operator: 'neq', value: 5 }, { x: 6 }), true);
});

test('gt / gte / lt / lte only match numbers, otherwise false', () => {
  assert.equal(evaluateCondition({ kind: 'expression', field: 'x', operator: 'gt', value: 5 }, { x: 6 }), true);
  assert.equal(evaluateCondition({ kind: 'expression', field: 'x', operator: 'gte', value: 6 }, { x: 6 }), true);
  assert.equal(evaluateCondition({ kind: 'expression', field: 'x', operator: 'lt', value: 5 }, { x: 4 }), true);
  assert.equal(evaluateCondition({ kind: 'expression', field: 'x', operator: 'lte', value: 4 }, { x: 4 }), true);
  assert.equal(evaluateCondition({ kind: 'expression', field: 'x', operator: 'gt', value: 5 }, { x: 'not a number' }), false);
});

test('exists / truthy / falsy', () => {
  assert.equal(evaluateCondition({ kind: 'expression', field: 'x', operator: 'exists' }, { x: 0 }), true);
  assert.equal(evaluateCondition({ kind: 'expression', field: 'x', operator: 'exists' }, {}), false);
  assert.equal(evaluateCondition({ kind: 'expression', field: 'x', operator: 'truthy' }, { x: 'yes' }), true);
  assert.equal(evaluateCondition({ kind: 'expression', field: 'x', operator: 'truthy' }, { x: 0 }), false);
  assert.equal(evaluateCondition({ kind: 'expression', field: 'x', operator: 'falsy' }, { x: 0 }), true);
});

test('a predicate condition defers to the supplied function', () => {
  const condition = { kind: 'predicate' as const, evaluate: (outputs: Readonly<Record<string, unknown>>) => outputs.x === 'go' };
  assert.equal(evaluateCondition(condition, { x: 'go' }), true);
  assert.equal(evaluateCondition(condition, { x: 'stop' }), false);
});
