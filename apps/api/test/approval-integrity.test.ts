import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Permissions, RuleBasedPolicy, type PolicyRule } from '@xo/permissions';
import { NonProductionAuditSink, type AuditEvent } from '@xo/audit';
import { TestServer, withTempDir } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, buildFixtureGraph, storeFixtureCompilation } from './workflow-fixtures.js';
import { FsExecutionStore } from '../src/executions/fs-execution-store.js';
import { workspaceExecutionsStore } from '../src/workspace/workspace-context.js';
import { deriveCapabilityApprovalState } from '../src/approvals/approval-binding.js';
import { evaluateApproval, parseApprovalRecord, type ApprovalRecord, type CurrentApprovalState } from '../src/approvals/approval.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

// P1.0 M3 — Approval Integrity: an approval is attributed, bound to the capability's material state, enforced at the boundary
// (not in the UI), and does not survive a material change.

interface ErrorWire {
  readonly error: { readonly code: string; readonly message: string };
}
interface ApprovalWire extends ApprovalRecord {
  readonly auditFinalization?: unknown;
}
interface CapabilityWire {
  readonly capabilityId: string;
  readonly approved: boolean;
  readonly approvalStatus: string;
}

const FILE = Permissions.filesystem.read;
const GRANT_FILE: PolicyRule = { id: 'grant-file', effect: 'ALLOW', match: { permission: FILE, principalId: 'test-identity' } };
const RULE_A = 'decision_p08_flow_a';
const RULE_B = 'decision_p08_flow_b';
const SRC_DIGEST = 'p08-fixture-digest';

interface Env {
  readonly server: TestServer;
  readonly sink: NonProductionAuditSink;
  readonly dataDir: string;
  readonly workspace: WorkspaceRecord;
  readonly compilationId: string;
}

async function withEnv(fn: (env: Env) => Promise<void>, policy: RuleBasedPolicy = new RuleBasedPolicy([GRANT_FILE])): Promise<void> {
  await withTempDir('xo-m3-data-', async (dataDir) => {
    await withTempDir('xo-m3-ws-', async (workspacesDir) => {
      const sink = new NonProductionAuditSink();
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir, auditSink: sink, permissionPolicy: policy });
      try {
        const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        const { compilationId } = await storeFixtureCompilation(workspace, dataDir);
        await fn({ server, sink, dataDir, workspace, compilationId });
      } finally {
        await server.stop();
      }
    });
  });
}

const ws = (env: Env, suffix: string): string => `/workspaces/${env.workspace.workspaceId}${suffix}`;
const approvePath = (env: Env, cap: string, cmp = env.compilationId): string => ws(env, `/compilations/${cmp}/capabilities/${cap}/approve`);
const approve = (env: Env, cap: string, body?: unknown) => env.server.request('POST', approvePath(env, cap), body);
async function approveOk(env: Env, cap: string): Promise<ApprovalWire> {
  const res = await approve(env, cap);
  assert.equal(res.status, 200, res.bodyText);
  return res.json<ApprovalWire>();
}
const execute = (env: Env, capabilityId: string, input: Record<string, unknown>) =>
  env.server.request('POST', ws(env, '/executions'), { compilationId: env.compilationId, capabilityId, input });

const resultPath = (env: Env): string => join(env.dataDir, env.workspace.workspaceId, 'compilations', env.compilationId, 'result.json');
const approvalFile = (env: Env, cap: string): string =>
  join(env.dataDir, env.workspace.workspaceId, 'approvals', encodeURIComponent(env.compilationId), `${encodeURIComponent(cap)}.json`);

/** Edits ONE node's properties inside the PERSISTED compiled graph (what a post-approval change to the stored compilation looks like). */
async function tamperNode(env: Env, nodeId: string, edit: (props: Record<string, unknown>) => void): Promise<void> {
  const stored = JSON.parse(await readFile(resultPath(env), 'utf8')) as { graph: { nodes: { id: string; properties: Record<string, unknown> }[] } };
  const node = stored.graph.nodes.find((n) => n.id === nodeId);
  assert.ok(node, `node ${nodeId} not found in stored graph`);
  edit(node.properties);
  await writeFile(resultPath(env), JSON.stringify(stored));
}

