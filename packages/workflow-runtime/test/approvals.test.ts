import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ConnectorHost, MapVault, smtpConnector, type Connector } from '@xo/connectors';
import { validateWorkflowComponent, type WorkflowComponent } from '@xo/workflow-ir';
import type { ApprovalError } from '../src/index.js';
import {
  RunStore,
  StaticReviewerRegistry,
  WorkflowRunner,
  connectorApprovalSink,
  directoryApprovalSink,
  generateReviewerKeys,
  signDecision,
  type ApprovalRequest,
  type DecisionAction,
  type Reviewer,
} from '../src/index.js';

const keys = {
  ann: generateReviewerKeys(),
  bob: generateReviewerKeys(),
  aud: generateReviewerKeys(),
  eve: generateReviewerKeys(),
  rev: generateReviewerKeys(),
};
const reviewers: Reviewer[] = [
  { id: 'ann', roles: ['reviewer'], publicKeyPem: keys.ann.publicKeyPem },
  { id: 'bob', roles: ['installer'], publicKeyPem: keys.bob.publicKeyPem },
  { id: 'aud', roles: ['auditor'], publicKeyPem: keys.aud.publicKeyPem },
  { id: 'rev', roles: ['reviewer'], publicKeyPem: keys.rev.publicKeyPem, revoked: true },
];

const component = (): WorkflowComponent => {
  const c = {
    formatVersion: '1.0',
    semanticsVersion: '1.0',
    connectors: [{ id: 'bank', kind: 'http', operations: [{ name: 'pay', sideEffect: 'write' }] }],
    workflows: [
      {
        id: 'wf',
        version: '1.0.0',
        triggers: [{ id: 't', kind: 'api' }],
        inputs: { amount: { type: 'number', required: true }, claim: { type: 'string', required: true } },
        steps: [
          {
            id: 'check',
            type: 'decide',
            determinism: 'deterministic',
            timeoutMs: 1000,
            inputs: { amount: { from: 'input.amount' } },
            method: { kind: 'rules', rules: [{ id: 'big', when: 'amount > 0', set: { tier: 'review' } }], onNoMatch: 'escalate' },
            outputs: { tier: { type: 'string' } },
          },
          {
            id: 'gate',
            type: 'approve',
            determinism: 'human',
            needs: ['check'],
            timeoutMs: 60_000,
            roles: ['reviewer', 'auditor'],
            allowEdit: true,
            onTimeout: 'escalate',
            onError: 'escalate',
            summary: 'Pay claim {{input.claim}} for {{input.amount}}?',
            evidence: ['amount'],
            inputs: { amount: { from: 'input.amount' }, tier: { from: 'steps.check.tier' } },
            outputs: { decision: { type: 'enum', enum: ['approved', 'rejected'] }, approved_amount: { type: 'number', nullable: true } },
          },
          {
            id: 'pay',
            type: 'act',
            determinism: 'deterministic',
            needs: ['gate'],
            timeoutMs: 1000,
            runIf: "decision == 'approved'",
            connector: 'bank',
            operation: 'pay',
            sideEffect: 'write',
            idempotencyKey: 'pay:{{input.claim}}',
            inputs: {
              decision: { from: 'steps.gate.decision' },
              amount: { from: 'input.amount' },
              approved_amount: { from: 'steps.gate.approved_amount' },
            },
          },
        ],
        result: { decision: { from: 'steps.gate.decision' } },
        maxConcurrency: 2,
        runTimeoutMs: 600_000,
        cancellation: { onCancel: 'abandon' },
        requiresFeatures: ['approve', 'rules'],
      },
    ],
  } as unknown as WorkflowComponent;
  assert.deepEqual(
    validateWorkflowComponent(c).issues.filter((i) => i.severity === 'error'),
    [],
  );
  return c;
};

