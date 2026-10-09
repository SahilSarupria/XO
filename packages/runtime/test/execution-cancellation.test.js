import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionCancellation } from '../src/cancellation/execution-cancellation.js';
test('a fresh ExecutionCancellation is not cancelled', () => {
    const cancellation = new ExecutionCancellation();
    assert.equal(cancellation.isCancelled, false);
    assert.equal(cancellation.signal.aborted, false);
    cancellation.dispose();
});
test('cancel() aborts the signal with the given reason', () => {
    const cancellation = new ExecutionCancellation();
    cancellation.cancel('user requested');
    assert.equal(cancellation.isCancelled, true);
    assert.equal(cancellation.reason, 'user requested');
    cancellation.dispose();
});
test('cancel() defaults to a "cancelled" reason', () => {
    const cancellation = new ExecutionCancellation();
    cancellation.cancel();
    assert.equal(cancellation.reason, 'cancelled');
    cancellation.dispose();
});
test('cancel() is idempotent — calling it twice does not throw or change the first reason', () => {
    const cancellation = new ExecutionCancellation();
    cancellation.cancel('first');
    cancellation.cancel('second');
    assert.equal(cancellation.reason, 'first');
    cancellation.dispose();
});
test('constructing with timeoutMs auto-cancels with reason "timeout" after the delay', async () => {
    const cancellation = new ExecutionCancellation(10);
    assert.equal(cancellation.isCancelled, false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(cancellation.isCancelled, true);
    assert.equal(cancellation.reason, 'timeout');
    cancellation.dispose();
});
test('dispose() prevents a pending timeout from firing', async () => {
    const cancellation = new ExecutionCancellation(10);
    cancellation.dispose();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(cancellation.isCancelled, false);
});
test('reason is undefined before any cancellation', () => {
    const cancellation = new ExecutionCancellation();
    assert.equal(cancellation.reason, undefined);
    cancellation.dispose();
});
//# sourceMappingURL=execution-cancellation.test.js.map