async function storedExecutions(env: Env) {
  const store = new FsExecutionStore(workspaceExecutionsStore(env.workspace, { dataRootDir: env.dataDir }));
  const listed = await store.list();
  assert.ok(listed.ok);
  return listed.value;
}
const events = (env: Env, type: string): AuditEvent[] => env.sink.events().filter((e) => e.type === type);

async function capabilityView(env: Env, cap: string): Promise<CapabilityWire> {
  const res = await env.server.request('GET', ws(env, `/compilations/${env.compilationId}/capabilities`));
  assert.equal(res.status, 200, res.bodyText);
  const found = res.json<{ capabilities: CapabilityWire[] }>().capabilities.find((c) => c.capabilityId === cap);
  assert.ok(found);
  return found;
}

// ── attribution ────────────────────────────────────────────────────────

test('approval is attributed to the AUTHENTICATED principal and bound to the derived capability state', async () => {
  await withEnv(async (env) => {
    const rec = await approveOk(env, IDS.flowA);
    assert.equal(rec.schemaVersion, 2);
    assert.deepEqual({ ...rec.approver }, { kind: 'service', id: 'test-identity' });
    assert.equal(rec.identityId, 'test-identity');
    assert.equal(rec.approverIdentityId, 'test-identity');
    assert.equal(rec.workspaceId, env.workspace.workspaceId);
    assert.equal(rec.compilationId, env.compilationId);
    assert.equal(rec.capabilityId, IDS.flowA);
    assert.equal(rec.binding.sourceDigestSha256, SRC_DIGEST);
    assert.equal(rec.binding.implementationClass, 'deterministic_rule');
    assert.match(rec.binding.stateDigest, /[0-9a-f]{16}/);
    const onDisk = parseApprovalRecord(JSON.parse(await readFile(approvalFile(env, IDS.flowA), 'utf8')));
    assert.equal(onDisk.kind, 'bound');
  });
});

test('no request field can supply the approver, the binding or the target state', async () => {
  await withEnv(async (env) => {
    const forged = {
      approver: { kind: 'human', id: 'ceo' },
      identityId: 'ceo',
      approverIdentityId: 'ceo',
      binding: { stateDigest: 'sha256:forged', contractId: 'x', contractContentHash: 'x', declarationFingerprint: 'x' },
      status: 'approved',
    };
    const rec = (await approve(env, IDS.flowA, forged)).json<ApprovalWire>();
    assert.equal(rec.approver.id, 'test-identity');
    assert.equal(rec.identityId, 'test-identity');
    assert.notEqual(rec.binding.stateDigest, 'sha256:forged');
    await tamperNode(env, RULE_A, (p) => {
      p['outcome'] = 'something else';
    });
    assert.equal((await execute(env, IDS.flowA, { claim_amount: 20000 })).status, 403);
  });
});

test('an unauthenticated caller cannot approve, and the denial leaves no approval', async () => {
  await withEnv(async (env) => {
    const res = await env.server.request('POST', approvePath(env, IDS.flowA), undefined, {}, { skipAuth: true });
    assert.equal(res.status, 401);
    assert.equal((await capabilityView(env, IDS.flowA)).approved, false);
  });
});

test("another workspace owner cannot approve (or revalidate) this workspace's capability", async () => {
  await withEnv(async (env) => {
    const other = await env.server.issueAdditionalIdentity('someone-else');
    const res = await env.server.request('POST', approvePath(env, IDS.flowA), undefined, TestServer.authHeader(other.apiKey));
    assert.equal(res.status, 404);
    assert.equal((await capabilityView(env, IDS.flowA)).approved, false);
  });
});

// ── target binding ─────────────────────────────────────────────────────

test('an approval for one capability does not authorize another', async () => {
  await withEnv(async (env) => {
    await approveOk(env, IDS.flowA);
    const res = await execute(env, IDS.flowB, { matched: true, payout_amount: 800 });
    assert.equal(res.status, 403, res.bodyText);
    assert.equal(res.json<ErrorWire>().error.code, 'XO_RUNTIME_PERMISSION_DENIED');
  });
});