async function setup(opts: { now?: () => number } = {}) {
  const effects: unknown[] = [];
  const conn: Connector = {
    kind: 'http',
    operations: { pay: { sideEffect: 'write', execute: async (a) => (effects.push(a), { ok: true }) } },
  };
  const dir = await mkdtemp(join(tmpdir(), 'xo-appr-'));
  const c = component();
  const sunk: ApprovalRequest[] = [];
  const mk = () =>
    new WorkflowRunner({
      component: c,
      workflowId: 'wf',
      store: new RunStore(join(dir, 'runs')),
      connectors: new ConnectorHost({
        component: c,
        policy: { connectors: { bank: { grant: ['pay'] } } },
        implementations: { bank: conn },
        vault: new MapVault({}),
      }),
      approvals: { reviewers: new StaticReviewerRegistry(reviewers), sink: (r) => void sunk.push(r) },
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
  return { dir, effects, sunk, mk };
}

const decision = (req: ApprovalRequest, who: keyof typeof keys, action: DecisionAction, extra: Record<string, unknown> = {}) =>
  signDecision(keys[who].privateKeyPem, {
    v: 1,
    approvalId: req.approvalId,
    runId: req.runId,
    step: req.step,
    action,
    edits: {},
    reviewerId: who,
    at: new Date().toISOString(),
    ...extra,
  } as any);
const refusal = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'ACCEPTED',
    (e: ApprovalError) => e.code ?? e.message,
  );

describe('approval request', () => {
  it('parks the run, creates a request with case, evidence, trace and proposed action, and delivers it; nothing executes', async () => {
    const s = await setup();
    const r = await s.mk().start({ inputs: { amount: 120, claim: 'c1' } });
    assert.equal(r.state, 'waiting');
    assert.equal(s.effects.length, 0);
    const req = s.sunk[0]!;
    assert.match(req.approvalId, /^appr_[0-9a-f]{64}$/);
    assert.equal(req.summary, 'Pay claim c1 for 120?');
    assert.deepEqual(req.evidence, { amount: 120 });
    assert.deepEqual(req.trace, [{ step: 'check', rulesFired: ['big'] }]);
    assert.deepEqual(req.proposedActions, ['bank.pay (write) in step pay']);
    assert.equal((await s.mk().listApprovals()).length, 1);
  });
  it('the directory sink writes the request for a frontend to pick up', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xo-sink-'));
    const s = await setup();
    await s.mk().start({ inputs: { amount: 1, claim: 'c' } });
    await directoryApprovalSink(dir)(s.sunk[0]!);
    assert.equal(JSON.parse(await readFile(join(dir, `${s.sunk[0]!.approvalId}.json`), 'utf8')).step, 'gate');
  });
});

describe('decisions', () => {
  it('approve completes the run and the side effect happens once; the signed decision is in the journal', async () => {
    const s = await setup();
    const runner = s.mk();
    const a = await runner.start({ inputs: { amount: 50, claim: 'c2' } });
    const res = await s.mk().decideApproval(a.runId, decision(s.sunk[0]!, 'ann', 'approve'));
    assert.equal(res.state, 'completed');
    assert.deepEqual(res.outputs, { decision: 'approved' });
    assert.equal(s.effects.length, 1);
    const j = await new RunStore(join(s.dir, 'runs')).read(a.runId);
    const d = j.find((e) => e.type === 'approval_decided')!;
    assert.equal(d.data['reviewerId'], 'ann');
    assert.ok(typeof d.data['signature'] === 'string');
  });
  it('reject completes the run with decision rejected and executes nothing', async () => {
    const s = await setup();
    const a = await s.mk().start({ inputs: { amount: 50, claim: 'c3' } });
    const res = await s.mk().decideApproval(a.runId, decision(s.sunk[0]!, 'ann', 'reject'));
    assert.deepEqual(res.outputs, { decision: 'rejected' });
    assert.equal(s.effects.length, 0);
  });
  it('edit_and_approve passes the reviewer-supplied value downstream', async () => {
    const s = await setup();
    const a = await s.mk().start({ inputs: { amount: 50, claim: 'c4' } });
    await s.mk().decideApproval(a.runId, decision(s.sunk[0]!, 'ann', 'edit_and_approve', { edits: { approved_amount: 30 } }));
    assert.equal((s.effects[0] as any).approved_amount, 30);
  });
});

