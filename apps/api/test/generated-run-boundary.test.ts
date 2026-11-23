/**
 * ADR 0031 — the execution boundary of generated workflows: authorization at the moment of each effect (not only at
 * start), durable approval signing across restarts and rotations, one driver per run across API instances, safe connector
 * outcomes, bounded loops, one meaning per certificate, and the file-store transition.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExternalToolAdapter, ExternalToolResult } from '@xo/adapters';
import { AuditError, ErrorCode } from '@xo/errors';
import { NonProductionAuditSink, type AppendResult, type AuditEventDraft, type AuditSink } from '@xo/audit';
import { FsKnowledgeStore, KnowledgeBase, type ClaimRecord } from '@xo/knowledge-base';
import { PackageTrustPolicy } from '@xo/package-sdk';
import { LocalFsBlobStore } from '@xo/storage';
import { RunStore, signDecision } from '@xo/workflow-runtime';
import { FsWorkspaceStore } from '../src/workspace/fs-workspace-store.js';
import { fallbackWorkspaceManager } from '../src/workspace/authorizer.js';
import { runnerFor, type RunnerDeps } from '../src/routes/generated-run-routes.js';
import {
  approvalKeyring,
  currentPublicKeys,
  parseApprovalSigningKey,
  verifyJournaledDecision,
} from '../src/pre-execution/approval-keys.js';
import { workspaceDefinitionsStore, type WorkflowDefinitionRecord } from '../src/routes/pre-execution-routes.js';
import { TestServer, withTempDir } from './test-helpers.js';

const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
const PROCEDURE =
  '# Release procedure\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Pull the latest code from the main branch. | The working copy matches main. | Release engineer |\n| 2 | Run the full test suite. | All tests pass. | Release engineer |\n';
const OPENAPI = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Payments', version: '1' },
  paths: {
    '/payments': {
      post: {
        operationId: 'createPayment',
        requestBody: {
          content: {
            'application/json': { schema: { type: 'object', properties: { amount: { type: 'number' }, account: { type: 'string' } } } },
          },
        },
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object', properties: { paymentId: { type: 'string' } } } } },
          },
        },
      },
    },
  },
});
const BINDING = {
  capability: 'createPayment',
  connector: 'payments',
  kind: 'http',
  operation: 'create_payment',
  sideEffect: 'write',
  compensation: { operation: 'void_payment', sideEffect: 'write' },
  adapter: 'payments-adapter',
};

interface Run {
  runId: string;
  state: string;
  pendingApprovals: { approvalId: string; step: string; summary: string }[];
  decisions?: { step: string; signatureVerified: boolean; keyId?: string }[];
}

/** A payments adapter whose next answers the test chooses. */
function payments() {
  const calls: { capabilityId: string; dispatchKey: string }[] = [];
  let answer: () => Promise<ExternalToolResult> = async () =>
    ({ kind: 'confirmed_success', output: { paymentId: 'pay_1' } }) as ExternalToolResult;
  const adapter = {
    id: 'payments-adapter',
    approvalMode: 'capability',
    invoke: async (r: { capabilityId: string; dispatchKey: string }) => {
      calls.push(r);
      return answer();
    },
  } as unknown as ExternalToolAdapter;
  return { adapter, calls, answer: (f: () => Promise<ExternalToolResult>) => (answer = f) };
}

