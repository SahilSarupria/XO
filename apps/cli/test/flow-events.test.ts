import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunStore, FileDeadLetterStore } from '@xo/workflow-runtime';
import { CommandRegistry } from '../src/command-registry.js';
import { registerCommands } from '../src/commands/flow/index.js';
import { rateLimitsFromFlags } from '../src/commands/flow/runtime-options.js';
import { withTempDir } from './helpers.js';

async function flow(positionals: string[], flags: Record<string, string | boolean>): Promise<{ code: number; text: string; err: string }> {
  const registry = new CommandRegistry();
  registerCommands(registry);
  const out: string[] = [];
  const err: string[] = [];
  const rOut = process.stdout.write.bind(process.stdout);
  const rErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => (out.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => (err.push(String(c)), true)) as typeof process.stderr.write;
  try {
    const code = await registry.get('flow')!.run({ positionals, flags } as never);
    return { code: Number(code), text: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = rOut;
    process.stderr.write = rErr;
  }
}

const component = {
  formatVersion: '1.0',
  semanticsVersion: '1.0',
  connectors: [{ id: 'bank', kind: 'http', operations: [{ name: 'pay', sideEffect: 'write' }] }],
  workflows: [
    {
      id: 'wf',
      version: '1.0.0',
      triggers: [{ id: 't', kind: 'api' }],
      inputs: { claim: { type: 'string', required: true } },
      steps: [
        {
          id: 'w',
          type: 'wait',
          determinism: 'deterministic',
          timeoutMs: 30_000,
          for: { kind: 'event', name: 'doc.received', correlationKey: 'claim' },
          onTimeout: 'escalate',
          outputs: { amt: { type: 'number' } },
        },
      ],
      result: { amt: { from: 'steps.w.amt' } },
      maxConcurrency: 2,
      runTimeoutMs: 60_000,
      cancellation: { onCancel: 'abandon' },
      requiresFeatures: ['wait_event'],
    },
  ],
};

test('xo flow event: a waiting run is released by exactly one delivery; a retry is a duplicate; dead-letters is read-only', async () => {
  await withTempDir('xo-flow-ev-', async (tmp) => {
    const file = join(tmp, 'wf.json');
    writeFileSync(file, JSON.stringify(component));
    const runs = join(tmp, 'runs');
    const base = { workflow: 'wf', runs };
    const started = await flow(['run', file], { ...base, input: '{"claim":"c-1"}' });
    assert.equal(started.code, 2, started.err); // waiting
    assert.match(started.text, /"state": "waiting"/);

    const wrong = await flow(['event', file], {
      ...base,
      name: 'doc.received',
      correlation: 'other',
      'event-id': 'e0',
      input: '{"amt":1}',
    });
    assert.equal(wrong.code, 0);
    assert.deepEqual((JSON.parse(wrong.text) as { resumed: string[] }).resumed, []);

    const d = await flow(['event', file], { ...base, name: 'doc.received', correlation: 'c-1', 'event-id': 'e1', input: '{"amt":42}' });
    assert.equal(d.code, 0, d.err);
    const first = JSON.parse(d.text) as { status: string; resumed: string[] };
    assert.equal(first.status, 'queued');
    assert.equal(first.resumed.length, 1);
    const entries = await new RunStore(runs).read(first.resumed[0]!);
    assert.equal(entries.at(-1)?.type, 'run_finished');
    assert.equal((entries.at(-1)?.data as { state: string }).state, 'completed');

    const again = await flow(['event', file], { ...base, name: 'doc.received', correlation: 'c-1', 'event-id': 'e1', input: '{"amt":42}' });
    assert.equal((JSON.parse(again.text) as { status: string }).status, 'duplicate');

    const bad = await flow(['event', file], { ...base, name: '../x', correlation: 'c', 'event-id': 'e', input: '{}' });
    assert.equal(bad.code, 1);
    assert.match(bad.err, /invalid event/);
    const noId = await flow(['event', file], { ...base, name: 'a', correlation: 'c' });
    assert.equal(noId.code, 1);

    await new FileDeadLetterStore(join(runs, 'dead-letters')).put({
      runId: 'r',
      workflow: 'wf',
      version: '1',
      step: 's',
      code: 'FAILED',
      message: 'boom',
      attempts: 3,
      disposition: 'failed',
      at: 'x',
    });
    const dl = await flow(['dead-letters'], { runs });
    assert.equal(dl.code, 0);
    assert.match(dl.text, /1 dead letter\(s\)/);
    assert.match(dl.text, /\[failed\] run r step s: FAILED after 3 attempt\(s\) — boom/);
    assert.equal((await flow(['dead-letters'], {})).code, 1);
  });
});

test('--rate-limit is strict: unknown connectors, duplicates, zero rates and junk are errors, never ignored', () => {
  const known = ['bank', 'slack'];
  const ok = rateLimitsFromFlags({ 'rate-limit': 'bank=2:5,slack=0.5' }, known);
  assert.equal(ok.ok, true);
  assert.equal(rateLimitsFromFlags({}, known).ok && (rateLimitsFromFlags({}, known) as { value: unknown }).value === undefined, true);
  for (const bad of ['', 'bank', 'bank=0', 'bank=-1', 'bank=1:0', 'ghost=1', 'bank=1,bank=2', 'bank=fast', 'bank=1:2:3', '../x=1'])
    assert.equal(rateLimitsFromFlags({ 'rate-limit': bad }, known).ok, false, bad);
  assert.equal(rateLimitsFromFlags({ 'rate-limit': true }, known).ok, false);
});
