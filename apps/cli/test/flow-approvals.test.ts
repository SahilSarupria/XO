import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunStore, generateReviewerKeys } from '@xo/workflow-runtime';
import { CommandRegistry } from '../src/command-registry.js';
import { registerCommands } from '../src/commands/flow/index.js';
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
  connectors: [],
  workflows: [
    {
      id: 'wf',
      version: '1.0.0',
      triggers: [{ id: 't', kind: 'api' }],
      inputs: { amount: { type: 'number', required: true }, claim: { type: 'string', required: true } },
      steps: [
        {
          id: 'gate',
          type: 'approve',
          determinism: 'human',
          timeoutMs: 60_000,
          roles: ['reviewer'],
          onTimeout: 'escalate',
          onError: 'escalate',
          summary: 'Pay {{input.claim}}?',
          inputs: { amount: { from: 'input.amount' } },
          outputs: { decision: { type: 'enum', enum: ['approved', 'rejected'] } },
        },
      ],
      result: { decision: { from: 'steps.gate.decision' } },
      maxConcurrency: 2,
      runTimeoutMs: 600_000,
      cancellation: { onCancel: 'abandon' },
      requiresFeatures: ['approve'],
    },
  ],
};

test('xo flow approvals: requests are delivered to a directory, listed, and decided only with a verifying signature from a trusted reviewer', async () => {
  await withTempDir('xo-flow-appr-', async (tmp) => {
    const wf = join(tmp, 'wf.json');
    writeFileSync(wf, JSON.stringify(component));
    const ann = generateReviewerKeys();
    const eve = generateReviewerKeys();
    const revFile = join(tmp, 'reviewers.json');
    writeFileSync(revFile, JSON.stringify([{ id: 'ann', roles: ['reviewer'], publicKeyPem: ann.publicKeyPem }]));
    writeFileSync(join(tmp, 'ann.pem'), ann.privateKeyPem);
    writeFileSync(join(tmp, 'eve.pem'), eve.privateKeyPem);
    const runs = join(tmp, 'runs');
    const dir = join(tmp, 'outbox');
    const base = { workflow: 'wf', runs, approvers: revFile, 'approval-dir': dir };

    // no reviewer policy: an approve workflow cannot start
    const noPolicy = await flow(['run', wf], { workflow: 'wf', runs: join(tmp, 'r2'), input: '{"amount":5,"claim":"c-1"}' });
    assert.notEqual(noPolicy.code, 0);
    // a broken policy is an error, not "no reviewers"
    writeFileSync(join(tmp, 'bad.json'), '[]');
    assert.match(
      (await flow(['run', wf], { ...base, approvers: join(tmp, 'bad.json'), input: '{"amount":5,"claim":"c-1"}' })).err,
      /no reviewers/,
    );

    const started = await flow(['run', wf], { ...base, input: '{"amount":5,"claim":"c-1"}' });
    assert.equal(started.code, 2, started.err);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.json')).length, 1); // delivered
    const listed = await flow(['approvals', 'list', wf], base);
    assert.match(listed.text, /1 pending approval\(s\)/);
    const id = /(appr_[0-9a-f]{64})/.exec(listed.text)![1]!;
    assert.equal(JSON.parse((await flow(['approvals', 'get', wf], { ...base, approval: id })).text).step, 'gate');

    const decide = (key: string, reviewer: string, action = 'approve') =>
      flow(['approvals', 'decide', wf], { ...base, approval: id, key: join(tmp, key), reviewer, action });
    // wrong key for a trusted name, an unknown reviewer, a bad action: all refused, the run stays waiting
    assert.match((await decide('eve.pem', 'ann')).err, /BAD_SIGNATURE/);
    assert.match((await decide('eve.pem', 'eve')).err, /UNKNOWN_REVIEWER/);
    assert.equal((await decide('ann.pem', 'ann', 'maybe')).code, 1);
    assert.match((await flow(['approvals', 'list', wf], base)).text, /1 pending approval/);
    // a real decision completes the run, once
    const done = await decide('ann.pem', 'ann');
    assert.equal(done.code, 0, done.err);
    const runId = (JSON.parse(started.text) as { runId: string }).runId;
    const last = (await new RunStore(runs).read(runId)).at(-1);
    assert.equal((last?.data as { state: string }).state, 'completed');
    assert.equal((await decide('ann.pem', 'ann')).code, 1); // a second decision for the same request is refused
    assert.equal((await flow(['approvals', 'bogus', wf], base)).code, 1);
  });
});
