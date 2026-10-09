import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RetryPolicy } from '../src/retry.js';

function noopSleep(): Promise<void> {
  return Promise.resolve();
}

test('succeeds on the first attempt without retrying', async () => {
  const policy = new RetryPolicy({ maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 10, backoffMultiplier: 2, sleep: noopSleep });
  let calls = 0;
  const outcome = await policy.execute(async () => {
    calls += 1;
    return 'ok';
  });
  assert.equal(outcome.value, 'ok');
  assert.equal(outcome.attempts, 1);
  assert.equal(calls, 1);
});

test('retries up to maxAttempts then succeeds', async () => {
  const policy = new RetryPolicy({ maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 10, backoffMultiplier: 2, sleep: noopSleep });
  let calls = 0;
  const outcome = await policy.execute(async () => {
    calls += 1;
    if (calls < 3) throw new Error('transient');
    return 'ok';
  });
  assert.equal(outcome.attempts, 3);
  assert.equal(outcome.history.length, 2);
});

test('throws the final error once maxAttempts is exhausted', async () => {
  const policy = new RetryPolicy({ maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 10, backoffMultiplier: 2, sleep: noopSleep });
  await assert.rejects(
    () =>
      policy.execute(async () => {
        throw new Error('always fails');
      }),
    /always fails/,
  );
});

test('isRetryable can stop retrying early even with attempts remaining', async () => {
  const policy = new RetryPolicy({ maxAttempts: 5, initialDelayMs: 1, maxDelayMs: 10, backoffMultiplier: 2, sleep: noopSleep, isRetryable: () => false });
  let calls = 0;
  await assert.rejects(
    () =>
      policy.execute(async () => {
        calls += 1;
        throw new Error('non-retryable');
      }),
    /non-retryable/,
  );
  assert.equal(calls, 1);
});

test('applies exponential backoff to the delay passed to sleep', async () => {
  const delays: number[] = [];
  const policy = new RetryPolicy({
    maxAttempts: 4,
    initialDelayMs: 100,
    maxDelayMs: 10_000,
    backoffMultiplier: 2,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  let calls = 0;
  await policy.execute(async () => {
    calls += 1;
    if (calls < 4) throw new Error('retry me');
    return 'done';
  });
  assert.deepEqual(delays, [100, 200, 400]);
});

test('caps delay at maxDelayMs', async () => {
  const delays: number[] = [];
  const policy = new RetryPolicy({
    maxAttempts: 4,
    initialDelayMs: 100,
    maxDelayMs: 150,
    backoffMultiplier: 10,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  let calls = 0;
  await policy.execute(async () => {
    calls += 1;
    if (calls < 4) throw new Error('retry me');
    return 'done';
  });
  assert.deepEqual(delays, [100, 150, 150]);
});