test('an approval file copied to another capability (or compilation/workspace) is a target mismatch, not an approval', async () => {
  await withEnv(async (env) => {
    await approveOk(env, IDS.flowA);
    const genuine = JSON.parse(await readFile(approvalFile(env, IDS.flowA), 'utf8')) as Record<string, unknown>;
    const cases: readonly [string, Record<string, unknown>, string][] = [
      ['record names the other capability', { ...genuine }, 'target_mismatch'],
      ['record names another compilation', { ...genuine, compilationId: 'cmp_00000000000000000000000000000000', capabilityId: IDS.flowB }, 'target_mismatch'],
      ['record names another workspace', { ...genuine, workspaceId: 'ws_other', capabilityId: IDS.flowB }, 'target_mismatch'],
      ["ids rewritten to flowB, binding is flowA's", { ...genuine, capabilityId: IDS.flowB }, 'stale'],
    ];
    for (const [label, forged, expected] of cases) {
      await writeFile(approvalFile(env, IDS.flowB), JSON.stringify(forged));
      const res = await execute(env, IDS.flowB, { matched: true, payout_amount: 800 });
      assert.equal(res.status, 403, `${label}: ${res.bodyText}`);
      assert.equal((await capabilityView(env, IDS.flowB)).approvalStatus, expected, label);
    }
    assert.equal((await storedExecutions(env)).length, 0);
  });
});

// ── material change invalidates ────────────────────────────────────────

test('baseline: an approved, unchanged capability executes', async () => {
  await withEnv(async (env) => {
    await approveOk(env, IDS.flowA);
    const res = await execute(env, IDS.flowA, { claim_amount: 20000 });
    assert.ok(res.status === 200 || res.status === 201, res.bodyText);
    assert.equal((await capabilityView(env, IDS.flowA)).approvalStatus, 'approved');
  });
});

test('a materially changed RULE makes the approval stale: refused at the boundary, no execution record, audited with a precise reason', async () => {
  await withEnv(async (env) => {
    await approveOk(env, IDS.flowA);
    await tamperNode(env, RULE_A, (p) => {
      p['question'] = 'the claim amount exceeds 1';
    });
    const res = await execute(env, IDS.flowA, { claim_amount: 20000 });
    assert.equal(res.status, 403, res.bodyText);
    assert.equal(res.json<ErrorWire>().error.code, 'XO_RUNTIME_PERMISSION_DENIED');
    assert.match(res.json<ErrorWire>().error.message, /changed since it was approved/);
    assert.equal((await storedExecutions(env)).length, 0, 'no record or side effect for a stale approval');
    const denied = events(env, 'execution.denied');
    assert.equal(denied.at(-1)?.reasonCode, 'APPROVAL_STALE');
    assert.equal(denied.at(-1)?.actor.id, 'test-identity');
    assert.equal(events(env, 'execution.started').length, 0);
    const view = await capabilityView(env, IDS.flowA);
    assert.deepEqual({ approved: view.approved, status: view.approvalStatus }, { approved: false, status: 'stale' });
  });
});

test('a changed rule OUTCOME is also material', async () => {
  await withEnv(async (env) => {
    await approveOk(env, IDS.flowA);
    await tamperNode(env, RULE_A, (p) => {
      p['outcome'] = 'auto-approve everything';
    });
    assert.equal((await execute(env, IDS.flowA, { claim_amount: 20000 })).status, 403);
  });
});

