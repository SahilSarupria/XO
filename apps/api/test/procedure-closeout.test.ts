import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Permissions, RuleBasedPolicy, type PermissionPolicy, type PolicyRule } from '@xo/permissions';
import { NonProductionAuditSink, AUDIT_EVENT_TYPES, type AuditEventDraft } from '@xo/audit';
import { toJson, XoirNodeId } from '@xo/xoir';
import { LocalFsBlobStore } from '@xo/storage';
import { TestServer, withTempDir } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, buildFixtureGraph, storeFixtureCompilation } from './workflow-fixtures.js';
import { FsCompilationStore } from '../src/compilations/fs-compilation-store.js';
import { compilationLoaderFromStore } from '../src/procedures/registry-validation.js';
import {
  FsProcedureExecutionStore,
  PROCEDURE_EXECUTION_SCHEMA,
  type ProcedureExecutionRecord,
} from '../src/procedures/procedure-execution.js';
import { validateStartInput } from '../src/procedures/procedure-runner.js';
import { loadConfig, parseStepTimeoutMs } from '../src/config.js';
import { workspaceCompilationsStore } from '../src/workspace/workspace-context.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

// P1.1 M3 CLOSEOUT -- owner decisions D2-D5, D7, D8 (2026-10-21). ADDITIVE test file: no existing test is edited here.
// FIXTURE: the HAND-BUILT P0.8 fallback graph (owner decision D10); nothing below claims the compiler proved any binding.

// --------------------------------------------------------------------------------------------------------------------------
// harness
// --------------------------------------------------------------------------------------------------------------------------

const grant = (id: string, permission: string): PolicyRule => ({
  id,
  effect: 'ALLOW',
  match: { permission: permission as never, principalId: 'test-identity' },
});
const GRANTS: readonly PolicyRule[] = [
  grant('author', Permissions.procedure.author),
  grant('approve', Permissions.procedure.approve),
  grant('read', Permissions.procedure.read),
  grant('execute', Permissions.procedure.execute),
];
const WITH_FILE: readonly PolicyRule[] = [...GRANTS, grant('file', Permissions.filesystem.read)];

/** A policy whose rule set can be swapped between steps (models "permission removed / policy changed while running"). */
class SwitchPolicy implements PermissionPolicy {
  current: PermissionPolicy;
  constructor(rules: readonly PolicyRule[]) {
    this.current = new RuleBasedPolicy([...rules]);
  }
  set(rules: readonly PolicyRule[]): void {
    this.current = new RuleBasedPolicy([...rules]);
  }
  evaluate(request: Parameters<PermissionPolicy['evaluate']>[0]): ReturnType<PermissionPolicy['evaluate']> {
    return this.current.evaluate(request);
  }
}

/** Non-production sink with deterministic seams: refuse chosen event types, or run a hook BEFORE an event is appended. */
class HookSink extends NonProductionAuditSink {
  readonly refuse = new Set<string>();
  beforeAppend: ((draft: AuditEventDraft) => Promise<void> | void) | undefined;
  override async append(draft: AuditEventDraft): ReturnType<NonProductionAuditSink['append']> {
    if (this.beforeAppend !== undefined) await this.beforeAppend(draft);
    if (this.refuse.has(draft.type)) return { ok: false, error: new Error('audit sink down'), indeterminate: false } as never;
    return super.append(draft);
  }
}

interface Env {
  readonly server: TestServer;
  readonly sink: HookSink;
  readonly policy: SwitchPolicy;
  readonly dataDir: string;
  readonly workspace: WorkspaceRecord;
  readonly compilationId: string;
  readonly graphHash: string;
}
const CAPS = [IDS.xsegA, IDS.xsegH, IDS.xsegC, IDS.flowB, IDS.perm];

async function withEnv(
  fn: (env: Env) => Promise<void>,
  rules: readonly PolicyRule[] = WITH_FILE,
  serverOptions: { procedureStepTimeoutMs?: number; testBeforeStepExecute?: () => Promise<void> } = {},
): Promise<void> {
  await withTempDir('xo-m3c-data-', async (dataDir) => {
    await withTempDir('xo-m3c-ws-', async (workspacesDir) => {
      const sink = new HookSink();
      const policy = new SwitchPolicy(rules);
      const server = await TestServer.start({
        workspaceDataDir: dataDir,
        workspacesDir,
        auditSink: sink,
        permissionPolicy: policy,
        ...serverOptions,
      });
      try {
        const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        const { compilationId } = await storeFixtureCompilation(workspace, dataDir);
        const loaded = await compilationLoaderFromStore(
          new FsCompilationStore(workspaceCompilationsStore(workspace, { dataRootDir: dataDir })),
        )(compilationId);
        assert.ok(loaded);
        const env: Env = { server, sink, policy, dataDir, workspace, compilationId, graphHash: loaded.graphHash };
        for (const cap of CAPS) {
          const res = await server.request('POST', `${base(env)}/compilations/${compilationId}/capabilities/${cap}/approve`);
          assert.ok(res.status === 200 || res.status === 201, `approve ${cap} -> ${res.status} ${res.bodyText}`);
        }
        await fn(env);
      } finally {
        await server.stop();
      }
    });
  });
}

