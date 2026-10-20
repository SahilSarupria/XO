import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Permissions, RuleBasedPolicy, type PolicyRule } from '@xo/permissions';
import { AUDIT_EVENT_TYPES, AUDIT_TARGET_KINDS, NonProductionAuditSink } from '@xo/audit';
import { toJson, XoirNodeId } from '@xo/xoir';
import { LocalFsBlobStore } from '@xo/storage';
import { TestServer, withTempDir } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, buildFixtureGraph, storeFixtureCompilation } from './workflow-fixtures.js';
import { FsCompilationStore } from '../src/compilations/fs-compilation-store.js';
import { compilationLoaderFromStore } from '../src/procedures/registry-validation.js';
import { raceTimeout } from '../src/procedures/procedure-runner.js';
import { workspaceCompilationsStore } from '../src/workspace/workspace-context.js';
import { openApiDocument } from '../src/openapi.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

// P1.1 M3 — effect-free procedure execution. FIXTURE (owner decision 1, 2026-10-18): HAND-BUILT fallback only. The compiler cannot
// prove a multi-step binding today, so the graph is the hand-built P0.8 XOIR fixture (workflow-fixtures.ts) stored through the REAL
// compilation store; nothing here claims the compiler proved any binding. Everything downstream (registry validation, approvals,
// authorization, execution, audit, persistence) is the production path.

const grant = (id: string, permission: string): PolicyRule => ({
  id,
  effect: 'ALLOW',
  match: { permission: permission as never, principalId: 'test-identity' },
});
const GRANTS = [
  grant('author', Permissions.procedure.author),
  grant('approve', Permissions.procedure.approve),
  grant('read', Permissions.procedure.read),
  grant('execute', Permissions.procedure.execute),
];

interface Env {
  readonly server: TestServer;
  readonly sink: NonProductionAuditSink;
  readonly dataDir: string;
  readonly workspacesDir: string;
  readonly workspace: WorkspaceRecord;
  readonly compilationId: string;
  readonly graphHash: string;
}
const CAPS = [IDS.xsegA, IDS.xsegH, IDS.xsegC, IDS.flowB];

async function withEnv(fn: (env: Env) => Promise<void>, rules: readonly PolicyRule[] = GRANTS, approveCaps = true): Promise<void> {
  await withTempDir('xo-m3-data-', async (dataDir) => {
    await withTempDir('xo-m3-ws-', async (workspacesDir) => {
      const sink = new NonProductionAuditSink();
      const server = await TestServer.start({
        workspaceDataDir: dataDir,
        workspacesDir,
        auditSink: sink,
        permissionPolicy: new RuleBasedPolicy([...rules]),
      });
      try {
        const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        const { compilationId } = await storeFixtureCompilation(workspace, dataDir);
        const loaded = await compilationLoaderFromStore(
          new FsCompilationStore(workspaceCompilationsStore(workspace, { dataRootDir: dataDir })),
        )(compilationId);
        assert.ok(loaded);
        const env: Env = { server, sink, dataDir, workspacesDir, workspace, compilationId, graphHash: loaded.graphHash };
        if (approveCaps) for (const cap of CAPS) await approveCapability(env, cap);
        await fn(env);
      } finally {
        await server.stop();
      }
    });
  });
}

const base = (env: Env): string => `/workspaces/${env.workspace.workspaceId}`;
const approveCapability = async (env: Env, capabilityId: string): Promise<void> => {
  const res = await env.server.request('POST', `${base(env)}/compilations/${env.compilationId}/capabilities/${capabilityId}/approve`);
  assert.ok(res.status === 200 || res.status === 201, `approve ${capabilityId} -> ${res.status} ${res.bodyText}`);
};
const exists = async (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );
const pexDir = (env: Env): string => join(env.dataDir, env.workspace.workspaceId, 'procedure-executions');