test('a changed permission DECLARATION (loosened or tightened) makes the approval stale', async () => {
  for (const edit of [
    (p: Record<string, unknown>) => {
      p['requiredPermissions'] = [];
    },
    (p: Record<string, unknown>) => {
      p['requiredPermissions'] = [FILE, Permissions.network.http];
    },
    (p: Record<string, unknown>) => {
      delete p['requiredPermissions'];
    },
  ]) {
    await withEnv(async (env) => {
      await approveOk(env, IDS.perm);
      const before = await execute(env, IDS.perm, { file_size: 50 });
      assert.ok(before.status === 200 || before.status === 201, before.bodyText);
      await tamperNode(env, IDS.perm, edit);
      const after = await execute(env, IDS.perm, { file_size: 50 });
      assert.equal(after.status, 403, after.bodyText);
      assert.equal(events(env, 'execution.denied').at(-1)?.reasonCode, 'APPROVAL_STALE');
    });
  }
});

test('a change to a DIFFERENT capability does not invalidate this approval', async () => {
  await withEnv(async (env) => {
    await approveOk(env, IDS.flowA);
    await tamperNode(env, RULE_B, (p) => {
      p['question'] = 'the payout amount exceeds 1';
    });
    const res = await execute(env, IDS.flowA, { claim_amount: 20000 });
    assert.ok(res.status === 200 || res.status === 201, res.bodyText);
  });
});

test('a changed compilation source digest makes the approval stale', async () => {
  await withEnv(async (env) => {
    await approveOk(env, IDS.flowA);
    const metaPath = join(env.dataDir, env.workspace.workspaceId, 'compilations', env.compilationId, 'metadata.json');
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>;
    meta['sourceDigestSha256'] = 'a-different-source';
    await writeFile(metaPath, JSON.stringify(meta));
    assert.equal((await execute(env, IDS.flowA, { claim_amount: 20000 })).status, 403);
    assert.equal((await capabilityView(env, IDS.flowA)).approvalStatus, 'stale');
  });
});

test('re-approving the CHANGED state restores execution and replaces the binding (old approval is not resurrected by reverting)', async () => {
  await withEnv(async (env) => {
    const first = await approveOk(env, IDS.flowA);
    await tamperNode(env, RULE_A, (p) => {
      p['outcome'] = 'new outcome';
    });
    assert.equal((await execute(env, IDS.flowA, { claim_amount: 20000 })).status, 403);
    const second = await approveOk(env, IDS.flowA);
    assert.notEqual(second.binding.stateDigest, first.binding.stateDigest);
    const res = await execute(env, IDS.flowA, { claim_amount: 20000 });
    assert.ok(res.status === 200 || res.status === 201, res.bodyText);
    await tamperNode(env, RULE_A, (p) => {
      p['outcome'] = 'flag for payout';
    });
    assert.equal((await execute(env, IDS.flowA, { claim_amount: 20000 })).status, 403);
  });
});

// ── invalid / missing / legacy approvals fail closed ───────────────────

test('a pre-M3 (unbound) approval is refused with a precise reason and must be re-approved', async () => {
  await withEnv(async (env) => {
    await mkdir(join(env.dataDir, env.workspace.workspaceId, 'approvals', encodeURIComponent(env.compilationId)), { recursive: true });
    await writeFile(
      approvalFile(env, IDS.flowA),
      JSON.stringify({
        compilationId: env.compilationId,
        capabilityId: IDS.flowA,
        workspaceId: env.workspace.workspaceId,
        identityId: 'test-identity',
        status: 'approved',
        approvedAt: '2026-01-01T00:00:00.000Z',
        approverIdentityId: 'test-identity',
      }),
    );
    const res = await execute(env, IDS.flowA, { claim_amount: 20000 });
    assert.equal(res.status, 403, res.bodyText);
    assert.equal(events(env, 'execution.denied').at(-1)?.reasonCode, 'APPROVAL_LEGACY_UNBOUND');
    assert.equal((await capabilityView(env, IDS.flowA)).approvalStatus, 'legacy_unbound');
    await approveOk(env, IDS.flowA);
    const again = await execute(env, IDS.flowA, { claim_amount: 20000 });
    assert.ok(again.status === 200 || again.status === 201, again.bodyText);
  });
});