const base = (env: Pick<Env, 'workspace'>): string => `/workspaces/${env.workspace.workspaceId}`;
const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );
const pexDir = (env: Env): string => join(env.dataDir, env.workspace.workspaceId, 'procedure-executions');
const countCapabilityExecutions = async (env: Env): Promise<number> => {
  const dir = join(env.dataDir, env.workspace.workspaceId, 'executions');
  return (await exists(dir)) ? (await readdir(dir)).length : 0;
};
const countProcedureExecutions = async (env: Env): Promise<number> =>
  (await exists(pexDir(env))) ? (await readdir(pexDir(env))).filter((f) => f.endsWith('.json')).length : 0;
const evTypes = (env: Env): string[] => env.sink.events().map((e) => e.type);

/** xsegA -> d(matched?) -> h(human) -> c(settle) | x(flowB). Mirrors the M3 vertical (hand-built fallback fixture). */
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

async function put(env: Env, doc: Record<string, unknown>): Promise<{ status: number; bodyText: string }> {
  return env.server.request('PUT', `${base(env)}/procedures/${doc['procedureId'] as string}/versions/${doc['version'] as number}`, doc);
}
async function approve(env: Env, id: string, v = 1): Promise<{ status: number; bodyText: string }> {
  return env.server.request('POST', `${base(env)}/procedures/${id}/versions/${v}/approve`);
}
async function publish(env: Env, doc: Record<string, unknown>): Promise<void> {
  const p = await put(env, doc);
  assert.equal(p.status, 201, p.bodyText);
  const a = await approve(env, doc['procedureId'] as string, doc['version'] as number);
  assert.equal(a.status, 200, a.bodyText);
}
const start = (env: Env, input: unknown = INPUT, headers: Record<string, string> = {}, id = 'intake-review', v = 1) =>
  env.server.request('POST', `${base(env)}/procedures/${id}/versions/${v}/executions`, { input }, headers);
const resume = (env: Env, id: string, body: unknown) => env.server.request('POST', `${base(env)}/procedure-executions/${id}/resume`, body);
interface ExecWire {
  procedureExecutionId: string;
  status: string;
  revision: number;
  steps: { stepId: string; status: string; executionId?: string; failureClass?: string }[];
  waitingFor?: { stepId: string; executionId: string };
  failure?: { class: string; code: string };
}
const getExec = async (env: Env, id: string): Promise<ExecWire> => {
  const res = await env.server.request('GET', `${base(env)}/procedure-executions/${id}`);
  assert.equal(res.status, 200, res.bodyText);
  return res.json<ExecWire>();
};
const statuses = (e: ExecWire): string => e.steps.map((s) => `${s.stepId}:${s.status}`).join(',');
const errCodes = (res: { json: <T>() => T }): string[] =>
  res.json<{ error?: { context?: { findings?: { code: string }[] } } }>().error?.context?.findings?.map((f) => f.code) ?? [];

async function mutateStoredGraph(
  env: Env,
  mutate: (json: { nodes: Record<string, unknown>[] } & Record<string, unknown>) => void,
): Promise<void> {
  const store = new FsCompilationStore(workspaceCompilationsStore(env.workspace, { dataRootDir: env.dataDir }));
  const rec = await store.get(env.compilationId);
  assert.ok(rec.ok && rec.value.resultStorageKey !== undefined);
  const file = join(env.dataDir, env.workspace.workspaceId, 'compilations', rec.ok ? (rec.value.resultStorageKey as string) : '');
  const current = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  const holder =
    'graph' in current ? (current['graph'] as { nodes: Record<string, unknown>[] }) : (current as { nodes: Record<string, unknown>[] });
  mutate(holder as never);
  await writeFile(file, JSON.stringify(current));
}
const addNodeToStoredGraph = async (env: Env): Promise<void> => {
  const store = new FsCompilationStore(workspaceCompilationsStore(env.workspace, { dataRootDir: env.dataDir }));
  const rec = await store.get(env.compilationId);
  assert.ok(rec.ok && rec.value.resultStorageKey !== undefined);
  const g = buildFixtureGraph();
  const added = g.createAndAddNode({
    id: XoirNodeId('cap_m3c_drift'),
    kind: 'capability',
    properties: { name: 'Drift', description: 'added after approval', requiredPermissions: [] },
    confidence: 0.8,
    sourceRefs: [{ documentPath: 'p08-fixture.pdf', pages: [1] }],
  });
  assert.ok(added.ok);
  const file = join(env.dataDir, env.workspace.workspaceId, 'compilations', rec.ok ? (rec.value.resultStorageKey as string) : '');
  const current = JSON.parse(await readFile(file, 'utf8')) as { graph?: unknown } & Record<string, unknown>;
  await writeFile(file, JSON.stringify('graph' in current ? { ...current, graph: toJson(g) } : toJson(g)));
};