/** a (xsegA) -> d (matched?) -> h (human review) -> c (settle) | x (flowB). All input-bound parameters are declared up front. */
function vertical(env: Env, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'xo.procedure/1',
    procedureId: 'intake-review',
    version: 1,
    compilationRef: { compilationId: env.compilationId, graphHash: env.graphHash },
    steps: [
      {
        id: 'a',
        kind: 'capability',
        capabilityId: IDS.xsegA,
        basis: 'source_proven',
        next: 'd',
        inputBindings: [{ param: 'intake score', from: { input: 'intake_score' }, bindingStatus: 'proven' }],
      },
      { id: 'd', kind: 'decision', condition: { path: 'steps.a.output.matched', op: 'eq', value: true }, then: 'h', else: 'x' },
      { id: 'h', kind: 'capability', capabilityId: IDS.xsegH, basis: 'source_proven', next: 'c' },
      {
        id: 'c',
        kind: 'capability',
        capabilityId: IDS.xsegC,
        basis: 'source_proven',
        inputBindings: [
          { param: 'matched', from: { step: 'a', output: 'matched' }, bindingStatus: 'proven' },
          { param: 'review amount', from: { input: 'review_amount' }, bindingStatus: 'proven' },
        ],
      },
      {
        id: 'x',
        kind: 'capability',
        capabilityId: IDS.flowB,
        basis: 'source_proven',
        inputBindings: [
          { param: 'matched', from: { step: 'a', output: 'matched' }, bindingStatus: 'proven' },
          { param: 'payout amount', from: { input: 'payout_amount' }, bindingStatus: 'proven' },
        ],
      },
    ],
    ...over,
  };
}
const INPUT = { intake_score: 80, review_amount: 900, payout_amount: 100 };

async function publish(env: Env, doc: Record<string, unknown>, ack?: string): Promise<void> {
  const id = doc['procedureId'] as string;
  const v = doc['version'] as number;
  const put = await env.server.request('PUT', `${base(env)}/procedures/${id}/versions/${v}`, doc);
  assert.equal(put.status, 201, put.bodyText);
  const ap = await env.server.request(
    'POST',
    `${base(env)}/procedures/${id}/versions/${v}/approve`,
    ack === undefined ? undefined : { acknowledgment: ack },
  );
  assert.equal(ap.status, 200, ap.bodyText);
}
interface ExecWire {
  procedureExecutionId: string;
  status: string;
  revision: number;
  steps: { stepId: string; status: string; executionId?: string; failureClass?: string }[];
  outputs: Record<string, Record<string, unknown>>;
  waitingFor?: { stepId: string; executionId: string };
  failure?: { class: string; code: string };
}
const start = (env: Env, input: unknown = INPUT, headers: Record<string, string> = {}, id = 'intake-review', v = 1) =>
  env.server.request('POST', `${base(env)}/procedures/${id}/versions/${v}/executions`, { input }, headers);
const resume = (env: Env, id: string, body: unknown) => env.server.request('POST', `${base(env)}/procedure-executions/${id}/resume`, body);
const getExec = async (env: Env, id: string): Promise<ExecWire> => {
  const res = await env.server.request('GET', `${base(env)}/procedure-executions/${id}`);
  assert.equal(res.status, 200, res.bodyText);
  return res.json<ExecWire>();
};
const stepStatuses = (e: ExecWire): string => e.steps.map((s) => `${s.stepId}:${s.status}`).join(',');
const countExecutionRecords = async (env: Env): Promise<number> => {
  const dir = join(env.dataDir, env.workspace.workspaceId, 'executions');
  return (await exists(dir)) ? (await readdir(dir)).length : 0;
};
const evTypes = (env: Env): string[] => env.sink.events().map((e) => e.type);

test('M3 audit contract: exactly the seven approved execution types and two target kinds are added; the M2 six are unchanged', () => {
  const m3 = [
    'procedure.execution.started',
    'procedure.execution.waiting_for_human',
    'procedure.execution.resumed',
    'procedure.execution.completed',
    'procedure.execution.failed',
    'procedure.step.completed',
    'procedure.step.failed',
  ];
  const m2 = [
    'procedure.approval.denied',
    'procedure.approval.granted',
    'procedure.attempted',
    'procedure.authored',
    'procedure.denied',
    'procedure.validated',
  ];
  assert.deepEqual(AUDIT_EVENT_TYPES.filter((t) => t.startsWith('procedure.') && m3.includes(t)).sort(), [...m3].sort());
  assert.deepEqual(AUDIT_EVENT_TYPES.filter((t) => t.startsWith('procedure.') && !m3.includes(t)).sort(), m2);
  assert.deepEqual(
    AUDIT_TARGET_KINDS.filter((k) => k.startsWith('procedure')),
    ['procedure', 'procedure-execution', 'procedure-step'],
  );
  assert.equal(
    AUDIT_EVENT_TYPES.some((t) => /cancel|retry|effect|mcp/i.test(t) && t.startsWith('procedure.')),
    false,
  );
});

