import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConsoleLogger } from '../src/console-logger.js';
import { noopLogger } from '../src/noop-logger.js';

test('logs at or above the configured level', () => {
  const lines: string[] = [];
  const logger = new ConsoleLogger({ level: 'warn', name: 'test', write: (l) => lines.push(l) });
  logger.debug('should be dropped');
  logger.warn('should appear');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.level, 'warn');
  assert.equal(parsed.message, 'should appear');
  assert.equal(parsed.logger, 'test');
});

test('child() merges bound fields into every subsequent record', () => {
  const lines: string[] = [];
  const logger = new ConsoleLogger({ level: 'info', write: (l) => lines.push(l) });
  const child = logger.child({ requestId: 'abc-123' });
  child.info('handled request');
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.requestId, 'abc-123');
  assert.equal(parsed.message, 'handled request');
});

test('per-call fields override bound child fields', () => {
  const lines: string[] = [];
  const logger = new ConsoleLogger({ level: 'info', write: (l) => lines.push(l) }).child({ scope: 'a' });
  logger.info('msg', { scope: 'b' });
  assert.equal(JSON.parse(lines[0]!).scope, 'b');
});

test('noopLogger never throws and never writes', () => {
  assert.doesNotThrow(() => {
    noopLogger.info('anything');
    noopLogger.child({ a: 1 }).error('anything else');
  });
});