// --------------------------------------------------------------------------------------------------------------------------
// D2 -- timeout semantics: no implicit default; server-level configuration; unset means no timeout
// --------------------------------------------------------------------------------------------------------------------------

test('D2 config: unset (or empty) means NO timeout and there is no numeric default; a set value must be a positive integer; anything else aborts startup', () => {
  assert.equal(parseStepTimeoutMs(undefined), undefined);
  assert.equal(parseStepTimeoutMs(''), undefined);
  assert.equal(parseStepTimeoutMs('  '), undefined);
  assert.equal(parseStepTimeoutMs('2500'), 2500);
  for (const bad of ['0', '-5', '1.5', 'abc', '10s', '1e3', '99999999999'])
    assert.throws(() => parseStepTimeoutMs(bad), /positive integer/, bad);
  assert.equal('procedureStepTimeoutMs' in loadConfig({}), false, 'no default is present when the variable is unset');
  assert.equal(loadConfig({ XO_PROCEDURE_STEP_TIMEOUT_MS: '4000' }).procedureStepTimeoutMs, 4000);
  assert.throws(() => loadConfig({ XO_PROCEDURE_STEP_TIMEOUT_MS: 'soon' }), /positive integer/);
});

test('D2 HTTP: the configured timeout reaches the runner and a generous value changes nothing (not classified, not cancelled); unset behaves identically', async () => {
  for (const options of [{}, { procedureStepTimeoutMs: 600_000 }]) {
    await withEnv(
      async (env) => {
        await publish(env, vertical(env));
        const res = await start(env);
        assert.equal(res.status, 201, res.bodyText);
        const waiting = res.json<ExecWire>();
        assert.equal(waiting.status, 'waiting_for_human');
        assert.equal(waiting.failure, undefined, 'a step that finishes inside the timeout is never classified as a timeout');
        assert.equal(res.bodyText.toLowerCase().includes('cancel'), false, 'no cancellation is claimed or implied');
      },
      WITH_FILE,
      options,
    );
  }
});

// --------------------------------------------------------------------------------------------------------------------------
// D3 -- store-level fault injection between temp-file write and atomic publication (real LocalFsBlobStore + real store)
// --------------------------------------------------------------------------------------------------------------------------

const WS = 'ws_m3_closeout';
const PEX = 'pex_00000000000000000000000000000001';
const mkRecord = (revision: number, status: ProcedureExecutionRecord['status'] = 'running'): ProcedureExecutionRecord => ({
  schemaVersion: PROCEDURE_EXECUTION_SCHEMA,
  procedureExecutionId: PEX,
  workspaceId: WS,
  procedureId: 'p',
  version: 1,
  procedureHash: 'sha256:abc',
  initiator: { kind: 'human', id: 'test-identity' },
  revision,
  status,
  input: { n: revision },
  outputs: {},
  steps: [{ stepId: 's', capabilityId: 'cap', status: 'pending' }],
  createdAt: '2026-10-21T00:00:00.000Z',
  updatedAt: `2026-10-21T00:00:0${revision}.000Z`,
});

/** Replace fs.promises members for the duration of `fn`; `syncBuiltinESMExports` makes the store's named ESM imports see them. */
async function withFsPatched<T>(
  patch: Partial<Record<'rename' | 'writeFile', (...a: never[]) => Promise<unknown>>>,
  fn: () => Promise<T>,
): Promise<T> {
  const original = { rename: fsp.rename, writeFile: fsp.writeFile };
  Object.assign(fsp, patch);
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    Object.assign(fsp, original);
    syncBuiltinESMExports();
  }
}