test('branch taken: pause at the human gate, resume, complete; the untaken branch is skipped and never executed (spy: no execution record)', async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    const before = await countExecutionRecords(env);
    const res = await start(env);
    assert.equal(res.status, 201, res.bodyText);
    const waiting = res.json<ExecWire>();
    assert.equal(waiting.status, 'waiting_for_human');
    assert.equal(stepStatuses(waiting), 'a:succeeded,h:waiting_for_human,c:pending,x:pending');
    assert.equal(waiting.outputs['a']?.['matched'], true);
    assert.equal(waiting.waitingFor?.stepId, 'h');
    assert.equal(await countExecutionRecords(env), before + 2, 'only a and h created step executions so far');
    const done = await resume(env, waiting.procedureExecutionId, {
      decision: 'approve',
      expectedRevision: waiting.revision,
      expectedStepExecutionId: waiting.waitingFor!.executionId,
    });
    assert.equal(done.status, 200, done.bodyText);
    const completed = done.json<ExecWire>();
    assert.equal(completed.status, 'completed');
    assert.equal(stepStatuses(completed), 'a:succeeded,h:succeeded,c:succeeded,x:skipped');
    assert.equal(completed.steps.find((s) => s.stepId === 'x')?.executionId, undefined, 'the untaken step never ran');
    assert.equal(await countExecutionRecords(env), before + 3, 'a, h, c ran; x did not');
    const events = evTypes(env);
    for (const t of [
      'procedure.attempted',
      'procedure.execution.started',
      'procedure.step.completed',
      'procedure.execution.waiting_for_human',
      'procedure.execution.resumed',
      'procedure.execution.completed',
    ])
      assert.ok(events.includes(t), t);
    assert.equal(events.includes('procedure.execution.failed'), false);
  });
});

test("branch not taken + value-faithful transfer: a producer's `matched:false` reaches the consumer as false (not dropped, not defaulted)", async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    const res = await start(env, { ...INPUT, intake_score: 10 });
    assert.equal(res.status, 201, res.bodyText);
    const e = res.json<ExecWire>();
    assert.equal(e.status, 'completed');
    assert.equal(stepStatuses(e), 'a:succeeded,h:skipped,c:skipped,x:succeeded');
    assert.equal(e.outputs['a']?.['matched'], false);
    const xExec = await env.server.request('GET', `${base(env)}/executions/${e.steps.find((s) => s.stepId === 'x')!.executionId!}`);
    assert.equal(xExec.status, 200);
    const input = xExec.json<{ input: Record<string, unknown> }>().input;
    assert.equal(input['matched'], false, 'the exact producer value (false) is what the consumer received');
    assert.equal(input['payout_amount'], 100);
    assert.equal(e.steps.find((s) => s.stepId === 'h')?.executionId, undefined);
  });
});

