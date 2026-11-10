import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandRegistry } from '../src/command-registry.js';
import { registerCommands } from '../src/commands/flow/index.js';
import { anchoringFromFlags } from '../src/commands/flow/runtime-options.js';
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

test('anchors: a run publishes its head outside the runs directory; verify-anchors catches a cut-back journal', async () => {
  await withTempDir('xo-flow-anc-', async (tmp) => {
    const file = join(tmp, 'wf.json');
    writeFileSync(file, JSON.stringify(component));
    const runs = join(tmp, 'runs');
    const anchors = join(tmp, 'anchors', 'a.jsonl');
    const base = { workflow: 'wf', runs, 'anchor-file': anchors };
    // inside the runs directory: refused, nothing runs
    const inside = await flow(['run', file], { workflow: 'wf', runs, 'anchor-file': join(runs, 'a.jsonl'), input: '{"claim":"c"}' });
    assert.equal(inside.code, 1);
    assert.match(inside.err, /OUTSIDE the runs directory/);
    // run to a waiting state, then deliver the event: finishes and anchors
    assert.equal((await flow(['run', file], { ...base, input: '{"claim":"c-1"}' })).code, 2);
    const ev = await flow(['event', file], { ...base, name: 'doc.received', correlation: 'c-1', 'event-id': 'e1', input: '{"amt":1}' });
    assert.equal(ev.code, 0, ev.err);
    const recorded = readFileSync(anchors, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { runId: string; seq: number });
    assert.ok(recorded.length >= 1);
    const ok = await flow(['verify-anchors'], { runs, anchors });
    assert.equal(ok.code, 0, ok.text);
    assert.match(ok.text, /every anchored position matches/);

    // an attacker cuts the journal back below the anchored position
    const j = join(runs, recorded[0]!.runId, 'journal.jsonl');
    const lines = readFileSync(j, 'utf8').trimEnd().split('\n');
    writeFileSync(j, `${lines.slice(0, 2).join('\n')}\n`);
    const cut = await flow(['verify-anchors'], { runs, anchors });
    assert.equal(cut.code, 1);
    assert.match(cut.text, /truncated/);
    // no anchors at all is not "verified"
    assert.equal((await flow(['verify-anchors'], { runs, anchors: join(tmp, 'none.jsonl') })).code, 1);
    assert.equal((await flow(['verify-anchors'], { runs })).code, 1);
  });
});

test('anchoring flags are strict: webhook without a long secret and non-https URLs are refused', () => {
  const env = (url: string, secret = ''): Record<string, string> => ({ XO_ANCHOR_URL: url, XO_ANCHOR_SECRET: secret });
  assert.equal(anchoringFromFlags({}, '/r', {}).ok && (anchoringFromFlags({}, '/r', {}) as { value: unknown }).value === undefined, true);
  assert.equal(anchoringFromFlags({}, '/r', env('https://a.example/x', 'short')).ok, false);
  assert.equal(anchoringFromFlags({}, '/r', env('http://a.example/x', 'long-enough-secret-123')).ok, false);
  assert.equal(anchoringFromFlags({}, '/r', env('https://a.example/x', 'long-enough-secret-123')).ok, true);
  assert.equal(anchoringFromFlags({ 'anchor-file': true }, '/r', {}).ok, false);
  assert.equal(anchoringFromFlags({ 'anchor-file': '/r' }, '/r', {}).ok, false);
});
