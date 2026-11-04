import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ConnectorHost, MapVault, type Connector } from '@xo/connectors';
import { validateWorkflowComponent, type WorkflowComponent } from '@xo/workflow-ir';
import {
  RunStore,
  WorkflowRunner,
  buildAuditBundle,
  explainRun,
  generateReviewerKeys,
  merkleRoot,
  renderExplanation,
  verifyAuditBundle,
} from '../src/index.js';

const comp = (): WorkflowComponent => {
  const c = {
    formatVersion: '1.0',
    semanticsVersion: '1.0',
    connectors: [{ id: 'bank', kind: 'http', operations: [{ name: 'pay', sideEffect: 'write' }] }],
    workflows: [
      {
        id: 'wf',
        version: '1.0.0',
        triggers: [{ id: 't', kind: 'api' }],
        inputs: { claim: { type: 'string', required: true }, amount: { type: 'number', required: true } },
        steps: [
          {
            id: 'check',
            type: 'decide',
            determinism: 'deterministic',
            timeoutMs: 1000,
            provenance: ['policy §4.2: refunds up to 100 are automatic'],
            inputs: { amount: { from: 'input.amount' } },
            method: { kind: 'rules', rules: [{ id: 'small', when: 'amount <= 100', set: { verdict: 'pay' } }], onNoMatch: 'escalate' },
            outputs: { verdict: { type: 'enum', enum: ['pay'] } },
          },
          {
            id: 'pay',
            type: 'act',
            determinism: 'deterministic',
            needs: ['check'],
            timeoutMs: 1000,
            connector: 'bank',
            operation: 'pay',
            sideEffect: 'write',
            idempotencyKey: 'pay:{{input.claim}}',
            inputs: { amount: { from: 'input.amount' } },
          },
        ],
        result: { verdict: { from: 'steps.check.verdict' } },
        maxConcurrency: 1,
        runTimeoutMs: 60000,
        cancellation: { onCancel: 'abandon' },
        requiresFeatures: ['rules'],
      },
    ],
  } as unknown as WorkflowComponent;
  assert.deepEqual(
    validateWorkflowComponent(c).issues.filter((i) => i.severity === 'error'),
    [],
  );
  return c;
};

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'xo-audit-'));
  const c = comp();
  const conn: Connector = { kind: 'http', operations: { pay: { sideEffect: 'write', execute: async () => ({ ok: true }) } } };
  const store = new RunStore(dir);
  const runner = new WorkflowRunner({
    component: c,
    workflowId: 'wf',
    store,
    connectors: new ConnectorHost({
      component: c,
      policy: { connectors: { bank: { grant: ['pay'] } } },
      implementations: { bank: conn },
      vault: new MapVault({}),
    }),
  });
  const a = await runner.start({ inputs: { claim: 'c1', amount: 40 } });
  const b = await runner.start({ inputs: { claim: 'c2', amount: 900 } });
  return { dir, c, store, a, b };
}

describe('explain', () => {
  it('shows inputs, path, rules fired, provenance, call hashes and zero model calls for a deterministic run', async () => {
    const r = await run();
    const x = await explainRun(r.store, r.c.workflows[0]!, r.a.runId);
    assert.equal(x.modelCalls, 0);
    assert.equal(x.state, 'completed');
    assert.deepEqual(
      x.steps.map((s) => s.step),
      ['check', 'pay'],
    );
    assert.deepEqual(x.steps[0]?.rulesFired, ['small']);
    assert.deepEqual(x.steps[0]?.provenance, ['policy §4.2: refunds up to 100 are automatic']);
    assert.match(x.steps[1]?.call?.requestHash ?? '', /^[0-9a-f]{64}$/);
    assert.match(x.steps[1]?.call?.responseHash ?? '', /^[0-9a-f]{64}$/);
    assert.match(x.steps[1]?.call?.idempotencyKey ?? '', /^xo_/);
    const text = renderExplanation(x);
    assert.match(text, /model calls: 0  \(deterministic path\)/);
    assert.match(text, /rules fired: small/);
  });
  it('explains an escalation: the rule gap, no call made', async () => {
    const r = await run();
    const x = await explainRun(r.store, r.c.workflows[0]!, r.b.runId);
    assert.equal(x.state, 'escalated');
    assert.equal(
      x.steps.some((s) => s.call !== undefined),
      false,
    );
    assert.match(JSON.stringify(x.escalation), /DECIDE_NO_MATCH/);
  });
});

describe('audit export', () => {
  const keys = generateReviewerKeys();
  const build = async (r: Awaited<ReturnType<typeof run>>) =>
    buildAuditBundle({
      store: r.store,
      runIds: [r.a.runId, r.b.runId],
      workflow: { id: 'wf', version: '1.0.0' },
      componentBytes: new TextEncoder().encode(JSON.stringify(r.c)),
      connectorGrants: { bank: ['pay'] },
      manifest: { xo_id: 'x' },
      loadReceipt: { level: 'L3' },
      signer: 'auditor-1',
      privateKeyPem: keys.privateKeyPem,
    });
  it('produces a bundle that verifies with the signer public key alone', async () => {
    const r = await run();
    const b = await build(r);
    assert.deepEqual(verifyAuditBundle(b, keys.publicKeyPem), { ok: true, problems: [] });
    assert.equal(b.runs.length, 2);
  });
  it('detects an edited entry, a dropped entry, a swapped root, a forged signer key and edited grants', async () => {
    const r = await run();
    const b = await build(r);
    const edit = JSON.parse(JSON.stringify(b));
    edit.runs[0].entries[1].data.outputs = { verdict: 'x' };
    assert.equal(verifyAuditBundle(edit, keys.publicKeyPem).ok, false);
    const drop = JSON.parse(JSON.stringify(b));
    drop.runs[0].entries.splice(2, 1);
    assert.match(verifyAuditBundle(drop, keys.publicKeyPem).problems.join(' '), /chain breaks/);
    const root = { ...b, merkleRoot: 'f'.repeat(64) };
    assert.match(verifyAuditBundle(root, keys.publicKeyPem).problems.join(' '), /merkle root/);
    assert.equal(verifyAuditBundle(b, generateReviewerKeys().publicKeyPem).ok, false);
    assert.equal(verifyAuditBundle({ ...b, connectorGrants: { bank: ['pay', 'refund'] } }, keys.publicKeyPem).ok, false);
  });
  it('refuses to export a corrupt journal', async () => {
    const r = await run();
    await import('node:fs/promises').then((m) => m.appendFile(join(r.dir, r.a.runId, 'journal.jsonl'), '{"seq":2,"bad":true}\n'));
    await assert.rejects(build(r));
  });
  it('merkle root is order-sensitive and handles odd counts', () => {
    assert.notEqual(merkleRoot(['a', 'b', 'c']), merkleRoot(['c', 'b', 'a']));
    assert.equal(merkleRoot(['a']), 'a');
  });
});