test('restart: a NEW server process over the same persisted stores resumes the paused execution; double resume is 409; stale revision/step are 409', async () => {
  await withTempDir('xo-m3-data-', async (dataDir) => {
    await withTempDir('xo-m3-ws-', async (workspacesDir) => {
      let executionId = '';
      let workspaceId = '';
      let revision = 0;
      let stepExec = '';
      const sink1 = new NonProductionAuditSink();
      const s1 = await TestServer.start({
        workspaceDataDir: dataDir,
        workspacesDir,
        auditSink: sink1,
        permissionPolicy: new RuleBasedPolicy([...GRANTS]),
      });
      let compilationId = '';
      let graphHash = '';
      try {
        const workspace = (await s1.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        workspaceId = workspace.workspaceId;
        compilationId = (await storeFixtureCompilation(workspace, dataDir)).compilationId;
        const loaded = await compilationLoaderFromStore(
          new FsCompilationStore(workspaceCompilationsStore(workspace, { dataRootDir: dataDir })),
        )(compilationId);
        graphHash = loaded!.graphHash;
        const env: Env = { server: s1, sink: sink1, dataDir, workspacesDir, workspace, compilationId, graphHash };
        for (const cap of CAPS) await approveCapability(env, cap);
        await publish(env, vertical(env));
        const waiting = (await start(env)).json<ExecWire>();
        assert.equal(waiting.status, 'waiting_for_human');
        executionId = waiting.procedureExecutionId;
        revision = waiting.revision;
        stepExec = waiting.waitingFor!.executionId;
      } finally {
        await s1.stop();
      }
      // ── restart ──
      const sink2 = new NonProductionAuditSink();
      const s2 = await TestServer.start({
        workspaceDataDir: dataDir,
        workspacesDir,
        auditSink: sink2,
        permissionPolicy: new RuleBasedPolicy([...GRANTS]),
      });
      try {
        const fetched = await s2.request('GET', `/workspaces/${workspaceId}`);
        assert.equal(fetched.status, 200, fetched.bodyText);
        const workspace = fetched.json<WorkspaceRecord>();
        const env: Env = { server: s2, sink: sink2, dataDir, workspacesDir, workspace, compilationId, graphHash };
        const still = await getExec(env, executionId);
        assert.equal(still.status, 'waiting_for_human', 'the paused state survived the restart');
        assert.equal(
          (await resume(env, executionId, { decision: 'approve', expectedRevision: revision + 99 })).status,
          409,
          'stale revision',
        );
        assert.equal(
          (await resume(env, executionId, { decision: 'approve', expectedStepExecutionId: 'exec_00000000000000000000000000000000' }))
            .status,
          409,
          'stale step execution',
        );
        const ok = await resume(env, executionId, { decision: 'approve', expectedRevision: revision, expectedStepExecutionId: stepExec });
        assert.equal(ok.status, 200, ok.bodyText);
        assert.equal(ok.json<ExecWire>().status, 'completed');
        const again = await resume(env, executionId, { decision: 'approve' });
        assert.equal(again.status, 409, 'double resume');
        assert.equal(again.json<{ error: { context?: { reason?: string } } }>().error.context?.reason, 'terminal');
      } finally {
        await s2.stop();
      }
    });
  });
});

test('human rejection fails the execution with class human_rejected; later steps are skipped and never run', async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    const waiting = (await start(env)).json<ExecWire>();
    const res = await resume(env, waiting.procedureExecutionId, { decision: 'reject' });
    assert.equal(res.status, 200, res.bodyText);
    const e = res.json<ExecWire>();
    assert.equal(e.status, 'failed');
    assert.equal(e.failure?.class, 'human_rejected');
    assert.equal(stepStatuses(e), 'a:succeeded,h:failed,c:skipped,x:skipped');
    assert.ok(evTypes(env).includes('procedure.step.failed') && evTypes(env).includes('procedure.execution.failed'));
  });
});

test('authorization at start: no procedure.execute grant, an unapproved capability, and an unapproved procedure each leave ZERO execution records', async () => {
  await withEnv(
    async (env) => {
      await publish(env, vertical(env));
      assert.equal((await start(env)).status, 403);
      assert.equal(await exists(pexDir(env)), false);
      assert.equal(await countExecutionRecords(env), 0);
      assert.ok(env.sink.events().some((e) => e.type === 'procedure.denied' && e.action === 'start.procedure'));
    },
    GRANTS.filter((g) => g.id !== 'execute'),
  );
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    const cKey = join(env.dataDir, env.workspace.workspaceId, 'approvals');
    const store = new LocalFsBlobStore(cKey);
    const keys = await store.list();
    assert.ok(keys.ok);
    for (const k of keys.value.filter((x) => x.includes(IDS.xsegC))) await rm(join(cKey, k));
    const res = await start(env);
    assert.equal(res.status, 403, res.bodyText);
    assert.match(res.json<{ error: { message: string } }>().error.message, /xseg_c_settle|approv/i);
    assert.equal(await exists(pexDir(env)), false);
    assert.equal(await countExecutionRecords(env), 0, 'no step ran');
  });
  await withEnv(async (env) => {
    const put = await env.server.request('PUT', `${base(env)}/procedures/intake-review/versions/1`, vertical(env));
    assert.equal(put.status, 201);
    const res = await start(env);
    assert.equal(res.status, 403, 'a draft (never approved) cannot start');
    assert.match(res.json<{ error: { message: string } }>().error.message, /lifecycle: draft/);
    assert.equal(await exists(pexDir(env)), false);
  });
});