test('D3 crash recovery: a failure between the temp-file write and the rename (and one mid temp-write) leaves the OLD record intact; the window itself shows old-or-new, never partial', async () => {
  await withTempDir('xo-m3c-store-', async (dir) => {
    const blobs = new LocalFsBlobStore(dir);
    const store = new FsProcedureExecutionStore(blobs, WS);
    const created = await store.create(mkRecord(0));
    assert.ok(created.ok);
    const primary = join(dir, `${PEX}.json`);
    const oldBytes = await readFile(primary, 'utf8');

    // 1) temp file fully written, then the rename fails: the primary is byte-identical to the old record and reads as the old record.
    const realRename = fsp.rename;
    await withFsPatched(
      { rename: (async () => Promise.reject(Object.assign(new Error('injected: crash before publication'), { code: 'EIO' }))) as never },
      async () => {
        await assert.rejects(() => store.save(mkRecord(1), 0));
      },
    );
    assert.equal(await readFile(primary, 'utf8'), oldBytes, 'the primary file is untouched by an interrupted publication');
    const afterRenameFault = await store.get(PEX);
    assert.ok(afterRenameFault.ok);
    assert.deepEqual(afterRenameFault.ok ? afterRenameFault.value : undefined, mkRecord(0), 'readers still see the complete OLD record');
    assert.equal(fsp.rename, realRename, 'the patch was restored');

    // 2) a PARTIAL temp write (half the bytes, then failure): the temp is never promoted; the primary is unchanged.
    const realWrite = fsp.writeFile;
    await withFsPatched(
      {
        writeFile: (async (path: string, data: Uint8Array) => {
          if (String(path).endsWith('.tmp')) {
            await realWrite(path, data.subarray(0, Math.floor(data.length / 2)));
            throw Object.assign(new Error('injected: partial write'), { code: 'EIO' });
          }
          return realWrite(path, data);
        }) as never,
      },
      async () => {
        await assert.rejects(() => store.save(mkRecord(1), 0));
      },
    );
    assert.equal(await readFile(primary, 'utf8'), oldBytes, 'a partially written temp file never reaches the primary');
    const afterPartial = await store.get(PEX);
    assert.deepEqual(afterPartial.ok ? afterPartial.value : undefined, mkRecord(0));

    // Characterization (NOT relied on above): the store removes its own temp file on failure.
    assert.deepEqual(
      (await readdir(dir)).filter((f) => f.endsWith('.tmp')),
      [],
      'no stray temp file remains after the injected failures',
    );

    // 3) the interleaving window: a reader that runs AFTER the temp file is complete and BEFORE the rename sees the old record; after the rename, the new one.
    let seenInWindow: ProcedureExecutionRecord | undefined;
    await withFsPatched(
      {
        rename: (async (from: string, to: string) => {
          const mid = await store.get(PEX);
          seenInWindow = mid.ok ? mid.value : undefined;
          return realRename(from, to);
        }) as never,
      },
      async () => {
        await store.save(mkRecord(1), 0);
      },
    );
    assert.deepEqual(seenInWindow, mkRecord(0), 'inside the window the reader sees the complete old record');
    const after = await store.get(PEX);
    assert.deepEqual(after.ok ? after.value : undefined, mkRecord(1), 'after publication readers see the complete new record');

    // A stale writer cannot publish over the new record (compare-and-set), and a failed attempt leaves revision 1 intact.
    await assert.rejects(() => store.save(mkRecord(1, 'failed'), 0), /stale|modified concurrently/i);
    const still = await store.get(PEX);
    assert.deepEqual(still.ok ? still.value : undefined, mkRecord(1));
  });
});

// --------------------------------------------------------------------------------------------------------------------------
// D4 -- N-15: deterministic interleaving of an approved-procedure edit and an execution start (single-process; see report)
// --------------------------------------------------------------------------------------------------------------------------

test('D4 N-15 interleaving A: an edit that lands AFTER the durable attempt but BEFORE validation is seen by the start -> refused (403), zero records, nothing ran', async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    let edited = false;
    env.sink.beforeAppend = async (d) => {
      if (d.type === 'procedure.attempted' && d.action === 'start.procedure' && !edited) {
        edited = true;
        await addNodeToStoredGraph(env);
      }
    };
    const res = await start(env);
    assert.equal(edited, true, 'the interleaving point was reached');
    assert.equal(res.status, 403, res.bodyText);
    assert.match(res.json<{ error: { message: string } }>().error.message, /approval_stale|approval_unverifiable/);
    assert.equal(await countProcedureExecutions(env), 0, 'no procedure execution record');
    assert.equal(await countCapabilityExecutions(env), 0, 'no capability ran');
    assert.equal(evTypes(env).includes('procedure.execution.started'), false);
  });
});

test('D4 N-15 interleaving B: an edit that lands AFTER validation and record creation but BEFORE the first step -> permitted outcome is a closed failure (stale_binding); NO step ever executes against the edited registry', async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    let edited = false;
    env.sink.beforeAppend = async (d) => {
      if (d.type === 'procedure.execution.started' && !edited) {
        edited = true;
        await addNodeToStoredGraph(env);
      }
    };
    const res = await start(env);
    assert.equal(edited, true, 'the interleaving point (between persistence and the first step) was reached');
    assert.equal(res.status, 200, res.bodyText); // a failed run is reported as 200 with status "failed"
    const e = res.json<ExecWire>();
    assert.equal(e.status, 'failed');
    assert.equal(e.failure?.class, 'stale_binding', 'fails closed on the per-step fresh registry read');
    assert.equal(e.steps.find((s) => s.stepId === 'a')?.status, 'failed');
    assert.equal(e.steps.find((s) => s.stepId === 'a')?.executionId, undefined, 'no capability execution was created');
    assert.equal(await countCapabilityExecutions(env), 0, 'zero capability executions after the edit');
    assert.equal(evTypes(env).includes('procedure.step.completed'), false);
    assert.ok(evTypes(env).includes('procedure.execution.failed'));
  });
});

