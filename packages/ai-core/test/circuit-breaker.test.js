import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../src/circuit-breaker.js';
class FakeClock {
    currentMs = 0;
    now() {
        return this.currentMs;
    }
    advance(ms) {
        this.currentMs += ms;
    }
}
test('stays closed while failures are below the threshold', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    for (let i = 0; i < 2; i += 1) {
        await assert.rejects(() => breaker.execute(async () => Promise.reject(new Error('fail'))));
    }
    assert.equal(breaker.getState(), 'closed');
});
test('trips open once failureThreshold consecutive failures occur', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    for (let i = 0; i < 3; i += 1) {
        await assert.rejects(() => breaker.execute(async () => Promise.reject(new Error('fail'))));
    }
    assert.equal(breaker.getState(), 'open');
});
test('rejects immediately without calling fn while open', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000 });
    await assert.rejects(() => breaker.execute(async () => Promise.reject(new Error('fail'))));
    let called = false;
    await assert.rejects(() => breaker.execute(async () => {
        called = true;
        return 'x';
    }), /Circuit is open/);
    assert.equal(called, false);
});
test('transitions to half_open after cooldown and closes again on success', async () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, clock });
    await assert.rejects(() => breaker.execute(async () => Promise.reject(new Error('fail'))));
    assert.equal(breaker.getState(), 'open');
    clock.advance(1000);
    assert.equal(breaker.getState(), 'half_open');
    const result = await breaker.execute(async () => 'recovered');
    assert.equal(result, 'recovered');
    assert.equal(breaker.getState(), 'closed');
});
test('a failure while half_open reopens the circuit immediately', async () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, clock });
    await assert.rejects(() => breaker.execute(async () => Promise.reject(new Error('fail'))));
    clock.advance(1000);
    assert.equal(breaker.getState(), 'half_open');
    await assert.rejects(() => breaker.execute(async () => Promise.reject(new Error('still failing'))));
    assert.equal(breaker.getState(), 'open');
});
test('successThreshold requires multiple consecutive successes before fully closing', async () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, successThreshold: 2, clock });
    await assert.rejects(() => breaker.execute(async () => Promise.reject(new Error('fail'))));
    clock.advance(1000);
    await breaker.execute(async () => 'ok-1');
    assert.equal(breaker.getState(), 'half_open');
    await breaker.execute(async () => 'ok-2');
    assert.equal(breaker.getState(), 'closed');
});
//# sourceMappingURL=circuit-breaker.test.js.map