test('malformed, unattributed, unknown-version and unparseable approval files are never approvals', async () => {
  await withEnv(async (env) => {
    const good = await approveOk(env, IDS.flowA);
    const base = JSON.parse(JSON.stringify(good)) as Record<string, any>;
    const variants: readonly [string, string, string][] = [
      ['not json', '{not json', 'malformed'],
      ['unknown schema version', JSON.stringify({ ...base, schemaVersion: 3 }), 'malformed'],
      ['unknown extra field (authority-like)', JSON.stringify({ ...base, roles: ['admin'] }), 'malformed'],
      ['status not approved', JSON.stringify({ ...base, status: 'pending' }), 'malformed'],
      ['invalid approver principal', JSON.stringify({ ...base, approver: { kind: 'robot', id: 'x' } }), 'malformed'],
      ['approver with authority-like extras', JSON.stringify({ ...base, approver: { ...base['approver'], admin: true } }), 'malformed'],
      ['missing binding field', JSON.stringify({ ...base, binding: { ...base['binding'], stateDigest: undefined } }), 'malformed'],
      ['approver id disagrees with identityId', JSON.stringify({ ...base, identityId: 'someone-else' }), 'attribution_invalid'],
      ['approver id disagrees with approverIdentityId', JSON.stringify({ ...base, approverIdentityId: 'someone-else' }), 'attribution_invalid'],
    ];
    for (const [label, content, status] of variants) {
      await writeFile(approvalFile(env, IDS.flowA), content);
      const res = await execute(env, IDS.flowA, { claim_amount: 20000 });
      assert.equal(res.status, 403, `${label}: ${res.bodyText}`);
      assert.equal((await capabilityView(env, IDS.flowA)).approvalStatus, status, label);
    }
    assert.equal((await storedExecutions(env)).length, 0);
  });
});

test('a binding that merely LOOKS right but differs in any single field is stale', async () => {
  await withEnv(async (env) => {
    const good = await approveOk(env, IDS.flowA);
    for (const field of Object.keys(good.binding)) {
      const forged = JSON.parse(JSON.stringify(good)) as { binding: Record<string, string> };
      forged.binding[field] = `${forged.binding[field]}-x`;
      await writeFile(approvalFile(env, IDS.flowA), JSON.stringify(forged));
      assert.equal((await execute(env, IDS.flowA, { claim_amount: 20000 })).status, 403, field);
    }
  });
});

test('a capability with no approvable state (unbuildable contract) cannot be approved; the refusal is audited and stores nothing', async () => {
  await withEnv(async (env) => {
    const stored = JSON.parse(await readFile(resultPath(env), 'utf8')) as {
      graph: { nodes: { id: string }[]; edges: { fromId: string; toId: string }[] };
    };
    stored.graph.nodes = stored.graph.nodes.filter((n) => n.id !== IDS.flowA);
    stored.graph.edges = stored.graph.edges.filter((e) => e.fromId !== IDS.flowA && e.toId !== IDS.flowA);
    await writeFile(resultPath(env), JSON.stringify(stored));
    const res = await approve(env, IDS.flowA);
    assert.equal(res.status, 400, res.bodyText);
    assert.equal(events(env, 'approval.denied').at(-1)?.reasonCode, 'APPROVAL_STATE_UNAVAILABLE');
    assert.equal((await capabilityView(env, IDS.flowA)).approved, false);
    await assert.rejects(readFile(approvalFile(env, IDS.flowA)), /ENOENT/);
  });
});

test('an unresolved capability can still be approved but its approval records that, so it cannot silently carry over once it resolves', async () => {
  await withEnv(async (env) => {
    const rec = await approveOk(env, IDS.orphan);
    assert.match(rec.binding.implementationClass, /^unresolved:/);
    const res = await execute(env, IDS.orphan, {});
    assert.equal(res.json<{ status: string }>().status, 'failed', res.bodyText);
  });
});

// ── other enforcement points ───────────────────────────────────────────