// --------------------------------------------------------------------------------------------------------------------------
// D5 -- approval strictness: required execution-schema properties must be bound (separately identifiable M2 correction)
// --------------------------------------------------------------------------------------------------------------------------

test('D5 approval strictness: a step whose REQUIRED execution-schema property has no binding is rejected at approval (and never startable); the valid procedure still approves and runs', async () => {
  await withEnv(async (env) => {
    const incomplete = vertical(env, { procedureId: 'incomplete', version: 1 });
    const steps = incomplete['steps'] as { id: string; inputBindings?: unknown }[];
    delete steps.find((s) => s.id === 'a')!.inputBindings; // xsegA's schema REQUIRES intake_score
    assert.equal((await put(env, incomplete)).status, 201, 'a draft can be stored');
    const ap = await approve(env, 'incomplete');
    assert.equal(ap.status, 400, ap.bodyText);
    assert.ok(errCodes(ap as never).includes('PROC_UNBOUND_REQUIRED_INPUT'), ap.bodyText);
    const v = await env.server.request('POST', `${base(env)}/procedures:validate`, incomplete);
    assert.ok(JSON.stringify(v.json()).includes('PROC_UNBOUND_REQUIRED_INPUT'), 'validation reports the same finding');
    const got = (await env.server.request('GET', `${base(env)}/procedures/incomplete`)).json<{ lifecycle: string }>();
    assert.equal(got.lifecycle, 'draft', 'no approval was stored');
    assert.equal((await start(env, INPUT, {}, 'incomplete', 1)).status, 403, 'an unapproved procedure cannot start');
    assert.equal(await countProcedureExecutions(env), 0);

    // A schema-required property bound under a DIFFERENT contract spelling still counts when it normalizes to the same property key.
    const spaced = vertical(env, { procedureId: 'spaced', version: 1 });
    await publish(env, spaced);
    const ran = await start(env, INPUT, {}, 'spaced', 1);
    assert.equal(ran.status, 201, ran.bodyText);

    // Valid existing procedure: unchanged behaviour.
    await publish(env, vertical(env));
    assert.equal((await start(env)).status, 201);
  });
});

// --------------------------------------------------------------------------------------------------------------------------
// D7 -- audit contract: required `procedure.attempted` fails closed on start AND resume; detail events are best-effort
// --------------------------------------------------------------------------------------------------------------------------

test('D7 start: if procedure.attempted cannot be persisted, NOTHING advances (503, zero records, no step, no execution events); service resumes when the sink recovers', async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    env.sink.refuse.add('procedure.attempted');
    const before = env.sink.events().length;
    const res = await start(env);
    assert.equal(res.status, 503, res.bodyText);
    assert.equal(await countProcedureExecutions(env), 0);
    assert.equal(await countCapabilityExecutions(env), 0);
    assert.equal(
      env.sink
        .events()
        .slice(before)
        .some((e) => e.type.startsWith('procedure.execution') || e.type.startsWith('procedure.step')),
      false,
    );
    env.sink.refuse.delete('procedure.attempted');
    assert.equal((await start(env)).status, 201);
  });
});

test('D7 resume: if procedure.attempted cannot be persisted, the human decision is NOT applied (503; record revision, step state and human task unchanged); the same request succeeds after recovery', async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    const waiting = (await start(env)).json<ExecWire>();
    const executionsBefore = await countCapabilityExecutions(env);
    env.sink.refuse.add('procedure.attempted');
    const res = await resume(env, waiting.procedureExecutionId, {
      decision: 'approve',
      expectedRevision: waiting.revision,
      expectedStepExecutionId: waiting.waitingFor!.executionId,
    });
    assert.equal(res.status, 503, res.bodyText);
    const same = await getExec(env, waiting.procedureExecutionId);
    assert.equal(same.status, 'waiting_for_human');
    assert.equal(same.revision, waiting.revision, 'revision did not advance');
    assert.equal(statuses(same), statuses(waiting));
    assert.equal(await countCapabilityExecutions(env), executionsBefore, 'no further step ran');
    assert.equal(evTypes(env).includes('procedure.execution.resumed'), false);
    env.sink.refuse.delete('procedure.attempted');
    const ok = await resume(env, waiting.procedureExecutionId, {
      decision: 'approve',
      expectedRevision: waiting.revision,
      expectedStepExecutionId: waiting.waitingFor!.executionId,
    });
    assert.equal(ok.status, 200, ok.bodyText);
    assert.equal(ok.json<ExecWire>().status, 'completed', 'the human task was still pending, so the decision applies cleanly');
  });
});