async function compile(server: TestServer, ws: string, filename: string, text: string): Promise<string> {
  const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=${filename}`, Buffer.from(text))).json<{
    sourceId: string;
  }>();
  return (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>()
    .compilationId;
}

async function approveAll(server: TestServer, ws: string, cid: string): Promise<void> {
  const inv = (await server.request('GET', `/workspaces/${ws}/compilations/${cid}/capability-inventory`)).json<{
    inventory: { capabilities: { capabilityId: string }[] };
  }>().inventory;
  for (const c of inv.capabilities)
    await server.request('POST', `/workspaces/${ws}/compilations/${cid}/capabilities/${encodeURIComponent(c.capabilityId)}/approve`);
}

async function generate(server: TestServer, ws: string, cid: string, goal: object) {
  const r = await server.request('POST', `/workspaces/${ws}/compilations/${cid}/generated-workflows`, { goal });
  return r.json<{ definition: { definitionId: string; candidateWorkflowId: string } }>().definition;
}

async function certify(server: TestServer, ws: string, definitionId: string) {
  return (await server.request('POST', `/workspaces/${ws}/generated-workflows/${definitionId}/readiness`, {})).json<{
    certificateId: string;
    status: string;
    gates: { id: string; outcome: string; findings: string[] }[];
  }>();
}

/** An audit sink that refuses the event types the test names (an audit outage for those events only). */
class FlakySink implements AuditSink {
  readonly mode = 'non-production' as const;
  readonly inner = new NonProductionAuditSink();
  failTypes = new Set<string>();
  async append(d: AuditEventDraft): Promise<AppendResult> {
    if (this.failTypes.has(d.type)) return { ok: false, error: new AuditError(ErrorCode.AUDIT_UNAVAILABLE, 'down'), indeterminate: false };
    return this.inner.append(d);
  }
}

async function env(
  prefix: string,
  fn: (e: {
    server: TestServer;
    dir: string;
    pay: ReturnType<typeof payments>;
    sink: FlakySink;
    restart: () => Promise<void>;
  }) => Promise<void>,
) {
  await withTempDir(prefix, async (dir) => {
    const pay = payments();
    const sink = new FlakySink();
    const options = {
      workspaceDataDir: join(dir, 'd'),
      workspacesDir: join(dir, 'w'),
      ...NO_OCR,
      connectorAdapters: new Map([['payments-adapter', pay.adapter]]),
      auditSink: sink,
    };
    const e = { server: await TestServer.start(options), dir, pay, sink, restart: async () => undefined };
    e.restart = async () => {
      await e.server.stop();
      e.server = await TestServer.start(options);
    };
    try {
      await fn(e);
    } finally {
      await e.server.stop();
    }
  });
}

function deps(dir: string, owner?: string, adapter?: ExternalToolAdapter): RunnerDeps {
  return {
    workspaceStore: new FsWorkspaceStore(new LocalFsBlobStore(join(dir, 'w'))),
    dataConfig: {
      dataRootDir: join(dir, 'd'),
      packageTrustPolicy: PackageTrustPolicy.development(),
      preExecution: {
        connectorAdapters: new Map(adapter !== undefined ? [['payments-adapter', adapter]] : []),
        certificatePolicy: 'workspace',
      },
    },
    permissionManager: fallbackWorkspaceManager(),
    env: {},
    ...(owner !== undefined ? { owner } : {}),
  };
}

test('effects are authorized when they happen: a pause, a lost role or a changed binding while a run waits stops the effect, and nothing is sent', async () => {
  await env('xo-irb-auth-', async (e) => {
    const ws = (await e.server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
    const memberKey = await (async () => {
      const r = await e.server.request('POST', `/workspaces/${ws}/members`, { identityId: 'author-b', role: 'publisher' });
      assert.ok(r.status === 200 || r.status === 201, r.bodyText);
      return (await e.server.issueAdditionalIdentity('author-b')).apiKey;
    })();
    void memberKey;
    const pcid = await compile(e.server, ws, 'release.md', PROCEDURE);
    const ocid = await compile(e.server, ws, 'payments.json', OPENAPI);
    assert.equal((await e.server.request('PUT', `/workspaces/${ws}/connector-bindings`, { bindings: [BINDING] })).status, 200);
    await approveAll(e.server, ws, pcid);
    await approveAll(e.server, ws, ocid);
    const proc = await generate(e.server, ws, pcid, { text: 'Ship a release', needs: ['Run the full test suite'] });
    const pay = await generate(e.server, ws, ocid, { text: 'create a payment' });

    // A definition whose payment waits for a person first: the window in which the world can change under a running workflow.
    const d = deps(e.dir, undefined, e.pay.adapter);
    const workspace = (await d.workspaceStore.get(ws)) as { ok: true; value: Parameters<typeof runnerFor>[1] };
    const defs = workspaceDefinitionsStore(workspace.value, d.dataConfig);
    const procDef = await defs.get(proc.definitionId);
    const payDef = await defs.get(pay.definitionId);
    const procWf = (procDef.lowered.component as { workflows: { steps: Record<string, unknown>[] }[] }).workflows[0]!;
    const payComponent = structuredClone(payDef.lowered.component) as {
      workflows: { steps: Record<string, unknown>[]; inputs: Record<string, unknown> }[];
    };
    const wf = payComponent.workflows[0]!;
    const approve = { ...structuredClone(procWf.steps[0]!), id: 'ok' };
    delete approve['needs'];
    delete approve['runIf'];
    if (approve['inputs'] !== undefined) approve['inputs'] = {};
    wf.steps = [approve, ...wf.steps.map((s) => (s['type'] === 'act' ? { ...s, needs: ['ok'] } : s))];
    const gated: WorkflowDefinitionRecord = { ...payDef, lowered: { ...payDef.lowered, component: payComponent as never } };

    const keys = await approvalKeyring(d.dataConfig.dataRootDir, {});
    const begin = async (runId: string, initiator: string) => {
      const meta = { initiator: { kind: 'human' as const, id: initiator }, certificateId: 'test', startedAt: new Date().toISOString() };
      const dir = join(d.dataConfig.dataRootDir, ws, 'generated-runs', gated.definitionId);
      await mkdir(join(dir, 'meta'), { recursive: true });
      await writeFile(join(dir, 'meta', `${runId}.json`), JSON.stringify(meta));
      const r = await (
        await runnerFor(d, workspace.value, gated, { starting: { runId, meta } })
      ).start({ inputs: { amount: 5, account: 'a' }, runId });
      assert.equal(r.state, 'waiting');
    };
    const approveNow = async (runId: string) => {
      const runner = await runnerFor(d, workspace.value, gated, { reviewer: { id: e.server.identityId } });
      const req = (await runner.listApprovals()).find((a) => a.runId === runId)!;
      const signed = signDecision(keys.active.privateKeyPem, {
        v: 1,
        approvalId: req.approvalId,
        runId,
        step: req.step,
        action: 'approve',
        edits: {},
        reviewerId: e.server.identityId,
        at: new Date().toISOString(),
      });
      return runner.decideApproval(runId, signed);
    };

    // 1. The workspace is paused while the run waits: the payment is not sent.
    await begin('run_pause', 'author-b');
    assert.equal((await e.server.request('POST', `/workspaces/${ws}/workflow-controls/pause`, { reason: 'audit' })).status, 200);
    assert.notEqual((await approveNow('run_pause')).state, 'completed');
    assert.equal(e.pay.calls.length, 0, 'paused: nothing sent');
    await e.server.request('POST', `/workspaces/${ws}/workflow-controls/resume`, {});

    // 2. The person who started it loses the right to run workflows.
    await begin('run_role', 'author-b');
    assert.equal((await e.server.request('PATCH', `/workspaces/${ws}/members/author-b`, { role: 'viewer' })).status, 200);
    assert.notEqual((await approveNow('run_role')).state, 'completed');
    assert.equal(e.pay.calls.length, 0, 'role lost: nothing sent');
    await e.server.request('PATCH', `/workspaces/${ws}/members/author-b`, { role: 'publisher' });

    // 3. The operator points the connector at another adapter.
    await begin('run_binding', 'author-b');
    await e.server.request('PUT', `/workspaces/${ws}/connector-bindings`, { bindings: [{ ...BINDING, adapter: 'other-adapter' }] });
    assert.notEqual((await approveNow('run_binding')).state, 'completed');
    assert.equal(e.pay.calls.length, 0, 'binding changed: nothing sent');
    await e.server.request('PUT', `/workspaces/${ws}/connector-bindings`, { bindings: [BINDING] });

    // 4. The person is removed from the workspace.
    await begin('run_removed', 'author-b');
    assert.equal((await e.server.request('DELETE', `/workspaces/${ws}/members/author-b`)).status < 300, true);
    assert.notEqual((await approveNow('run_removed')).state, 'completed');
    assert.equal(e.pay.calls.length, 0, 'removed: nothing sent');

    // 5. The capability's approval disappears while the run waits (W5 review: the runtime-path equivalent of the retired
    //    composed per-step authorization tests): the later call fails closed and nothing is sent.
    const approvals = join(d.dataConfig.dataRootDir, ws, 'approvals');
    await begin('run_unapproved', e.server.identityId);
    await rename(approvals, `${approvals}.aside`);
    assert.notEqual((await approveNow('run_unapproved')).state, 'completed');
    assert.equal(e.pay.calls.length, 0, 'approval withdrawn: nothing sent');
    await rename(`${approvals}.aside`, approvals);
    const unapproved = await new RunStore(join(d.dataConfig.dataRootDir, ws, 'generated-runs', gated.definitionId)).read('run_unapproved');
    assert.ok(
      unapproved.some((x) => x.type === 'attempt_failed' && JSON.stringify(x.data).includes('approv')),
      JSON.stringify(unapproved.filter((x) => ['call_outcome', 'attempt_failed'].includes(x.type)).map((x) => x.data)),
    );

    // Every refusal is journaled as a denied call that was never sent.
    const journal = await new RunStore(join(d.dataConfig.dataRootDir, ws, 'generated-runs', gated.definitionId)).read('run_role');
    assert.ok(
      journal.some((x) => x.type === 'call_outcome' && (x.data as { code?: string }).code === 'DENIED'),
      JSON.stringify(journal.filter((x) => ['call_outcome', 'attempt_failed'].includes(x.type)).map((x) => x.data)),
    );
    assert.ok(journal.some((x) => x.type === 'attempt_failed' && JSON.stringify(x.data).includes('may no longer run workflows')));

    // 6. Nothing changed: the same run shape pays once.
    await begin('run_ok', e.server.identityId);
    assert.equal((await approveNow('run_ok')).state, 'completed');
    assert.equal(e.pay.calls.length, 1);
  });
});

test('approval signing survives a restart and a rotation: a run waiting before the restart is decided after it, and every decision still verifies', async () => {
  await env('xo-irb-keys-', async (e) => {
    const ws = (await e.server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
    const cid = await compile(e.server, ws, 'release.md', PROCEDURE);
    await approveAll(e.server, ws, cid);
    const def = await generate(e.server, ws, cid, { text: 'Ship a release', needs: ['Run the full test suite'] });
    const cert = await certify(e.server, ws, def.definitionId);
    const runs = `/workspaces/${ws}/generated-workflows/${def.definitionId}/runs`;
    const run = (await e.server.request('POST', runs, { input: {}, certificateId: cert.certificateId })).json<Run>();
    assert.equal(run.state, 'waiting');

    await e.restart(); // a new process: the key must be the same one
    const a1 = run.pendingApprovals[0]!;
    const d1 = await e.server.request('POST', `${runs}/${run.runId}/approvals/${a1.approvalId}`, { action: 'approve' });
    assert.equal(d1.status, 200, d1.bodyText);
    const after = d1.json<Run>();
    assert.equal(after.decisions?.length, 1);
    assert.equal(after.decisions![0]!.signatureVerified, true);
    const firstKey = after.decisions![0]!.keyId!;

    // Rotation: a configured key replaces the generated one; the earlier decision still verifies from the keyring.
    const dataRoot = join(e.dir, 'd');
    const rotated = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    const ring = await approvalKeyring(dataRoot, { XO_APPROVAL_SIGNING_KEY: rotated });
    assert.notEqual(ring.active.keyId, firstKey);
    assert.equal(parseApprovalSigningKey(rotated).keyId, ring.active.keyId, 'the key id is a property of the key');
    const journal = await new RunStore(join(dataRoot, ws, 'generated-runs', def.definitionId)).read(run.runId);
    const decided = journal.find((x) => x.type === 'approval_decided')!.data as { payload: Record<string, unknown>; signature: string };
    const keys = await currentPublicKeys(dataRoot);
    assert.equal(keys.size, 2);
    assert.equal(verifyJournaledDecision(decided.payload, decided.signature, keys), firstKey);
    assert.equal(
      verifyJournaledDecision({ ...decided.payload, action: 'reject' }, decided.signature, keys),
      undefined,
      'an altered decision verifies under no key',
    );
    const keyFile = await stat(join(dataRoot, 'approval-keys', 'generated.key'));
    assert.equal(keyFile.mode & 0o077, 0, 'the generated key is owner-only');

    // Production never generates its own key, and a malformed configured key is refused without echoing it.
    await assert.rejects(approvalKeyring(join(e.dir, 'prod'), { NODE_ENV: 'production' }), /XO_APPROVAL_SIGNING_KEY is required/);
    assert.throws(
      () => parseApprovalSigningKey('bm90IGEga2V5'),
      (err: Error) => !err.message.includes('bm90IGEga2V5'),
    );
  });
});

test('two API instances drive one run: under the run lease exactly one decision lands and the journal stays whole', async () => {
  await env('xo-irb-lease-', async (e) => {
    const ws = (await e.server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
    const cid = await compile(e.server, ws, 'release.md', PROCEDURE);
    await approveAll(e.server, ws, cid);
    const def = await generate(e.server, ws, cid, { text: 'Ship a release', needs: ['Run the full test suite'] });
    const cert = await certify(e.server, ws, def.definitionId);
    const run = (
      await e.server.request('POST', `/workspaces/${ws}/generated-workflows/${def.definitionId}/runs`, {
        input: {},
        certificateId: cert.certificateId,
      })
    ).json<Run>();
    const a = deps(e.dir, 'instance-a');
    const b = deps(e.dir, 'instance-b');
    const workspace = (await a.workspaceStore.get(ws)) as { ok: true; value: Parameters<typeof runnerFor>[1] };
    const definition = await workspaceDefinitionsStore(workspace.value, a.dataConfig).get(def.definitionId);
    const keys = await approvalKeyring(a.dataConfig.dataRootDir, {});
    const runner = (d: RunnerDeps) => runnerFor(d, workspace.value, definition, { reviewer: { id: e.server.identityId } });
    const ra = await runner(a);
    const req = (await ra.listApprovals()).find((x) => x.runId === run.runId)!;
    const decision = (action: 'approve' | 'reject') =>
      signDecision(keys.active.privateKeyPem, {
        v: 1,
        approvalId: req.approvalId,
        runId: run.runId,
        step: req.step,
        action,
        edits: {},
        reviewerId: e.server.identityId,
        at: new Date().toISOString(),
      });
    // Both instances decide, and both keep ticking, at the same time; each operation on its own runner, as each request is.
    const results = await Promise.allSettled([
      ra.decideApproval(run.runId, decision('approve')),
      (await runner(b)).decideApproval(run.runId, decision('reject')),
      (await runner(a)).tick(),
      (await runner(b)).tick(),
      (await runner(a)).tick(),
      (await runner(b)).tick(),
    ]);
    const decided = results.slice(0, 2).filter((r) => r.status === 'fulfilled');
    assert.equal(decided.length, 1, results.map((r) => (r.status === 'rejected' ? String(r.reason) : 'ok')).join(' | '));
    for (const r of results.slice(0, 2))
      if (r.status === 'rejected')
        assert.match(String(r.reason), /HELD|already decided|leased to/, 'the loser is told the run is held or decided, nothing else');
    const journal = await new RunStore(join(a.dataConfig.dataRootDir, ws, 'generated-runs', def.definitionId)).read(run.runId);
    assert.equal(journal.filter((x) => x.type === 'approval_decided' && (x.data as { step: string }).step === req.step).length, 1);
    await ra.status(run.runId); // replays the hash chain: whole
  });
});

test('connector outcomes: an unknown outcome is never retried or undone blindly, a refusal with no effect is not retried, and the key is the same across a retry of the request', async () => {
  await env('xo-irb-conn-', async (e) => {
    const ws = (await e.server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
    const cid = await compile(e.server, ws, 'payments.json', OPENAPI);
    await e.server.request('PUT', `/workspaces/${ws}/connector-bindings`, { bindings: [BINDING] });
    await approveAll(e.server, ws, cid);
    const def = await generate(e.server, ws, cid, { text: 'create a payment' });
    const cert = await certify(e.server, ws, def.definitionId);
    assert.equal(cert.status, 'READY', JSON.stringify(cert.gates.filter((g) => g.outcome !== 'pass')));
    const runs = `/workspaces/${ws}/generated-workflows/${def.definitionId}/runs`;
    const start = (key?: string) =>
      e.server.request(
        'POST',
        runs,
        { input: { amount: 1, account: 'a' }, certificateId: cert.certificateId },
        key !== undefined ? { 'idempotency-key': key } : {},
      );

    e.pay.answer(async () => ({ kind: 'outcome_unknown', reason: 'connection reset after send' }) as ExternalToolResult);
    const unknown = (await start()).json<Run>();
    assert.ok(['escalated', 'failed'].includes(unknown.state), unknown.state);
    assert.equal(e.pay.calls.length, 1, 'sent once, not retried');
    assert.ok(!e.pay.calls.some((c) => c.capabilityId.endsWith('void_payment')), 'not undone on a guess');

    e.pay.answer(async () => ({ kind: 'confirmed_failure_no_effect', code: 'DECLINED', message: 'card declined' }) as ExternalToolResult);
    const declined = (await start()).json<Run>();
    assert.notEqual(declined.state, 'completed');
    assert.equal(e.pay.calls.length, 2, 'a definite refusal is not retried');

    e.pay.answer(async () => ({ kind: 'confirmed_success', output: { paymentId: 'pay_9' } }) as ExternalToolResult);
    const first = await start('pay-once-1');
    const again = await start('pay-once-1');
    assert.equal(first.json<Run>().runId, again.json<Run>().runId, 'a retried request is the same run');
    assert.equal(e.pay.calls.length, 3, 'and pays once');
  });
});

test('for_each is bounded against hostile input: too many items, too many bytes and the wrong shape are refused before anything runs', async () => {
  await env('xo-irb-loop-', async (e) => {
    const ws = (await e.server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
    const cid = await compile(e.server, ws, 'payments.json', OPENAPI);
    await e.server.request('PUT', `/workspaces/${ws}/connector-bindings`, { bindings: [BINDING] });
    await approveAll(e.server, ws, cid);
    const def = await generate(e.server, ws, cid, { text: 'create a payment', forEach: 'payment' });
    const cert = await certify(e.server, ws, def.definitionId);
    const runs = `/workspaces/${ws}/generated-workflows/${def.definitionId}/runs`;
    const start = (input: unknown) => e.server.request('POST', runs, { input, certificateId: cert.certificateId });
    const item = { amount: 1, account: 'a' };
    for (const bad of [
      { payment_items: Array.from({ length: 1001 }, () => item) },
      { payment_items: [{ ...item, account: 'x'.repeat(1_100_000) }] },
      { payment_items: 'not a list' },
      { payment_items: [1, 2, 3] },
      { payment_items: [item], extra: true },
    ]) {
      const r = await start(bad);
      assert.ok(r.status === 400 || r.status === 409, `${r.status} ${r.bodyText.slice(0, 200)}`);
    }
    assert.equal(e.pay.calls.length, 0, 'nothing ran');
  });
});

test('one certificate, one meaning: a definition that acts on other systems cannot be started through the composed-workflow runner', async () => {
  await env('xo-irb-path-', async (e) => {
    const ws = (await e.server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
    const cid = await compile(e.server, ws, 'payments.json', OPENAPI);
    await e.server.request('PUT', `/workspaces/${ws}/connector-bindings`, { bindings: [BINDING] });
    await approveAll(e.server, ws, cid);
    const def = await generate(e.server, ws, cid, { text: 'create a payment' });
    const cert = await certify(e.server, ws, def.definitionId);
    const legacy = await e.server.request('POST', `/workspaces/${ws}/workflows/${encodeURIComponent(def.candidateWorkflowId)}/executions`, {
      compilationId: cid,
      certificateId: cert.certificateId,
    });
    // ADR 0052: the composed route no longer exists for anyone, so a definition that acts on other systems cannot reach it either.
    assert.equal(legacy.status, 410, legacy.bodyText);
    assert.equal(legacy.json<{ error: { code: string } }>().error.code, 'XO_COMPOSED_RUNNER_REMOVED');
    assert.equal(e.pay.calls.length, 0);
  });
});

test('the file-store transition: knowledge kept in files is moved into SQL on first use, chain intact, and marked; it is never merged twice', async () => {
  await env('xo-irb-kbmig-', async (e) => {
    const ws = (await e.server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
    const root = join(e.dir, 'd', ws, 'knowledge');
    const kb = new KnowledgeBase(await FsKnowledgeStore.open(root, ws));
    const claim: ClaimRecord = {
      kind: 'claim',
      id: 'clm_000000000000000000000001',
      tenantId: ws,
      type: 'xo:heuristic',
      subject: { literal: 'refunds' },
      predicate: 'xo:heuristic',
      object: { value: 'need a receipt' },
      polarity: 'positive',
      authority: { level: 'source', basis: 'stated' },
      text: 'refunds need a receipt',
      evidence: [
        {
          sourceDigestSha256: 'a'.repeat(64),
          sourceName: 'p.md',
          locator: { section: ['S'] },
          method: { kind: 'source', name: 't', version: '1' },
        },
      ],
      derivation: 'source',
      confidence: 0.9,
      recordedAt: '2026-01-01T00:00:00.000Z',
    };
    const actor = { id: 'u1', kind: 'user' };
    const state = await kb.approve(
      (await kb.propose({ operations: [{ op: 'add', record: claim }], origin: { kind: 'manual' }, proposedBy: actor }))!.changeSetId,
      actor,
      'ok',
    );

    const head = await e.server.request('GET', `/workspaces/${ws}/knowledge/state`);
    assert.equal(head.status, 200, head.bodyText);
    assert.equal(head.json<{ stateId: string }>().stateId, state.stateId);
    const marker = JSON.parse(await readFile(join(root, ws, 'MIGRATED.json'), 'utf8')) as { migratedTo: string; states: number };
    assert.equal(marker.migratedTo, 'sqlite');
    assert.equal(marker.states, 1);
    assert.ok((await readdir(join(e.dir, 'd'))).includes('knowledge.sqlite'));
    await e.restart();
    assert.equal((await e.server.request('GET', `/workspaces/${ws}/knowledge/state`)).json<{ stateId: string }>().stateId, state.stateId);
  });
});

// W5 review (ADR 0052 decision 6): runtime-path equivalents of retired composed-runner tests (keyed start, audit outage, tenancy).
test('a start: a reused Idempotency-Key with another input is refused (422) and starts nothing; an audit outage before it refuses it (503) and sends nothing', async () => {
  await env('xo-irb-start-', async (e) => {
    const ws = (await e.server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
    const cid = await compile(e.server, ws, 'payments.json', OPENAPI);
    await e.server.request('PUT', `/workspaces/${ws}/connector-bindings`, { bindings: [BINDING] });
    await approveAll(e.server, ws, cid);
    const def = await generate(e.server, ws, cid, { text: 'create a payment' });
    const cert = await certify(e.server, ws, def.definitionId);
    assert.equal(cert.status, 'READY', JSON.stringify(cert.gates.filter((g) => g.outcome !== 'pass')));
    const runs = `/workspaces/${ws}/generated-workflows/${def.definitionId}/runs`;
    const start = (amount: number, key?: string) =>
      e.server.request(
        'POST',
        runs,
        { input: { amount, account: 'a' }, certificateId: cert.certificateId },
        key !== undefined ? { 'idempotency-key': key } : {},
      );

    const first = await start(1, 'key-1');
    assert.equal(first.status, 201, first.bodyText);
    const other = await start(2, 'key-1');
    assert.equal(other.status, 422, other.bodyText);
    assert.match(other.bodyText, /XO_IDEMPOTENCY_KEY_REUSED/);
    assert.equal(e.pay.calls.length, 1, 'the other input started nothing');
    assert.equal((await start(1, 'key-1')).json<Run>().runId, first.json<Run>().runId, 'the same input is still the same run');

    e.sink.failTypes.add('generated-workflow.run.requested');
    const down = await start(3, 'key-2');
    assert.equal(down.status, 503, down.bodyText);
    assert.equal(e.pay.calls.length, 1, 'nothing sent while the audit trail cannot record the start');
    const listed = (await e.server.request('GET', runs)).json<{ runs: { runId: string }[] }>().runs;
    assert.equal(listed.length, 1, JSON.stringify(listed));
    e.sink.failTypes.clear();
    assert.equal((await start(3, 'key-2')).status, 201, 'once the audit trail is back the same request starts');
    assert.equal(e.pay.calls.length, 2);
  });
});

test("cross-workspace: another workspace's member gets 404 for a generated workflow's runs, and cannot start it through their own workspace", async () => {
  await env('xo-irb-tenancy-', async (e) => {
    const ws = (await e.server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
    const cid = await compile(e.server, ws, 'payments.json', OPENAPI);
    await e.server.request('PUT', `/workspaces/${ws}/connector-bindings`, { bindings: [BINDING] });
    await approveAll(e.server, ws, cid);
    const def = await generate(e.server, ws, cid, { text: 'create a payment' });
    const cert = await certify(e.server, ws, def.definitionId);
    const runs = `/workspaces/${ws}/generated-workflows/${def.definitionId}/runs`;
    const run = (
      await e.server.request('POST', runs, { input: { amount: 1, account: 'a' }, certificateId: cert.certificateId })
    ).json<Run>();

    const outsider = TestServer.authHeader((await e.server.issueAdditionalIdentity('outsider')).apiKey);
    const own = (await e.server.request('POST', '/workspaces', {}, outsider)).json<{ workspaceId: string }>().workspaceId;
    for (const [method, path, body] of [
      ['GET', runs, undefined],
      ['GET', `${runs}/${run.runId}`, undefined],
      ['POST', runs, { input: { amount: 9, account: 'x' }, certificateId: cert.certificateId }],
      ['GET', `/workspaces/${own}/generated-workflows/${def.definitionId}/runs/${run.runId}`, undefined],
      [
        'POST',
        `/workspaces/${own}/generated-workflows/${def.definitionId}/runs`,
        { input: { amount: 9, account: 'x' }, certificateId: cert.certificateId },
      ],
    ] as const) {
      const r = await e.server.request(method, path, body, outsider);
      assert.equal(r.status, 404, `${method} ${path}: ${r.status} ${r.bodyText}`);
      assert.doesNotMatch(r.bodyText, new RegExp(run.runId));
    }
    assert.equal(e.pay.calls.length, 1, 'the outsider sent nothing');
  });
});
