import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundError, InvalidArgumentError } from '../src/domain-errors.js';
import { ErrorCode } from '../src/error-codes.js';
import { assert as invariant, assertUnreachable } from '../src/assert.js';

test('NotFoundError carries a stable code and readable message', () => {
  const e = new NotFoundError('PackageId(foo)');
  assert.equal(e.code, ErrorCode.NOT_FOUND);
  assert.match(e.message, /PackageId\(foo\)/);
  assert.equal(e.name, 'NotFoundError');
});

test('errors serialize to a JSON-safe shape', () => {
  const e = new InvalidArgumentError('bad input', { context: { field: 'name' } });
  const json = e.toJSON();
  assert.equal(json.code, ErrorCode.INVALID_ARGUMENT);
  assert.deepEqual(json.context, { field: 'name' });
});

test('cause chains are preserved', () => {
  const cause = new Error('root cause');
  const e = new NotFoundError('X', { cause });
  assert.equal(e.cause, cause);
});

test('assert() throws on a false condition', () => {
  assert.throws(() => invariant(1 === 2, 'math is broken'));
});

test('assert() is a no-op on a true condition', () => {
  assert.doesNotThrow(() => invariant(1 === 1, 'unreachable'));
});

test('assertUnreachable throws for exhaustiveness checks', () => {
  assert.throws(() => assertUnreachable('unexpected' as never, 'status'));
});