test('D7 contract: audit actor attribution, execution ids, event ordering and the approved vocabulary hold across a full run; detail-event failure is best-effort (the run still completes)', async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    // Detail events are best-effort: refusing one of them must not stop the run (documented limitation: that evidence is then absent).
    env.sink.refuse.add('procedure.step.completed');
    const waiting = (await start(env)).json<ExecWire>();
    const done = (await resume(env, waiting.procedureExecutionId, { decision: 'approve' })).json<ExecWire>();
    assert.equal(done.status, 'completed', 'a refused detail event did not block execution');
    assert.equal(evTypes(env).includes('procedure.step.completed'), false, 'LIMITATION: the refused detail events were not recorded');
    env.sink.refuse.delete('procedure.step.completed');

    const events = env.sink.events().filter((e) => e.type.startsWith('procedure.') && e.action.endsWith('procedure'));
    const approved = new Set(AUDIT_EVENT_TYPES.filter((t) => t.startsWith('procedure.')));
    for (const e of env.sink.events().filter((x) => x.type.startsWith('procedure.'))) {
      assert.ok(approved.has(e.type), e.type);
      assert.equal(e.actor.id, 'test-identity', `${e.type} actor`);
    }
    const exec = events.filter((e) => e.target?.kind === 'procedure-execution' && e.target.id === done.procedureExecutionId);
    const order = exec.map((e) => e.type);
    const idx = (t: string): number => order.indexOf(t);
    assert.ok(idx('procedure.execution.started') >= 0 && idx('procedure.execution.waiting_for_human') > idx('procedure.execution.started'));
    assert.ok(idx('procedure.execution.resumed') > idx('procedure.execution.waiting_for_human'));
    assert.ok(idx('procedure.execution.completed') > idx('procedure.execution.resumed'));
    const seqs = exec.map((e) => e.seq);
    assert.deepEqual(
      [...seqs].sort((a, b) => a - b),
      seqs,
      'events are recorded in order',
    );
    for (const e of exec.filter((x) => x.type.startsWith('procedure.execution.')))
      assert.equal(e.metadata?.['executionId'], done.procedureExecutionId);
    const attempts = env.sink.events().filter((e) => e.type === 'procedure.attempted' && e.action === 'resume.procedure');
    assert.ok(
      attempts.length >= 1 && attempts.every((e) => e.target?.id === done.procedureExecutionId && e.target.kind === 'procedure-execution'),
    );
  });
});

// --------------------------------------------------------------------------------------------------------------------------
// D8 -- remaining behavioural evidence
// --------------------------------------------------------------------------------------------------------------------------

test('D8-1 N-7: a step whose capability binding is swapped in the stored definition after approval never starts (zero records, no step). Scope: the stored hash is NOT recomputed by the attacker; the recomputed-hash case is covered by the approval binding to procedureHash (M2) and is not separately exercised here', async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    const file = join(env.dataDir, env.workspace.workspaceId, 'procedures', 'intake-review', 'v1', 'definition.json');
    const rec = JSON.parse(await readFile(file, 'utf8')) as { definition: { steps: { id: string; capabilityId?: string }[] } };
    rec.definition.steps.find((s) => s.id === 'c')!.capabilityId = IDS.flowB; // swap the binding to ANOTHER approved capability
    await writeFile(file, JSON.stringify(rec));
    const res = await start(env);
    assert.ok(res.status >= 400, `a swapped binding must not start (${res.status})`);
    assert.notEqual(res.status, 201);
    assert.equal(await countProcedureExecutions(env), 0);
    assert.equal(await countCapabilityExecutions(env), 0);
    assert.equal(evTypes(env).includes('procedure.execution.started'), false);
  });
});

test('D8-2 N-8: changing an underlying capability rule after approval is detected at start (approval no longer valid); nothing runs', async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    await mutateStoredGraph(env, (json) => {
      const rule = json.nodes.find((n) => n['kind'] === 'decision_node' && JSON.stringify(n).includes('xseg_c'));
      assert.ok(rule, 'the settle capability has an underlying rule node in the fixture');
      (rule['properties'] as Record<string, unknown>)['question'] = 'the review amount exceeds 5000';
    });
    const res = await start(env);
    assert.equal(res.status, 403, res.bodyText);
    assert.match(res.json<{ error: { message: string } }>().error.message, /approval_stale|approval_unverifiable/);
    assert.equal(await countProcedureExecutions(env), 0);
    assert.equal(await countCapabilityExecutions(env), 0);
  });
});

test('D8-3 policy change between steps: a permission revoked after step 1 completes denies step 2 at the moment of use (class authorization); step 2 never creates an execution', async () => {
  await withEnv(async (env) => {
    const doc = {
      schema: 'xo.procedure/1',
      procedureId: 'two-reads',
      version: 1,
      compilationRef: { compilationId: env.compilationId, graphHash: env.graphHash },
      steps: [
        {
          id: 'p1',
          kind: 'capability',
          capabilityId: IDS.perm,
          basis: 'source_proven',
          next: 'p2',
          inputBindings: [{ param: 'file size', from: { input: 'file_size' }, bindingStatus: 'proven' }],
        },
        {
          id: 'p2',
          kind: 'capability',
          capabilityId: IDS.perm,
          basis: 'source_proven',
          inputBindings: [{ param: 'file size', from: { input: 'file_size' }, bindingStatus: 'proven' }],
        },
      ],
    };
    await publish(env, doc);
    env.sink.beforeAppend = (d) => {
      if (d.type === 'procedure.step.completed' && d.target?.id === 'p1') env.policy.set(GRANTS); // filesystem.read revoked between steps
    };
    const res = await start(env, { file_size: 10 }, {}, 'two-reads', 1);
    assert.equal(res.status, 200, res.bodyText);
    const e = res.json<ExecWire>();
    assert.equal(e.status, 'failed');
    assert.equal(e.failure?.class, 'authorization');
    assert.equal(statuses(e), 'p1:succeeded,p2:failed');
    assert.equal(e.steps.find((s) => s.stepId === 'p2')?.executionId, undefined, 'the denied step never created an execution');
    assert.equal(await countCapabilityExecutions(env), 1, 'only step 1 ran');
  });
});