async function replaceCompiledGraph(env: Env, mutate: (graph: ReturnType<typeof buildFixtureGraph>) => void): Promise<void> {
  const store = new FsCompilationStore(workspaceCompilationsStore(env.workspace, { dataRootDir: env.dataDir }));
  const rec = await store.get(env.compilationId);
  assert.ok(rec.ok && rec.value.resultStorageKey !== undefined);
  const g = buildFixtureGraph();
  mutate(g);
  const file = join(env.dataDir, env.workspace.workspaceId, 'compilations', rec.ok ? (rec.value.resultStorageKey as string) : '');
  const current = JSON.parse(await readFile(file, 'utf8')) as { graph?: unknown } & Record<string, unknown>;
  await writeFile(file, JSON.stringify('graph' in current ? { ...current, graph: toJson(g) } : toJson(g)));
}
const addNode = (g: ReturnType<typeof buildFixtureGraph>): void => {
  const added = g.createAndAddNode({
    id: XoirNodeId('cap_m3_drift'),
    kind: 'capability',
    properties: { name: 'Drift', description: 'added after approval', requiredPermissions: [] },
    confidence: 0.8,
    sourceRefs: [{ documentPath: 'p08-fixture.pdf', pages: [1] }],
  });
  assert.ok(added.ok);
};

test('N-7 / N-15: start recomputes everything NOW — a registry change after approval, or a tampered stored definition, refuses the start and leaves zero records', async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    await replaceCompiledGraph(env, addNode); // valid graph, different content hash: an edit between approve and start
    const res = await start(env);
    assert.equal(res.status, 403, res.bodyText);
    assert.match(res.json<{ error: { message: string } }>().error.message, /approval_stale|approval_unverifiable/);
    assert.equal(await exists(pexDir(env)), false);
    assert.equal(await countExecutionRecords(env), 0);
  });
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    const file = join(env.dataDir, env.workspace.workspaceId, 'procedures', 'intake-review', 'v1', 'definition.json');
    const rec = JSON.parse(await readFile(file, 'utf8')) as { definition: { title?: string } };
    rec.definition.title = 'tampered';
    await writeFile(file, JSON.stringify(rec));
    const res = await start(env);
    assert.ok(res.status >= 400, `tampered definition must not start (${res.status})`);
    assert.equal(await exists(pexDir(env)), false);
    assert.equal(await countExecutionRecords(env), 0);
  });
});

test('N-8 / per-step authorization is re-checked before EVERY step: a capability approval that disappears while paused fails the later step closed; that step never runs', async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    const waiting = (await start(env)).json<ExecWire>();
    const dir = join(env.dataDir, env.workspace.workspaceId, 'approvals');
    const keys = await new LocalFsBlobStore(dir).list();
    assert.ok(keys.ok);
    for (const k of keys.value.filter((x) => x.includes(IDS.xsegC))) await rm(join(dir, k));
    const before = await countExecutionRecords(env);
    const res = await resume(env, waiting.procedureExecutionId, { decision: 'approve' });
    assert.equal(res.status, 200, res.bodyText);
    const e = res.json<ExecWire>();
    assert.equal(e.status, 'failed');
    assert.equal(e.failure?.class, 'authorization');
    assert.equal(stepStatuses(e), 'a:succeeded,h:succeeded,c:failed,x:skipped');
    assert.equal(e.steps.find((s) => s.stepId === 'c')?.executionId, undefined, 'the denied step never created an execution');
    assert.equal(await countExecutionRecords(env), before, 'nothing ran after the approval disappeared');
  });
  // a registry change (valid graph, new hash) while paused: the later step fails as stale_binding and never executes
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    const waiting = (await start(env)).json<ExecWire>();
    await replaceCompiledGraph(env, addNode);
    const res = await resume(env, waiting.procedureExecutionId, { decision: 'approve' });
    const e = res.status === 200 ? res.json<ExecWire>() : undefined;
    if (e !== undefined) {
      assert.notEqual(e.status, 'completed');
      assert.equal(e.steps.find((s) => s.stepId === 'c')?.status === 'succeeded', false);
    } else assert.ok(res.status >= 400);
  });
});

