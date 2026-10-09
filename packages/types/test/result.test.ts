import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, err, isOk, isErr, unwrap, mapResult, fromPromise } from '../src/result.js';

test('ok() produces a success Result', () => {
  const r = ok(42);
  assert.equal(isOk(r), true);
  assert.equal(isErr(r), false);
  assert.equal(unwrap(r), 42);
});

test('err() produces a failure Result', () => {
  const r = err(new Error('boom'));
  assert.equal(isErr(r), true);
  assert.throws(() => unwrap(r), /boom/);
});

test('mapResult only transforms the success channel', () => {
  const success = mapResult(ok(2), (n) => n * 10);
  assert.deepEqual(success, ok(20));

  const failure = err<string>('nope');
  assert.deepEqual(mapResult(failure, (n: number) => n * 10), failure);
});

test('fromPromise wraps a rejecting promise into an err Result', async () => {
  const r = await fromPromise(Promise.reject(new Error('rejected')));
  assert.equal(isErr(r), true);
  if (isErr(r)) assert.equal(r.error.message, 'rejected');
});

test('fromPromise wraps a resolving promise into an ok Result', async () => {
  const r = await fromPromise(Promise.resolve('done'));
  assert.deepEqual(r, ok('done'));
});