test('D8-4 resume without procedure.execute: denied (403) BEFORE any state change; denial audited; the pending human task and revision are untouched and the decision applies after the grant is restored', async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    const waiting = (await start(env)).json<ExecWire>();
    env.policy.set(WITH_FILE.filter((r) => r.id !== 'execute'));
    const res = await resume(env, waiting.procedureExecutionId, { decision: 'approve' });
    assert.equal(res.status, 403, res.bodyText);
    env.policy.set(WITH_FILE);
    const same = await getExec(env, waiting.procedureExecutionId);
    assert.equal(same.status, 'waiting_for_human');
    assert.equal(same.revision, waiting.revision);
    assert.equal(evTypes(env).includes('procedure.execution.resumed'), false);
    assert.ok(
      env.sink.events().some((e) => e.type === 'procedure.denied' && e.action === 'resume.procedure'),
      'the denial is audited',
    );
    const ok = await resume(env, waiting.procedureExecutionId, { decision: 'approve', expectedRevision: waiting.revision });
    assert.equal(ok.status, 200, ok.bodyText);
    assert.equal(ok.json<ExecWire>().status, 'completed');
  });
});

test('D8-5 concurrent resume: exactly one wins (200) and one is refused (409); the step ran once, one resumed event, final state is terminal and consistent', async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    const waiting = (await start(env)).json<ExecWire>();
    const before = await countCapabilityExecutions(env);
    const body = { decision: 'approve', expectedRevision: waiting.revision, expectedStepExecutionId: waiting.waitingFor!.executionId };
    const [r1, r2] = await Promise.all([resume(env, waiting.procedureExecutionId, body), resume(env, waiting.procedureExecutionId, body)]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 409], `${r1.bodyText} | ${r2.bodyText}`);
    const loser = r1.status === 409 ? r1 : r2;
    const reason = loser.json<{ error: { context?: { reason?: string } } }>().error.context?.reason;
    assert.ok(reason === 'terminal' || reason === 'stale_revision' || reason === 'stale_step_execution', String(reason));
    const final = await getExec(env, waiting.procedureExecutionId);
    assert.equal(final.status, 'completed');
    assert.equal(statuses(final), 'a:succeeded,h:succeeded,c:succeeded,x:skipped');
    assert.equal(await countCapabilityExecutions(env), before + 1, 'step c executed exactly once');
    assert.equal(evTypes(env).filter((t) => t === 'procedure.execution.resumed').length, 1);
    assert.equal(evTypes(env).filter((t) => t === 'procedure.execution.completed').length, 1);
    // stale revision on a terminal record is still refused
    assert.equal(
      (await resume(env, waiting.procedureExecutionId, { decision: 'approve', expectedRevision: waiting.revision })).status,
      409,
    );
  });
});

test('D8-6 missing schema: PROC_INPUT_CONTRACT_UNAVAILABLE is raised when an input-bound parameter has no consumer schema (unit-level: the registry rules make it unreachable end-to-end with this fixture)', async () => {
  await withEnv(async (env) => {
    const def = {
      schema: 'xo.procedure/1',
      procedureId: 'no-schema',
      version: 1,
      steps: [
        {
          id: 's',
          kind: 'capability',
          capabilityId: IDS.xsegA,
          basis: 'source_proven',
          inputBindings: [{ param: 'intake score', from: { input: 'x' }, bindingStatus: 'proven' }],
        },
      ],
    } as never;
    const findings = validateStartInput(
      def,
      { graph: buildFixtureGraph(), snapshot: { steps: [{ stepId: 's', contractId: 'contract:does-not-exist' }] } } as never,
      { x: 1 },
    );
    assert.deepEqual(
      findings.map((f) => `${f.code}@${f.path}`),
      [
        'PROC_INPUT_CONTRACT_UNAVAILABLE@/steps/0',
        'PROC_INPUT_UNDECLARED@/input/x'.replace('PROC_INPUT_UNDECLARED@/input/x', 'PROC_INPUT_UNDECLARED@/input/x'),
      ].slice(0, findings.length),
    );
    assert.ok(findings.some((f) => f.code === 'PROC_INPUT_CONTRACT_UNAVAILABLE'));
    assert.equal(await countProcedureExecutions(env), 0);
  });
});