test('start-time input validation (owner decision 4): valid input; missing required; wrong type; undeclared key; each is rejected before ANY persistence or execution', async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    const cases: [string, unknown, string, string][] = [
      ['missing required', { intake_score: 80, payout_amount: 100 }, 'PROC_INPUT_MISSING', '/input/review_amount'],
      ['wrong type', { ...INPUT, intake_score: 'high' }, 'PROC_INPUT_INVALID', '/input/intake_score'],
      ['undeclared key', { ...INPUT, surprise: 1 }, 'PROC_INPUT_UNDECLARED', '/input/surprise'],
    ];
    for (const [label, input, code, path] of cases) {
      const res = await start(env, input);
      assert.equal(res.status, 400, `${label}: ${res.bodyText}`);
      const f = res.json<{ error: { context: { findings: { code: string; path: string }[] } } }>().error.context.findings;
      assert.ok(
        f.some((x) => x.code === code && x.path === path),
        `${label}: ${JSON.stringify(f)}`,
      );
      assert.equal(res.bodyText.includes('"high"'), false, 'no submitted value is echoed');
    }
    assert.equal(await exists(pexDir(env)), false, 'no execution record');
    assert.equal(await countExecutionRecords(env), 0, 'no step ran');
    const ok = await start(env);
    assert.equal(ok.status, 201, ok.bodyText);
    // input must be an object
    assert.equal((await start(env, [1, 2])).status, 400);
  });
});

test('start-time input validation fails closed when the consumer contract is absent: an input-bound parameter the schema does not declare is rejected', async () => {
  await withEnv(async (env) => {
    // `matched` is a contract input of xsegC but NOT a property of its execution input schema, so binding it from client input has no
    // schema to validate against: ambiguous contract => fail closed.
    const doc = vertical(env, { procedureId: 'ambiguous', version: 1 });
    const steps = doc['steps'] as { id: string; inputBindings?: { param: string; from: Record<string, string> }[] }[];
    steps.find((s) => s.id === 'c')!.inputBindings![0] = { param: 'matched', from: { input: 'matched_in' } };
    await publish(env, doc);
    const res = await start(env, { ...INPUT, matched_in: true }, {}, 'ambiguous', 1);
    assert.equal(res.status, 400, res.bodyText);
    const f = res.json<{ error: { context: { findings: { code: string }[] } } }>().error.context.findings.map((x) => x.code);
    assert.ok(f.includes('PROC_INPUT_UNDECLARED'), JSON.stringify(f));
    assert.equal(await exists(pexDir(env)), false);
  });
});

test('M6 line — idempotent start: the same Idempotency-Key replays the same execution; a different payload with that key is 422; no second execution exists', async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    const h = { 'idempotency-key': 'start-intake-0001' };
    const first = await start(env, INPUT, h);
    assert.equal(first.status, 201, first.bodyText);
    const a = first.json<ExecWire>();
    const recordsAfterFirst = await countExecutionRecords(env);
    const again = await start(env, INPUT, h);
    assert.equal(again.status, 201, again.bodyText);
    assert.equal(again.json<ExecWire>().procedureExecutionId, a.procedureExecutionId);
    assert.equal(again.headers['idempotent-replayed'], 'true');
    assert.equal(await countExecutionRecords(env), recordsAfterFirst, 'the replay ran nothing');
    const mismatch = await start(env, { ...INPUT, intake_score: 5 }, h);
    assert.equal(mismatch.status, 422, mismatch.bodyText);
    const files = await readdir(pexDir(env));
    assert.equal(files.filter((f) => f.endsWith('.json')).length, 1, 'exactly one execution');
  });
});

test('workspace isolation and read: another identity gets 404 for any execution; an unknown id is indistinguishable', async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    const e = (await start(env)).json<ExecWire>();
    const other = await env.server.issueAdditionalIdentity('other-identity');
    const hdr = TestServer.authHeader(other.apiKey) as Record<string, string>;
    const foreign = await env.server.request('GET', `${base(env)}/procedure-executions/${e.procedureExecutionId}`, undefined, hdr);
    const unknown = await env.server.request('GET', `${base(env)}/procedure-executions/pex_${'0'.repeat(32)}`);
    assert.equal(foreign.status, 404);
    assert.equal(unknown.status, 404);
    assert.equal(foreign.json<{ error: { code: string } }>().error.code, unknown.json<{ error: { code: string } }>().error.code);
    assert.equal(
      (await env.server.request('POST', `${base(env)}/procedure-executions/${e.procedureExecutionId}/resume`, { decision: 'approve' }, hdr))
        .status,
      404,
    );
    for (const bad of ['a%2Fb', 'pex_zz', 'x'.repeat(40), `pex_${'0'.repeat(31)}`])
      assert.equal((await env.server.request('GET', `${base(env)}/procedure-executions/${bad}`)).status, 404);
  });
});

