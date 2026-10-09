import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConsoleLogger } from '@xo/logger';
import { ConsoleTracer, ConsoleMeter } from '../src/console-exporter.js';
import { noopTracer, noopMeter } from '../src/noop.js';

test('ConsoleTracer.withSpan records ok status on success', async () => {
  const lines: string[] = [];
  const logger = new ConsoleLogger({ level: 'debug', write: (l) => lines.push(l) });
  const tracer = new ConsoleTracer(logger);
  const result = await tracer.withSpan('unit-test-span', (span) => {
    span.setAttribute('foo', 'bar');
    return 42;
  });
  assert.equal(result, 42);
  const spanLog = lines.map((l) => JSON.parse(l)).find((l) => l.message === 'span ended: unit-test-span');
  assert.ok(spanLog);
  assert.equal(spanLog.status, 'ok');
  assert.equal(spanLog.foo, 'bar');
});

test('ConsoleTracer.withSpan records error status and rethrows', async () => {
  const lines: string[] = [];
  const logger = new ConsoleLogger({ level: 'debug', write: (l) => lines.push(l) });
  const tracer = new ConsoleTracer(logger);
  await assert.rejects(() =>
    tracer.withSpan('failing-span', () => {
      throw new Error('kaboom');
    }),
  );
  const spanLog = lines.map((l) => JSON.parse(l)).find((l) => l.message === 'span ended: failing-span');
  assert.equal(spanLog.status, 'error');
});

test('ConsoleMeter counters/histograms log through the injected logger', () => {
  const lines: string[] = [];
  const logger = new ConsoleLogger({ level: 'info', write: (l) => lines.push(l) });
  const meter = new ConsoleMeter(logger);
  meter.createCounter('requests_total').add(1, { route: '/health' });
  meter.createHistogram('latency_ms').record(12.5);
  assert.equal(lines.length, 2);
});

test('noop tracer/meter never throw', async () => {
  await noopTracer.withSpan('x', () => 1);
  noopMeter.createCounter('c').add(1);
  noopMeter.createHistogram('h').record(1);
});
