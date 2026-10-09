import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucketRateLimiter } from '../src/rate-limiter.js';
import type { Clock } from '../src/clock.js';

class FakeClock implements Clock {
  private currentMs = 0;
  now(): number {
    return this.currentMs;
  }
  advance(ms: number): void {
    this.currentMs += ms;
  }
}

test('allows acquisitions up to capacity, then denies', () => {
  const limiter = new TokenBucketRateLimiter({ capacity: 3, refillPerSecond: 1 });
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), false);
});

test('refills over time based on refillPerSecond', () => {
  const clock = new FakeClock();
  const limiter = new TokenBucketRateLimiter({ capacity: 2, refillPerSecond: 1, clock });
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), false);

  clock.advance(1000);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), false);
});

test('never refills beyond capacity', () => {
  const clock = new FakeClock();
  const limiter = new TokenBucketRateLimiter({ capacity: 2, refillPerSecond: 100, clock });
  clock.advance(10_000); // would refill far past capacity if unbounded
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), false);
});

test('waitTimeMs reports 0 when tokens are available and a positive estimate otherwise', () => {
  const clock = new FakeClock();
  const limiter = new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 2, clock });
  assert.equal(limiter.waitTimeMs(), 0);
  limiter.tryAcquire();
  assert.equal(limiter.waitTimeMs(), 500); // needs 1 token at 2/sec => 500ms
});

test('supports acquiring more than 1 token at a time', () => {
  const limiter = new TokenBucketRateLimiter({ capacity: 5, refillPerSecond: 1 });
  assert.equal(limiter.tryAcquire(3), true);
  assert.equal(limiter.tryAcquire(3), false);
  assert.equal(limiter.tryAcquire(2), true);
});