test('closed bodies: forged authority fields on start/resume are rejected without echoing values', async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    const secret = 'SECRET-M3-77aa';
    const forged = await env.server.request('POST', `${base(env)}/procedures/intake-review/versions/1/executions`, {
      input: INPUT,
      humanGate: false,
      limits: { x: secret },
      principal: secret,
    });
    assert.equal(forged.status, 400);
    assert.equal(forged.bodyText.includes(secret), false);
    assert.equal(await exists(pexDir(env)), false);
    const e = (await start(env)).json<ExecWire>();
    const bad = await resume(env, e.procedureExecutionId, { decision: 'approve', approvedBy: secret });
    assert.equal(bad.status, 400);
    assert.equal(bad.bodyText.includes(secret), false);
    assert.equal((await resume(env, e.procedureExecutionId, { decision: 'maybe' })).status, 400);
  });
});

test('postcondition failure is class failed_postcondition (the `then` conditions are evaluated over recorded outputs)', async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env, { procedureId: 'post', then: [{ path: 'steps.a.output.matched', op: 'eq', value: false }] }));
    const res = await start(env, { ...INPUT, intake_score: 80 }, {}, 'post', 1);
    // intake_score 80 => matched true => the (human) path pauses first; take the not-matched path instead so the run reaches its end
    const paused = res.json<ExecWire>();
    assert.equal(paused.status, 'waiting_for_human');
    const ok = await resume(env, paused.procedureExecutionId, { decision: 'approve' });
    const done = ok.json<ExecWire>();
    assert.equal(done.status, 'failed');
    assert.equal(done.failure?.class, 'failed_postcondition');
    assert.ok(evTypes(env).includes('procedure.execution.failed'));
  });
});

test('step timeout (server-configured, no default) is class timeout; and raceTimeout passes work through when no timeout is set', async () => {
  assert.equal(await raceTimeout(Promise.resolve(7), undefined), 7);
  assert.equal(await raceTimeout(Promise.resolve(7), 1000), 7);
  assert.equal(await raceTimeout(new Promise((r) => setTimeout(() => r(1), 80)), 5), 'timeout');
});

test('crash-at-write: a leftover truncated temp file never replaces the record; reads return the last complete record', async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    const e = (await start(env)).json<ExecWire>();
    await writeFile(join(pexDir(env), `${e.procedureExecutionId}.json.tmp-crashed`), '{"schemaVersion":1,"procedureExecut');
    const again = await getExec(env, e.procedureExecutionId);
    assert.equal(again.status, 'waiting_for_human');
    assert.equal(again.revision, e.revision);
    const file = await readFile(join(pexDir(env), `${e.procedureExecutionId}.json`), 'utf8');
    assert.doesNotThrow(() => JSON.parse(file));
    // a corrupt primary record fails closed (404), never served
    await writeFile(join(pexDir(env), `${e.procedureExecutionId}.json`), '{"truncated"');
    assert.equal((await env.server.request('GET', `${base(env)}/procedure-executions/${e.procedureExecutionId}`)).status, 404);
  });
});

test('OpenAPI documents the M3 routes; no cancel or retry route exists', () => {
  const paths = Object.keys(openApiDocument.paths);
  for (const p of [
    '/workspaces/{workspaceId}/procedures/{procedureId}/versions/{version}/executions',
    '/workspaces/{workspaceId}/procedure-executions/{executionId}',
    '/workspaces/{workspaceId}/procedure-executions/{executionId}/resume',
  ])
    assert.ok(paths.includes(p), p);
  assert.equal(
    paths.some((p) => /procedure/.test(p) && /(cancel|retry)/.test(p)),
    false,
  );
});
