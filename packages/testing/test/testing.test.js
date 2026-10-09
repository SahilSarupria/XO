import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLogger } from '../src/mock-logger.js';
import { MockClock } from '../src/mock-clock.js';
test('MockLogger captures records', () => {
    const logger = new MockLogger();
    logger.info('hello', { a: 1 });
    assert.equal(logger.records.length, 1);
    assert.equal(logger.records[0]?.message, 'hello');
});
test('MockLogger.child shares the backing record array', () => {
    const logger = new MockLogger();
    const child = logger.child({ scope: 'x' });
    child.warn('from child');
    assert.equal(logger.records.length, 1);
    assert.equal(logger.records[0]?.fields.scope, 'x');
});
test('MockClock advances deterministically', () => {
    const clock = new MockClock('2026-01-01T00:00:00.000Z');
    assert.equal(clock.now().toISOString(), '2026-01-01T00:00:00.000Z');
    clock.advance(60_000);
    assert.equal(clock.now().toISOString(), '2026-01-01T00:01:00.000Z');
});
//# sourceMappingURL=testing.test.js.map