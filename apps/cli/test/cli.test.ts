import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/arg-parser.js';
import { run } from '../src/index.js';
import { ConsoleLogger } from '@xo/logger';

test('parseArgs separates command, flags, and positionals', () => {
  const parsed = parseArgs(['config', 'show', '--verbose']);
  assert.equal(parsed.command, 'config');
  assert.deepEqual(parsed.positionals, ['show']);
  assert.equal(parsed.flags.verbose, true);
});

test('parseArgs reads a value for --flag value pairs', () => {
  const parsed = parseArgs(['doctor', '--format', 'json']);
  assert.equal(parsed.flags.format, 'json');
});

test('run() with no command prints usage and exits 0', async () => {
  const originalWrite = process.stdout.write;
  let captured = '';
  process.stdout.write = ((chunk: string) => {
    captured += chunk;
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await run([]);
    assert.equal(code, 0);
    assert.match(captured, /Experience Object platform CLI/);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test('run() with an unknown command exits 1', async () => {
  const originalWrite = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const code = await run(['not-a-real-command'], new ConsoleLogger({ level: 'fatal' }));
    assert.equal(code, 1);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test('run() doctor exits 0 when running under a supported Node version', async () => {
  const originalWrite = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const code = await run(['doctor']);
    assert.equal(code, 0);
  } finally {
    process.stdout.write = originalWrite;
  }
});