test('workflow start refuses a step whose approval is stale — nothing is persisted — and the listing does not show it approved', async () => {
  await withEnv(async (env) => {
    await approveOk(env, IDS.flowA);
    await approveOk(env, IDS.flowB);
    await tamperNode(env, RULE_B, (p) => {
      p['outcome'] = 'release everything';
    });
    const list = (await env.server.request('GET', ws(env, '/workflows'))).json<{
      workflows: { workflowId: string; steps: { capabilityId: string; approved: boolean }[] }[];
    }>().workflows;
    const wf = list.find((w) => w.steps[0]?.capabilityId === IDS.flowA);
    assert.ok(wf);
    assert.deepEqual(
      wf.steps.map((s) => s.approved),
      [true, false],
    );
    const res = await env.server.request('POST', ws(env, `/workflows/${wf.workflowId}/executions`), {
      compilationId: env.compilationId,
      input: { claim_amount: 15000, payout_amount: 800 },
    });
    assert.equal(res.status, 403, res.bodyText);
    assert.equal((await storedExecutions(env)).length, 0);
    const wfList = await env.server.request('GET', ws(env, '/workflow-executions'));
    assert.deepEqual(wfList.json<{ workflowExecutions?: unknown[] }>().workflowExecutions ?? [], []);
  });
});

test('human-task resume is an enforcement point: a stale approval is not resumed and neither decision is applied', async () => {
  for (const decision of ['approve', 'reject'] as const) {
    await withEnv(async (env) => {
      await approveOk(env, IDS.hitlB);
      const created = await execute(env, IDS.hitlB, {});
      assert.ok(created.status === 200 || created.status === 201, created.bodyText);
      const exec = created.json<{ executionId: string; status: string }>();
      assert.equal(exec.status, 'waiting_for_human');
      await tamperNode(env, IDS.hitlB, (p) => {
        p['requiredPermissions'] = [FILE];
      });
      const resolved = await env.server.request('POST', ws(env, `/executions/${exec.executionId}/resolve`), { decision });
      assert.equal(resolved.status, 200, resolved.bodyText);
      const rec = resolved.json<{ status: string; errorCode?: string; output?: unknown }>();
      assert.equal(rec.status, 'failed', decision);
      assert.equal(rec.errorCode, 'XO_RUNTIME_PERMISSION_DENIED', decision);
    });
  }
});

test('human-task resume still works for an unchanged, approved capability', async () => {
  await withEnv(async (env) => {
    await approveOk(env, IDS.hitlB);
    const exec = (await execute(env, IDS.hitlB, {})).json<{ executionId: string }>();
    const resolved = await env.server.request('POST', ws(env, `/executions/${exec.executionId}/resolve`), { decision: 'approve' });
    assert.equal(resolved.status, 200, resolved.bodyText);
    assert.equal(resolved.json<{ status: string }>().status, 'succeeded');
  });
});

// ── audit integration (M4) ─────────────────────────────────────────────

test('granting an approval is durably audited with the verified actor; the audit record carries no full digest or request data', async () => {
  await withEnv(async (env) => {
    const rec = await approveOk(env, IDS.flowA);
    const attempted = events(env, 'approval.attempted');
    const granted = events(env, 'approval.granted');
    assert.equal(attempted.length, 1);
    assert.equal(granted.length, 1);
    assert.deepEqual({ kind: granted[0]?.actor.kind, id: granted[0]?.actor.id }, { kind: 'service', id: 'test-identity' });
    assert.equal(granted[0]?.target?.id, IDS.flowA);
    assert.equal(granted[0]?.outcome, 'completed');
    const serialized = JSON.stringify(env.sink.events());
    assert.ok(!serialized.includes(rec.binding.stateDigest), 'the full state digest must not be written to the audit trail');
    assert.ok(attempted[0]!.seq < granted[0]!.seq);
  });
});

