import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateReviewerKeys, proposeRules, type LoggedCase } from '@xo/workflow-runtime';
import { CommandRegistry } from '../src/command-registry.js';
import { registerCommands } from '../src/commands/flow/index.js';
import { withTempDir } from './helpers.js';

async function flow(positionals: string[], flags: Record<string, string | boolean>): Promise<{ code: number; text: string; err: string }> {
  const registry = new CommandRegistry();
  registerCommands(registry);
  const out: string[] = [];
  const err: string[] = [];
  const rO = process.stdout.write.bind(process.stdout);
  const rE = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => (out.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => (err.push(String(c)), true)) as typeof process.stderr.write;
  try {
    const code = await registry.get('flow')!.run({ positionals, flags } as never);
    return { code: Number(code), text: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = rO;
    process.stderr.write = rE;
  }
}

const comp = {
  formatVersion: '1.0',
  semanticsVersion: '1.0',
  connectors: [],
  workflows: [
    {
      id: 'wf',
      version: '1.0.0',
      triggers: [{ id: 't', kind: 'api' }],
      inputs: { amount: { type: 'number', required: true }, region: { type: 'string', required: true } },
      steps: [
        {
          id: 'd',
          type: 'decide',
          determinism: 'deterministic',
          timeoutMs: 1000,
          inputs: { amount: { from: 'input.amount' } },
          method: { kind: 'rules', rules: [{ id: 'tiny', when: 'amount <= 10', set: { verdict: 'approved' } }], onNoMatch: 'escalate' },
          outputs: { verdict: { type: 'enum', enum: ['approved', 'rejected'] } },
        },
      ],
      result: { verdict: { from: 'steps.d.verdict' } },
      maxConcurrency: 2,
      runTimeoutMs: 60000,
      cancellation: { onCancel: 'abandon' },
      requiresFeatures: ['rules'],
    },
  ],
};

test('promote: propose with no history refuses to propose anything; apply needs a verifying publisher signature, every other path is refused', async () => {
  await withTempDir('xo-promote-', async (tmp) => {
    const wf = join(tmp, 'wf.json');
    writeFileSync(wf, JSON.stringify(comp));
    const none = await flow(['promote', 'propose', wf], {
      runs: join(tmp, 'runs'),
      workflow: 'wf',
      'approve-step': 'gate',
      step: 'd',
      'output-field': 'verdict',
      out: join(tmp, 'p'),
    });
    assert.equal(none.code, 2);
    assert.match(none.text, /0 logged case\(s\); 0 rule\(s\) proposed; shadow validation: FAILED/);
    assert.match(none.text, /Nothing was applied/);
    assert.equal(
      (
        await flow(['promote', 'propose', wf], {
          runs: tmp,
          workflow: 'wf',
          'approve-step': 'g',
          step: 'd',
          'output-field': 'verdict',
          out: tmp,
          'min-support': '1',
        })
      ).code,
      1,
    );

    // a patch built from 6 consistent cases
    const cases: LoggedCase[] = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      facts: { region: 'west', amount: 100 + i },
      outcome: 'rejected',
      source: 'human',
    }));
    const patch = proposeRules(cases, { workflow: comp.workflows[0] as never, step: 'd', outputField: 'verdict' });
    assert.ok(patch.rules.length > 0);
    const pp = join(tmp, 'patch.json'),
      cp = join(tmp, 'cases.json'),
      ap = join(tmp, 'acc.json'),
      rp = join(tmp, 'rev.json'),
      np = join(tmp, 'new.json');
    writeFileSync(pp, JSON.stringify(patch));
    writeFileSync(cp, JSON.stringify(cases));
    const pub = generateReviewerKeys();
    const other = generateReviewerKeys();
    const keyFile = join(tmp, 'pub.pem');
    writeFileSync(keyFile, pub.privateKeyPem);
    writeFileSync(join(tmp, 'other.pem'), other.privateKeyPem);
    const applyFlags = { patch: pp, cases: cp, acceptance: ap, reviewers: rp, out: np };
    const trust = (reviewers: object[]): void => writeFileSync(rp, JSON.stringify(reviewers));

    // no acceptance file at all: refused, nothing written
    trust([{ id: 'pat', roles: ['publisher'], publicKeyPem: pub.publicKeyPem }]);
    assert.equal((await flow(['promote', 'apply', wf], applyFlags)).code, 1);
    assert.throws(() => readFileSync(np));

    assert.equal((await flow(['promote', 'accept'], { patch: pp, key: keyFile, reviewer: 'pat', out: ap })).code, 0);
    // signed by someone other than the key on record
    await flow(['promote', 'accept'], { patch: pp, key: join(tmp, 'other.pem'), reviewer: 'pat', out: join(tmp, 'forged.json') });
    const forged = await flow(['promote', 'apply', wf], { ...applyFlags, acceptance: join(tmp, 'forged.json') });
    assert.equal(forged.code, 1);
    assert.match(forged.err, /does not verify/);
    // right signature, but the signer is not a publisher / is revoked
    trust([{ id: 'pat', roles: ['reviewer'], publicKeyPem: pub.publicKeyPem }]);
    assert.match((await flow(['promote', 'apply', wf], applyFlags)).err, /trusted, non-revoked publisher/);
    trust([{ id: 'pat', roles: ['publisher'], publicKeyPem: pub.publicKeyPem, revoked: true }]);
    assert.equal((await flow(['promote', 'apply', wf], applyFlags)).code, 1);
    // acceptance for a different patch
    const tampered = { ...patch, rules: patch.rules.slice(0, 1).map((r) => ({ ...r, outcome: 'approved' })) };
    writeFileSync(pp, JSON.stringify(tampered));
    trust([{ id: 'pat', roles: ['publisher'], publicKeyPem: pub.publicKeyPem }]);
    assert.equal((await flow(['promote', 'apply', wf], applyFlags)).code, 1);
    assert.throws(() => readFileSync(np));

    // the honest path
    writeFileSync(pp, JSON.stringify(patch));
    const ok = await flow(['promote', 'apply', wf], applyFlags);
    assert.equal(ok.code, 0, ok.err);
    const next = JSON.parse(readFileSync(np, 'utf8')) as typeof comp;
    assert.equal(next.workflows[0]?.version, '1.0.1');
    assert.match(ok.text, /not live/);
    assert.match(JSON.stringify(next), /learned_/);
  });
});