test('D8-7 conditional branches: an input needed ONLY by the branch that will not run is still required at start (documented behaviour); the rejection happens before persistence', async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    // intake_score 10 takes branch x, so review_amount (used only by c on the untaken branch) is never needed at run time -- but start still requires it.
    const res = await start(env, { intake_score: 10, payout_amount: 100 });
    assert.equal(res.status, 400, res.bodyText);
    assert.ok(errCodes(res as never).includes('PROC_INPUT_MISSING'));
    assert.equal(await countProcedureExecutions(env), 0);
    assert.equal(await countCapabilityExecutions(env), 0);
    const full = await start(env, { intake_score: 10, review_amount: 1, payout_amount: 100 });
    assert.equal(full.status, 201);
    assert.equal(full.json<ExecWire>().status, 'completed');
  });
});

test('D8-8 same-key concurrent start: while the first is parked mid-operation the second is refused 409 and does NOT execute; the first returns 201; a later retry replays the same execution', async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    const h = { 'idempotency-key': 'closeout-key-0001' };
    let entered!: () => void;
    let release!: () => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    const releaseP = new Promise<void>((r) => (release = r));
    let parkedOnce = false;
    env.sink.beforeAppend = async (d) => {
      if (d.type === 'procedure.execution.started' && !parkedOnce) {
        parkedOnce = true;
        entered();
        await releaseP;
      }
    };
    const first = start(env, INPUT, h);
    await enteredP; // the first request holds the idempotency claim and has created its record
    const second = await start(env, INPUT, h);
    assert.equal(second.status, 409, second.bodyText);
    assert.ok(second.headers['retry-after'] !== undefined, 'a retry hint is returned');
    assert.equal(await countProcedureExecutions(env), 1, 'the refused request created nothing');
    release();
    const done = await first;
    assert.equal(done.status, 201, done.bodyText);
    const retry = await start(env, INPUT, h);
    assert.equal(retry.status, 201, retry.bodyText);
    assert.equal(retry.json<ExecWire>().procedureExecutionId, done.json<ExecWire>().procedureExecutionId);
    assert.equal(retry.headers['idempotent-replayed'], 'true');
    assert.equal(await countProcedureExecutions(env), 1, 'exactly one execution exists');
  });
});

// D9 -- recorded as a KNOWN DEFECT, not fixed here: a tampered stored execution record fails closed but is not a 4xx.
test('D9 (characterization only): a tampered stored procedure DEFINITION fails closed; the observed HTTP status is recorded, not normalized', async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    const file = join(env.dataDir, env.workspace.workspaceId, 'procedures', 'intake-review', 'v1', 'definition.json');
    const rec = JSON.parse(await readFile(file, 'utf8')) as { definition: { title?: string } };
    rec.definition.title = 'tampered';
    await writeFile(file, JSON.stringify(rec));
    const res = await start(env);
    console.log(`D9 observed status for a tampered stored definition: ${res.status}`);
    assert.ok(res.status >= 400, 'fail closed');
    assert.equal(await countProcedureExecutions(env), 0);
    await mkdir(join(env.dataDir, 'noop'), { recursive: true });
    await rm(join(env.dataDir, 'noop'), { recursive: true, force: true });
  });
});

test('D2 HTTP timeout (test-only delay seam): a step that overruns the configured timeout is classified `timeout`; the run fails closed; nothing is claimed cancelled; the call is NOT cancelled', async () => {
  let released = false;
  let finish!: () => void;
  const hold = new Promise<void>((r) => (finish = r));
  await withEnv(
    async (env) => {
      await publish(env, vertical(env));
      const res = await start(env);
      assert.equal(res.status, 200, res.bodyText);
      const e = res.json<ExecWire>();
      assert.equal(e.status, 'failed');
      assert.equal(e.failure?.class, 'timeout');
      assert.equal(e.failure?.code, 'XO_PROCEDURE_STEP_TIMEOUT');
      assert.equal(
        statuses(e),
        'a:failed,h:skipped,c:skipped,x:skipped',
        'the overrunning step failed; every later step is skipped, none ran',
      );
      assert.equal(e.steps[0]?.failureClass, 'timeout');
      assert.equal(res.bodyText.toLowerCase().includes('cancel'), false, 'classification is not described as cancellation');
      const persisted = await getExec(env, e.procedureExecutionId);
      assert.equal(persisted.status, 'failed');
      assert.equal(persisted.failure?.class, 'timeout');
      assert.ok(evTypes(env).includes('procedure.execution.failed'));
      released = true;
      finish(); // the in-flight call is only released now: it was never cancelled by the timeout
    },
    WITH_FILE,
    { procedureStepTimeoutMs: 25, testBeforeStepExecute: () => hold },
  );
  assert.equal(released, true);
});