test('if the approval audit precondition cannot be recorded, NO approval is created (fail closed)', async () => {
  await withTempDir('xo-m3-data-', async (dataDir) => {
    const inner = new NonProductionAuditSink();
    const sink = {
      mode: inner.mode,
      append: async (draft: Parameters<NonProductionAuditSink['append']>[0]) =>
        draft.type === 'approval.attempted'
          ? ({ ok: false, error: new Error('down'), indeterminate: false } as never)
          : inner.append(draft),
    };
    const server = await TestServer.start({ workspaceDataDir: dataDir, auditSink: sink as never });
    try {
      const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
      const { compilationId } = await storeFixtureCompilation(workspace, dataDir);
      const res = await server.request(
        'POST',
        `/workspaces/${workspace.workspaceId}/compilations/${compilationId}/capabilities/${IDS.flowA}/approve`,
      );
      assert.equal(res.status, 503, res.bodyText);
      const caps = await server.request('GET', `/workspaces/${workspace.workspaceId}/compilations/${compilationId}/capabilities`);
      assert.equal(caps.json<{ capabilities: CapabilityWire[] }>().capabilities.find((c) => c.capabilityId === IDS.flowA)?.approved, false);
    } finally {
      await server.stop();
    }
  });
});

// ── pure decision + derivation ─────────────────────────────────────────

test('state derivation: stable for the same graph; distinct per capability; source digest bound separately', () => {
  const derive = (graph = buildFixtureGraph(), cap: string = IDS.flowA) => {
    const r = deriveCapabilityApprovalState(graph, cap, SRC_DIGEST);
    assert.ok(r.ok, r.ok ? '' : r.error.message);
    return r.value;
  };
  const base = derive();
  assert.deepEqual(derive(), base, 'deterministic across independent builds');
  assert.equal(base.implementationClass, 'deterministic_rule');
  const sameSource = deriveCapabilityApprovalState(buildFixtureGraph(), IDS.flowA, SRC_DIGEST);
  const otherSource = deriveCapabilityApprovalState(buildFixtureGraph(), IDS.flowA, 'different');
  assert.ok(sameSource.ok && otherSource.ok);
  assert.equal(sameSource.value.stateDigest, otherSource.value.stateDigest, 'the source digest is bound separately, not mixed into the state digest');
  assert.notEqual(sameSource.value.sourceDigestSha256, otherSource.value.sourceDigestSha256);
  assert.notEqual(derive(buildFixtureGraph(), IDS.flowB).stateDigest, base.stateDigest, 'distinct capabilities have distinct state');
});

test('evaluateApproval: pure decision table', () => {
  const current: CurrentApprovalState = {
    stateDigest: 'd',
    contractId: 'c',
    contractContentHash: 'h',
    declarationFingerprint: 'f',
    implementationClass: 'deterministic_rule',
    bindingId: 'b',
    sourceDigestSha256: 's',
  };
  const target = { workspaceId: 'w', compilationId: 'k', capabilityId: 'cap' };
  const record: ApprovalRecord = {
    schemaVersion: 2,
    ...target,
    status: 'approved',
    approvedAt: 't',
    approver: { kind: 'human', id: 'alice', orgId: 'acme' },
    identityId: 'alice',
    approverIdentityId: 'alice',
    binding: { stateDigest: 'd', contractId: 'c', contractContentHash: 'h', declarationFingerprint: 'f', implementationClass: 'deterministic_rule', bindingId: 'b', sourceDigestSha256: 's' },
  };
  assert.equal(evaluateApproval({ kind: 'bound', record }, target, current).approved, true);
  const reason = (l: Parameters<typeof evaluateApproval>[0], c: CurrentApprovalState | null = current) => {
    const v = evaluateApproval(l, target, c ?? undefined);
    return v.approved ? 'approved' : v.reason;
  };
  assert.equal(reason({ kind: 'none' }), 'not_approved');
  assert.equal(reason({ kind: 'legacy' }), 'legacy_unbound');
  assert.equal(reason({ kind: 'malformed' }), 'malformed');
  assert.equal(reason({ kind: 'bound', record }, null), 'state_unavailable', 'unknown current state is never "approved"');
  assert.equal(reason({ kind: 'bound', record: { ...record, workspaceId: 'x' } }), 'target_mismatch');
  assert.equal(reason({ kind: 'bound', record: { ...record, approver: { kind: 'human', id: 'mallory' } } }), 'attribution_invalid');
  for (const field of Object.keys(record.binding)) {
    assert.equal(reason({ kind: 'bound', record }, { ...current, [field]: 'changed' }), 'stale', field);
  }
});