describe('adversarial', () => {
  it('refuses forged, tampered, replayed, misbound, unauthorised and revoked decisions', async () => {
    const s = await setup();
    const a = await s.mk().start({ inputs: { amount: 50, claim: 'c5' } });
    const req = s.sunk[0]!;
    const runner = s.mk();
    const good = decision(req, 'ann', 'reject');
    // tampering: flip the action after signing
    assert.equal(
      await refusal(runner.decideApproval(a.runId, { ...good, payload: { ...good.payload, action: 'approve' } })),
      'BAD_SIGNATURE',
    );
    // signed by someone else's key but claiming to be ann
    assert.equal(await refusal(runner.decideApproval(a.runId, signDecision(keys.eve.privateKeyPem, good.payload))), 'BAD_SIGNATURE');
    // unknown reviewer, revoked reviewer
    assert.equal(await refusal(runner.decideApproval(a.runId, decision(req, 'eve', 'approve'))), 'UNKNOWN_REVIEWER');
    assert.equal(await refusal(runner.decideApproval(a.runId, decision(req, 'rev', 'approve'))), 'REVOKED_REVIEWER');
    // roles: installer is not permitted on this step; auditors can never decide even though the step lists the role
    assert.equal(await refusal(runner.decideApproval(a.runId, decision(req, 'bob', 'approve'))), 'ROLE_NOT_PERMITTED');
    assert.equal(await refusal(runner.decideApproval(a.runId, decision(req, 'aud', 'approve'))), 'ROLE_NOT_PERMITTED');
    // edits where they are not allowed, and to non-editable fields
    assert.equal(
      await refusal(runner.decideApproval(a.runId, decision(req, 'ann', 'approve', { edits: { approved_amount: 1 } }))),
      'EDIT_NOT_ALLOWED',
    );
    assert.equal(
      await refusal(runner.decideApproval(a.runId, decision(req, 'ann', 'edit_and_approve', { edits: { decision: 'approved' } }))),
      'BAD_EDIT',
    );
    assert.equal(
      await refusal(runner.decideApproval(a.runId, decision(req, 'ann', 'edit_and_approve', { edits: { approved_amount: 'lots' } }))),
      'BAD_EDIT',
    );
    assert.equal(s.effects.length, 0, 'no refused decision moved the run');
    assert.equal((await runner.status(a.runId)).state, 'waiting');
    // the genuine decision works exactly once; replaying it is refused
    assert.equal((await s.mk().decideApproval(a.runId, good)).state, 'completed');
    assert.equal(await refusal(s.mk().decideApproval(a.runId, good)), 'ALREADY_DECIDED');
  });
  it('a decision signed for one run cannot satisfy another (cross-run replay)', async () => {
    const s = await setup();
    const a = await s.mk().start({ inputs: { amount: 50, claim: 'c6' } });
    const b = await s.mk().start({ inputs: { amount: 50, claim: 'c7' } });
    const reqA = s.sunk[0]!;
    const forA = decision(reqA, 'ann', 'approve');
    assert.equal(await refusal(s.mk().decideApproval(b.runId, forA)), 'UNKNOWN_APPROVAL');
    assert.equal((await s.mk().status(b.runId)).state, 'waiting');
    void a;
  });
  it('an expired request escalates on tick and a late decision is refused; it is never approved by default', async () => {
    let t = 1_000_000;
    const s = await setup({ now: () => t });
    const a = await s.mk().start({ inputs: { amount: 50, claim: 'c8' } });
    const req = s.sunk[0]!;
    t += 61_000;
    const [r] = await s.mk().tick();
    assert.equal(r?.state, 'escalated');
    assert.equal(r?.escalation?.code, 'APPROVAL_TIMEOUT');
    assert.equal(s.effects.length, 0);
    assert.ok(
      ['UNKNOWN_APPROVAL', 'ALREADY_DECIDED', 'EXPIRED'].includes(
        await refusal(s.mk().decideApproval(a.runId, decision(req, 'ann', 'approve'))),
      ),
    );
    assert.equal(s.effects.length, 0);
  });
  it('a runner without an approvals configuration refuses workflows that need approval', async () => {
    const c = component();
    assert.throws(
      () =>
        new WorkflowRunner({
          component: c,
          workflowId: 'wf',
          store: new RunStore('/tmp/x'),
          connectors: new ConnectorHost({ component: c, policy: { connectors: {} }, implementations: {}, vault: new MapVault({}) }),
        }),
      /approve/,
    );
  });
});

describe('delivery through a connector (SMTP)', () => {
  it('sends the approval request by email through grants and recipient allowlists, and a delivery failure surfaces instead of being swallowed', async () => {
    const sent: { to: readonly string[]; subject: string; body: string; messageId: string }[] = [];
    const comp = { connectors: [{ id: 'mail', kind: 'smtp' as const, operations: [{ name: 'send', sideEffect: 'write' as const }] }] };
    const mk = (domains: string[]) =>
      new ConnectorHost({
        component: comp,
        policy: { connectors: { mail: { grant: ['send'] } } },
        implementations: {
          mail: smtpConnector(
            { host: 'x', port: 1, security: 'tls', from: 'desk@corp.example', allowedRecipientDomains: domains, maxBodyBytes: 20_000 },
            { send: async (m) => void sent.push(m) },
          ),
        },
        vault: new MapVault({}),
      });
    const s = await setup();
    s.mk();
    const r = await s.mk().start({ inputs: { amount: 120, claim: 'c1' } });
    const req = s.sunk[0]!;
    await connectorApprovalSink({ host: mk(['corp.example']), connector: 'mail', operation: 'send', to: ['reviewer@corp.example'] })(req);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.body, new RegExp(req.approvalId));
    assert.equal(sent[0]!.messageId, req.approvalId);
    await assert.rejects(
      connectorApprovalSink({ host: mk(['other.example']), connector: 'mail', operation: 'send', to: ['reviewer@corp.example'] })(req),
      (e: Error & { code?: string }) => e.code === 'DENIED',
    );
    void r;
  });
});
