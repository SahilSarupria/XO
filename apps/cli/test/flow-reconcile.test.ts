import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { RunStore } from '@xo/workflow-runtime';
import { CommandRegistry } from '../src/command-registry.js';
import { registerCommands } from '../src/commands/flow/index.js';
import { withTempDir } from './helpers.js';

async function flow(flags: Record<string, string | boolean>): Promise<{ code: number; text: string }> {
  const registry = new CommandRegistry();
  registerCommands(registry);
  const chunks: string[] = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Uint8Array) => (chunks.push(String(c)), true)) as typeof process.stdout.write;
  try {
    const code = await registry.get('flow')!.run({ positionals: ['reconcile'], flags } as never);
    return { code: Number(code), text: chunks.join('') };
  } finally {
    process.stdout.write = real;
  }
}

test('reconcile: an empty runs directory is clean (exit 0) and says so; a missing --runs is a usage error', async () => {
  await withTempDir('xo-rec-empty-', async (tmp) => {
    const r = await flow({ runs: tmp });
    assert.equal(r.code, 0);
    assert.match(r.text, /0 run\(s\) read; 0 external write\(s\) settled without a plain outcome, 0 need attention/);
  });
  const none = await flow({});
  assert.notEqual(none.code, 0);
});

test('reconcile: an intent with no outcome exits 1 and says what to do; a settled one exits 0; --json is machine-readable', async () => {
  await withTempDir('xo-rec-', async (tmp) => {
    const store = new RunStore(join(tmp, 'runs'));
    await store.create('r1');
    await store.append('r1', 'call_intent', { step: 'pay', connector: 'bank', operation: 'pay', key: 'k-1', requestHash: 'h1' });
    await store.append('r1', 'effect_ambiguous', {
      step: 'pay',
      connector: 'bank',
      operation: 'pay',
      mode: 'none',
      reason: 'this destination has no duplicate protection (idempotency: none)',
    });
    await store.create('r2');
    await store.append('r2', 'call_intent', { step: 'pay', connector: 'bank', operation: 'pay', key: 'k-2' });
    await store.append('r2', 'call_outcome', { step: 'pay', ok: true, data: {} });
    const r = await flow({ runs: join(tmp, 'runs') });
    assert.equal(r.code, 1);
    assert.match(r.text, /2 run\(s\) read; 0 external write\(s\) settled.*1 need attention/);
    assert.match(r.text, /\[ambiguous\] run r1 step pay: bank\.pay key k-1/);
    assert.match(r.text, /check the destination by hand/);
    assert.match(r.text, /Nothing was sent or changed/);
    const j = await flow({ runs: join(tmp, 'runs'), json: true });
    const rep = JSON.parse(j.text) as { needsAttention: boolean; effects: { runId: string; status: string }[] };
    assert.equal(rep.needsAttention, true);
    assert.deepEqual(
      rep.effects.map((e) => [e.runId, e.status]),
      [['r1', 'ambiguous']],
    );
  });
});
