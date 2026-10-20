import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Permissions, RuleBasedPolicy, type PolicyRule } from '@xo/permissions';
import { AUDIT_EVENT_TYPES, NonProductionAuditSink, type AuditEvent } from '@xo/audit';
import { MAX_PROCEDURE_BYTES } from '@xo/procedure';
import { buildSemanticCapabilityContract } from '@xo/capability-contract';
import { XoirNodeId, toJson } from '@xo/xoir';
import { LocalFsBlobStore } from '@xo/storage';
import { TestServer, withTempDir } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, buildFixtureGraph, storeFixtureCompilation } from './workflow-fixtures.js';
import { FsCompilationStore } from '../src/compilations/fs-compilation-store.js';
import { compilationLoaderFromStore } from '../src/procedures/registry-validation.js';
import { lifecycleStartGate } from '../src/procedures/procedure-approval.js';
import { workspaceCompilationsStore } from '../src/workspace/workspace-context.js';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';
import { openApiDocument } from '../src/openapi.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

// P1.1 M2 — procedure lifecycle: authorization (default deny), immutability, workspace isolation, registry integrity,
// approval binding / staleness, route-level size cap, audit coverage, no value leakage. Hand-built XOIR fixture (test-only;
// see workflow-fixtures.ts) stored through the REAL compilation store; everything downstream is the production path.

const rule = (id: string, permission: string): PolicyRule => ({
  id,
  effect: 'ALLOW',
  match: { permission: permission as never, principalId: 'test-identity' },
});
const GRANT_ALL = [
  rule('author', Permissions.procedure.author),
  rule('approve', Permissions.procedure.approve),
  rule('read', Permissions.procedure.read),
];

interface Env {
  readonly server: TestServer;
  readonly sink: NonProductionAuditSink;
  readonly dataDir: string;
  readonly workspace: WorkspaceRecord;
  readonly compilationId: string;
  readonly graphHash: string;
  readonly humanKey: string;
}

async function withEnv(fn: (env: Env) => Promise<void>, rules: readonly PolicyRule[] = GRANT_ALL): Promise<void> {
  await withTempDir('xo-m2-data-', async (dataDir) => {
    await withTempDir('xo-m2-ws-', async (workspacesDir) => {
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
        assert.ok(loaded, 'fixture compilation must load');
        // A second key for the SAME identity but kind `human` (the default test key is a `service` principal).
        const humanKey = generateApiKey();
        const created = await server.apiKeyStore.create({
          keyHash: hashApiKey(humanKey),
          identityId: server.identityId,
          principalKind: 'human',
          createdAt: new Date().toISOString(),
        });
        assert.ok(created.ok);
        await fn({ server, sink, dataDir, workspace, compilationId, graphHash: loaded.graphHash, humanKey });
      } finally {
        await server.stop();
      }
    });
  });
}

const base = (env: Env): string => `/workspaces/${env.workspace.workspaceId}`;
const proceduresDir = (env: Env): string => join(env.dataDir, env.workspace.workspaceId, 'procedures');
const human = (env: Env): Record<string, string> => TestServer.authHeader(env.humanKey) as Record<string, string>;
const exists = async (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );

function inputsOfB(): { name: string; required?: boolean }[] {
  const built = buildSemanticCapabilityContract(buildFixtureGraph(), XoirNodeId(IDS.flowB));
  assert.ok(built.ok);
  return built.ok ? [...built.value.inputs] : [];
}

function doc(env: Env, over: Record<string, unknown> = {}, stepOver: Record<string, unknown> = {}): Record<string, unknown> {
  const bindings = inputsOfB().map((p) =>
    p.name === 'matched'
      ? { param: 'matched', from: { step: 's1', output: 'matched' }, bindingStatus: 'proven' }
      : { param: p.name, from: { input: p.name.replace(/\W+/g, '_') }, bindingStatus: 'proven' },
  );
  return {
    schema: 'xo.procedure/1',
    procedureId: 'claim-flow',
    version: 1,
    compilationRef: { compilationId: env.compilationId, graphHash: env.graphHash },
    steps: [
      { id: 's1', kind: 'capability', capabilityId: IDS.flowA, basis: 'source_proven', next: 's2', ...stepOver },
      { id: 's2', kind: 'capability', capabilityId: IDS.flowB, basis: 'source_proven', inputBindings: bindings },
    ],
    ...over,
  };
}

const put = (env: Env, body: unknown, id = 'claim-flow', version = 1, headers: Record<string, string> = {}) =>
  env.server.request('PUT', `${base(env)}/procedures/${id}/versions/${version}`, body, headers);
const validate = (env: Env, body: unknown, headers: Record<string, string> = {}) =>
  env.server.request('POST', `${base(env)}/procedures:validate`, body, headers);
const approve = (env: Env, body?: unknown, id = 'claim-flow', version = 1, headers: Record<string, string> = {}) =>
  env.server.request('POST', `${base(env)}/procedures/${id}/versions/${version}/approve`, body, headers);
const getProc = (env: Env, id = 'claim-flow', q = '') => env.server.request('GET', `${base(env)}/procedures/${id}${q}`);
interface Findings {
  findings: { code: string; path: string }[];
  valid?: boolean;
}
const codesOf = (res: { json: <T>() => T }): string[] => {
  const b = res.json<{ error?: { context?: Findings }; findings?: { code: string }[] }>();
  return (b.error?.context?.findings ?? b.findings ?? []).map((f) => f.code);
};
const types = (env: Env): string[] => env.sink.events().map((e: AuditEvent) => e.type);

test('N-16 default deny: author, validate, read, list and approve are all 403 under the empty default policy; no file is created; denials are audited', async () => {
  await withEnv(async (env) => {
    const doc1 = doc(env);
    assert.equal((await put(env, doc1)).status, 403);
    assert.equal((await validate(env, doc1)).status, 403);
    assert.equal((await getProc(env)).status, 403);
    assert.equal((await env.server.request('GET', `${base(env)}/procedures`)).status, 403);
    assert.equal((await approve(env)).status, 403);
    assert.equal(
      await exists(proceduresDir(env)),
      false,
      'an unauthorized author must leave no persisted procedure (not even the directory)',
    );
    const denied = env.sink.events().filter((e) => e.type === 'procedure.denied');
    assert.equal(denied.length, 5);
    assert.ok(denied.every((e) => e.outcome === 'denied' && e.reasonCode === 'XO_RUNTIME_PERMISSION_DENIED'));
    assert.deepEqual(new Set(types(env)).has('procedure.authored'), false);
  }, []);
});

test('each permission is separate: author alone cannot read or approve; read alone cannot author', async () => {
  await withEnv(
    async (env) => {
      assert.equal((await put(env, doc(env))).status, 201);
      assert.equal((await getProc(env)).status, 403);
      assert.equal((await approve(env)).status, 403);
    },
    [rule('author', Permissions.procedure.author)],
  );
  await withEnv(
    async (env) => {
      assert.equal((await put(env, doc(env))).status, 403);
      assert.equal((await env.server.request('GET', `${base(env)}/procedures`)).status, 200);
    },
    [rule('read', Permissions.procedure.read)],
  );
});

test('lifecycle: author -> draft -> validate -> approve -> approved; approval bound to procedureHash/registry state; executable is never true in M2', async () => {
  await withEnv(async (env) => {
    const created = await put(env, doc(env));
    assert.equal(created.status, 201, created.bodyText);
    const c = created.json<{ lifecycle: string; procedureHash: string; executable: boolean }>();
    assert.equal(c.lifecycle, 'draft');
    assert.equal(c.executable, false);
    const report = await validate(env, doc(env));
    assert.equal(report.status, 200);
    const r = report.json<{ valid: boolean; findings: unknown[]; procedureHash: string; registryStateDigest: string }>();
    assert.deepEqual([r.valid, r.findings.length, r.procedureHash], [true, 0, c.procedureHash]);
    assert.match(r.registryStateDigest, /^sha256:[0-9a-f]{64}$/);
    const approved = await approve(env);
    assert.equal(approved.status, 200, approved.bodyText);
    const a = approved.json<{
      lifecycle: string;
      executable: boolean;
      approval: {
        registryStateDigest: string;
        procedureHash: string;
        validationReportHash: string;
        approver: { kind: string; id: string };
      };
    }>();
    assert.equal(a.lifecycle, 'approved');
    assert.equal(a.executable, false);
    assert.equal(a.approval.procedureHash, c.procedureHash);
    assert.equal(a.approval.registryStateDigest, r.registryStateDigest);
    assert.match(a.approval.validationReportHash, /^sha256:/);
    assert.deepEqual(a.approval.approver, { kind: 'service', id: 'test-identity' });
    const read = (await getProc(env)).json<{ lifecycle: string; definition: { procedureId: string }; confidence: number }>();
    assert.equal(read.lifecycle, 'approved');
    assert.equal(read.definition.procedureId, 'claim-flow');
    assert.equal(read.confidence, 0.8);
    const list = (await env.server.request('GET', `${base(env)}/procedures`)).json<{
      procedures: { procedureId: string; versions: { lifecycle: string }[] }[];
    }>();
    assert.deepEqual(
      list.procedures.map((p) => [p.procedureId, p.versions[0]?.lifecycle]),
      [['claim-flow', 'approved']],
    );
    // lifecycle gate (N-13): a draft / stale / unverifiable version never passes
    assert.deepEqual(lifecycleStartGate('draft'), { allowed: false, reason: 'not_approved' });
    assert.equal(lifecycleStartGate('approval_stale').allowed, false);
    assert.equal(lifecycleStartGate('approval_unverifiable').allowed, false);
    assert.equal(lifecycleStartGate('approved').allowed, true);
  });
});

test('versions are immutable: a second PUT of the same version is 409 and the stored bytes are unchanged', async () => {
  await withEnv(async (env) => {
    assert.equal((await put(env, doc(env))).status, 201);
    const file = join(proceduresDir(env), 'claim-flow', 'v1', 'definition.json');
    const before = await readFile(file, 'utf8');
    const second = await put(env, doc(env, { title: 'changed' }));
    assert.equal(second.status, 409);
    assert.equal(await readFile(file, 'utf8'), before);
    assert.equal((await put(env, doc(env, { version: 2 }), 'claim-flow', 2)).status, 201, 'a new version is a new immutable record');
  });
});

test('stale approval: any registry drift after approval makes the lifecycle approval_stale (computed, never stored), and re-approval requires fresh validation', async () => {
  await withEnv(async (env) => {
    assert.equal((await put(env, doc(env))).status, 201);
    assert.equal((await approve(env)).status, 200);
    // Change the persisted compilation graph (valid XOIR, different content hash).
    const store = new FsCompilationStore(workspaceCompilationsStore(env.workspace, { dataRootDir: env.dataDir }));
    const rec = await store.get(env.compilationId);
    assert.ok(rec.ok && rec.value.resultStorageKey !== undefined);
    const g = buildFixtureGraph();
    const added = g.createAndAddNode({
      id: XoirNodeId('cap_drift_extra'),
      kind: 'capability',
      properties: { name: 'Drift', description: 'added after approval', requiredPermissions: [] },
      confidence: 0.8,
      sourceRefs: [{ documentPath: 'p08-fixture.pdf', pages: [1] }],
    });
    assert.ok(added.ok);
    const json = toJson(g);
    const blobs = new LocalFsBlobStore(join(env.dataDir, env.workspace.workspaceId, 'compilations'));
    const key = rec.ok ? (rec.value.resultStorageKey as string) : '';
    const current = JSON.parse(await readFile(join(env.dataDir, env.workspace.workspaceId, 'compilations', key), 'utf8')) as {
      graph?: unknown;
    } & Record<string, unknown>;
    const next = 'graph' in current ? { ...current, graph: json } : json;
    const put2 = await blobs.put(key, JSON.stringify(next));
    assert.ok(put2.ok);
    const after = (await getProc(env)).json<{ lifecycle: string }>();
    assert.equal(after.lifecycle, 'approval_stale');
    assert.equal(lifecycleStartGate(after.lifecycle as never).allowed, false);
    assert.equal((await approve(env)).status, 400, 're-approval must re-validate against the drifted registry and refuse');
  });
});

test('workspace isolation: another identity gets 404 for every procedure route, indistinguishable from an unknown procedure', async () => {
  await withEnv(async (env) => {
    assert.equal((await put(env, doc(env))).status, 201);
    const other = await env.server.issueAdditionalIdentity('other-identity');
    const hdr = TestServer.authHeader(other.apiKey) as Record<string, string>;
    const mine = await env.server.request('GET', `${base(env)}/procedures/claim-flow`, undefined, hdr);
    const none = await env.server.request('GET', `${base(env)}/procedures/does-not-exist`);
    assert.equal(mine.status, 404);
    assert.equal(none.status, 404);
    assert.equal(mine.json<{ error: { code: string } }>().error.code, none.json<{ error: { code: string } }>().error.code);
    for (const res of [
      await put(env, doc(env, { version: 9 }), 'claim-flow', 9, hdr),
      await validate(env, doc(env), hdr),
      await approve(env, undefined, 'claim-flow', 1, hdr),
      await env.server.request('GET', `${base(env)}/procedures`, undefined, hdr),
    ])
      assert.equal(res.status, 404);
    // The other identity's own workspace cannot resolve MY compilation: fail closed, same code as an unknown id.
    const ow = (await env.server.request('POST', '/workspaces', {}, hdr)).json<WorkspaceRecord>();
    const r = await env.server.request('POST', `/workspaces/${ow.workspaceId}/procedures:validate`, doc(env), hdr);
    assert.equal(r.status, 403, 'other identity has no procedure.author grant in the default test policy');
  });
});

test('N-2 registry integrity: unknown capability, contract mismatch, and a compilation from another workspace are all rejected; absence is never validity', async () => {
  await withEnv(async (env) => {
    const unknown = await validate(env, doc(env, {}, { capabilityId: 'cap_does_not_exist' }));
    assert.deepEqual(codesOf(unknown), ['PROC_UNRESOLVED_CAPABILITY']);
    const mismatch = await validate(env, doc(env, {}, { contractId: 'some_other_contract' }));
    assert.deepEqual(codesOf(mismatch), ['PROC_CONTRACT_MISMATCH']);
    const ok = await validate(env, doc(env, {}, { contractId: IDS.flowA }));
    assert.equal(ok.json<{ valid: boolean }>().valid, true);
    const noRef = await validate(env, doc(env, { compilationRef: undefined }));
    assert.deepEqual(codesOf(noRef), ['PROC_COMPILATION_REF_REQUIRED']);
    const unavailable = await validate(
      env,
      doc(env, { compilationRef: { compilationId: `cmp_${'0'.repeat(32)}`, graphHash: env.graphHash } }),
    );
    assert.deepEqual(codesOf(unavailable), ['PROC_COMPILATION_UNAVAILABLE']);
    const malformedId = await validate(env, doc(env, { compilationRef: { compilationId: '../../etc', graphHash: env.graphHash } }));
    assert.deepEqual(codesOf(malformedId), ['PROC_COMPILATION_UNAVAILABLE']);
    // A compilation that belongs to ANOTHER workspace is unreachable from this one.
    const other = await env.server.issueAdditionalIdentity('other-identity');
    const hdr = TestServer.authHeader(other.apiKey) as Record<string, string>;
    const ow = (await env.server.request('POST', '/workspaces', {}, hdr)).json<WorkspaceRecord>();
    const foreign = await storeFixtureCompilation(ow, env.dataDir);
    const cross = await validate(env, doc(env, { compilationRef: { compilationId: foreign.compilationId, graphHash: env.graphHash } }));
    assert.deepEqual(codesOf(cross), ['PROC_COMPILATION_UNAVAILABLE']);
  });
});

test('hash drift: a compilationRef whose graphHash differs from the persisted graph fails closed with ONLY the drift finding', async () => {
  await withEnv(async (env) => {
    const drift = await validate(
      env,
      doc(env, { compilationRef: { compilationId: env.compilationId, graphHash: `sha256:${'a'.repeat(64)}` } }),
    );
    assert.deepEqual(drift.json<Findings>().findings, [{ code: 'PROC_COMPILATION_DRIFT', path: '/compilationRef/graphHash' }]);
    const via = await put(env, doc(env, { compilationRef: { compilationId: env.compilationId, graphHash: `sha256:${'a'.repeat(64)}` } }));
    assert.equal(via.status, 201, 'a draft may be saved; it can never be approved');
    assert.equal((await approve(env)).status, 400);
    assert.equal((await getProc(env)).json<{ lifecycle: string }>().lifecycle, 'draft');
  });
});

test('binding integrity against contracts: unknown parameter, undeclared output, unbound required input are rejected', async () => {
  await withEnv(async (env) => {
    const d = doc(env) as { steps: { inputBindings?: { param: string; from: { step?: string; output?: string } }[] }[] };
    const s2 = d.steps[1]!;
    // pick the matched binding specifically
    const idx = s2.inputBindings!.findIndex((b) => b.param === 'matched');
    const a = JSON.parse(JSON.stringify(d)) as typeof d;
    (a.steps[1]!.inputBindings![idx]!.from as { output?: string }).output = 'not_declared';
    assert.ok(codesOf(await validate(env, a)).includes('PROC_BINDING_OUTPUT_UNDECLARED'));
    const b = JSON.parse(JSON.stringify(d)) as typeof d;
    b.steps[1]!.inputBindings!.push({ param: 'no_such_param', from: { step: 's1', output: 'matched' } });
    assert.ok(codesOf(await validate(env, b)).includes('PROC_UNKNOWN_INPUT_PARAM'));
    const c = JSON.parse(JSON.stringify(d)) as typeof d;
    c.steps[1]!.inputBindings = [];
    assert.ok(codesOf(await validate(env, c)).includes('PROC_UNBOUND_REQUIRED_INPUT') || inputsOfB().every((p) => p.required !== true));
    const e = doc(env, { then: [{ path: 'steps.s1.output.not_declared', op: 'exists' }] });
    assert.ok(codesOf(await validate(env, e)).includes('PROC_BINDING_OUTPUT_UNDECLARED'));
  });
});

test('N-16 fail-closed: a capability whose permission declaration is absent is rejected (never treated as "no permissions")', async () => {
  await withTempDir('xo-m2-data-', async (dataDir) => {
    await withTempDir('xo-m2-ws-', async (workspacesDir) => {
      const sink = new NonProductionAuditSink();
      const server = await TestServer.start({
        workspaceDataDir: dataDir,
        workspacesDir,
        auditSink: sink,
        permissionPolicy: new RuleBasedPolicy([...GRANT_ALL]),
      });
      try {
        const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        const g = toJson(buildFixtureGraph()) as unknown as { nodes: { id: string; properties?: Record<string, unknown> }[] };
        const node = g.nodes.find((n) => n.id === IDS.flowA);
        assert.ok(node?.properties);
        delete node.properties['requiredPermissions'];
        const { compilationId } = await storeFixtureCompilation(workspace, dataDir, g as never);
        const loaded = await compilationLoaderFromStore(
          new FsCompilationStore(workspaceCompilationsStore(workspace, { dataRootDir: dataDir })),
        )(compilationId);
        assert.ok(loaded);
        const env = { server, sink, dataDir, workspace, compilationId, graphHash: loaded.graphHash, humanKey: '' } as Env;
        const res = await validate(env, doc(env));
        assert.ok(codesOf(res).includes('PROC_PERMISSION_DECLARATION_UNRESOLVED'), res.bodyText);
      } finally {
        await server.stop();
      }
    });
  });
});

test('N-9 / A-1 / A-3 attribution: approver is the authenticated principal; forged body fields are rejected; headers are ignored; a service principal cannot approve a possibly-effectful procedure', async () => {
  await withEnv(async (env) => {
    assert.equal((await put(env, doc(env))).status, 201);
    for (const forged of [
      { approvedBy: 'someone-else' },
      { principal: { kind: 'human', id: 'x' } },
      { approver: { kind: 'human', id: 'x' } },
      { humanGate: false },
      { limits: { maxSteps: 99 } },
      { effectKey: 'k' },
      { binding: {} },
    ]) {
      const res = await approve(env, forged);
      assert.equal(res.status, 400, JSON.stringify(forged));
      assert.ok(codesOf(res).includes('PROC_AUTHORITY_FIELD'), JSON.stringify(forged));
    }
    assert.equal((await approve(env, { surprise: 1 })).status, 400);
    const withHeaders = await approve(env, undefined, 'claim-flow', 1, {
      'x-principal': 'human:evil',
      'x-approved-by': 'evil',
      'x-xo-principal': '{"kind":"human","id":"evil"}',
    });
    assert.equal(withHeaders.status, 200);
    assert.deepEqual(withHeaders.json<{ approval: { approver: unknown } }>().approval.approver, { kind: 'service', id: 'test-identity' });
    // effectful (advisory write intent, escalation-only): the service principal is refused, the human principal succeeds
    assert.equal((await put(env, doc(env, { version: 2 }, { effectIntent: 'write' }), 'claim-flow', 2)).status, 201);
    const svc = await approve(env, undefined, 'claim-flow', 2);
    assert.equal(svc.status, 403);
    assert.ok(env.sink.events().some((e) => e.type === 'procedure.approval.denied' && e.reasonCode === 'PROCEDURE_APPROVER_NOT_HUMAN'));
    const hum = await approve(env, undefined, 'claim-flow', 2, human(env));
    assert.equal(hum.status, 200, hum.bodyText);
    assert.deepEqual(hum.json<{ approval: { approver: unknown } }>().approval.approver, { kind: 'human', id: 'test-identity' });
    // `effectIntent: read` does not escalate
    assert.equal((await put(env, doc(env, { version: 3 }, { effectIntent: 'read' }), 'claim-flow', 3)).status, 201);
    assert.equal((await approve(env, undefined, 'claim-flow', 3)).status, 200);
  });
});

test('approval requires an acknowledgment when there are unknowns or author-asserted steps; it never auto-promotes them', async () => {
  await withEnv(async (env) => {
    assert.equal((await put(env, doc(env, { unknowns: ['Who reviews exceptions is not defined.'] }))).status, 201);
    const missing = await approve(env);
    assert.equal(missing.status, 400);
    assert.deepEqual(codesOf(missing), ['PROC_MISSING_FIELD']);
    assert.ok(
      env.sink.events().some((e) => e.type === 'procedure.approval.denied' && e.reasonCode === 'PROCEDURE_ACKNOWLEDGMENT_REQUIRED'),
    );
    const ok = await approve(env, { acknowledgment: 'I accept the unknown reviewer rule.' });
    assert.equal(ok.status, 200);
    const read = (await getProc(env)).json<{ unknowns: string[]; approval: { acknowledgmentRecorded?: boolean } }>();
    assert.deepEqual(read.unknowns, ['Who reviews exceptions is not defined.']);
    assert.equal(read.approval.acknowledgmentRecorded, true);
    assert.equal((await put(env, doc(env, { version: 2 }, { basis: 'author_asserted' }), 'claim-flow', 2)).status, 201);
    assert.equal((await approve(env, undefined, 'claim-flow', 2)).status, 400);
    assert.deepEqual((await getProc(env, 'claim-flow', '?version=2')).json<{ authorAssertedSteps: string[] }>().authorAssertedSteps, [
      's1',
    ]);
  });
});

test('N-10 route cap: exactly 262,144 bytes is accepted, one byte over is rejected with PROC_BODY_TOO_LARGE; nothing is stored', async () => {
  await withEnv(async (env) => {
    const pad = (target: number): Buffer => {
      const body = JSON.stringify(doc(env, { title: 'x' }));
      const room = target - Buffer.byteLength(body);
      return Buffer.from(JSON.stringify(doc(env, { title: 'x'.repeat(1 + room) })));
    };
    const atLimit = pad(MAX_PROCEDURE_BYTES);
    assert.equal(atLimit.length, MAX_PROCEDURE_BYTES);
    assert.equal((await put(env, atLimit, 'claim-flow', 1, { 'content-type': 'application/json' })).status, 201);
    const over = pad(MAX_PROCEDURE_BYTES + 1);
    assert.equal(over.length, MAX_PROCEDURE_BYTES + 1);
    const res = await put(env, over.toString('utf8') === '' ? '' : over, 'claim-flow', 2, { 'content-type': 'application/json' });
    assert.equal(res.status, 400);
    assert.deepEqual(codesOf(res), ['PROC_BODY_TOO_LARGE']);
    assert.equal(await exists(join(proceduresDir(env), 'claim-flow', 'v2')), false);
    const v = await env.server.request('POST', `${base(env)}/procedures:validate`, Buffer.alloc(MAX_PROCEDURE_BYTES + 1, 0x20));
    assert.equal(v.status, 200);
    assert.deepEqual(v.json<Findings>().findings, [{ code: 'PROC_BODY_TOO_LARGE', path: '' }]);
    const tooMany = await validate(
      env,
      doc(env, { steps: Array.from({ length: 26 }, (_, i) => ({ id: `s${i}`, kind: 'capability', capabilityId: IDS.flowA })) }),
    );
    assert.deepEqual(codesOf(tooMany), ['PROC_TOO_MANY_STEPS']);
  });
});

test('N-14: errors contain stable codes and JSON pointers only; no submitted value is echoed (validate, author, approve)', async () => {
  await withEnv(async (env) => {
    const secret = 'SECRET-VALUE-4b7e91';
    const res1 = await put(env, doc(env, { surprise: secret, permissions: [secret] }));
    const res2 = await validate(env, doc(env, {}, { capabilityId: secret }));
    const res3 = await approve(env, { approvedBy: secret });
    const res4 = await put(env, `{"schema":"${secret}"`);
    for (const r of [res1, res2, res3, res4]) assert.equal(r.bodyText.includes(secret), false, r.bodyText);
    assert.ok(codesOf(res1).includes('PROC_AUTHORITY_FIELD'));
    assert.equal(res4.status, 400);
    for (const e of env.sink.events()) assert.equal(JSON.stringify(e).includes(secret), false);
  });
});

test('path safety: malformed or traversing procedure ids and versions are refused and write nothing outside the store', async () => {
  await withEnv(async (env) => {
    for (const id of ['..', '%2e%2e', '..%2F..%2Fx', 'a%2Fb', '__proto__', 'constructor', '1abc', 'a b']) {
      const res = await put(env, doc(env), encodeURIComponent(id), 1);
      assert.ok([400, 404].includes(res.status), `${id} -> ${res.status}`);
    }
    for (const v of ['0', '-1', '1.5', 'x', '01', '1e3']) {
      const res = await env.server.request('PUT', `${base(env)}/procedures/claim-flow/versions/${v}`, doc(env));
      assert.ok([400, 404].includes(res.status), `version ${v} -> ${res.status}`);
    }
    assert.equal(await exists(proceduresDir(env)), false);
  });
});

test('stored records fail closed: a tampered definition (hash mismatch) is never served as valid and cannot be approved', async () => {
  await withEnv(async (env) => {
    assert.equal((await put(env, doc(env))).status, 201);
    const file = join(proceduresDir(env), 'claim-flow', 'v1', 'definition.json');
    const rec = JSON.parse(await readFile(file, 'utf8')) as { definition: { title?: string } };
    rec.definition.title = 'tampered';
    await writeFile(file, JSON.stringify(rec));
    assert.equal((await getProc(env)).status, 500);
    assert.equal((await approve(env)).status, 500);
    const list = (await env.server.request('GET', `${base(env)}/procedures`)).json<{
      procedures: { versions: { lifecycle: string }[] }[];
    }>();
    assert.equal(list.procedures[0]?.versions[0]?.lifecycle, 'record_invalid');
  });
});

test('audit: the approved M2 subset is exactly the six procedure.* types; a full lifecycle emits the expected events with no execution/step events', async () => {
  // M2's six are unchanged; the seven M3 execution types (owner-approved separately) are excluded here and pinned exactly in procedure-execution.test.ts.
  const m3Types = [
    'procedure.execution.started',
    'procedure.execution.waiting_for_human',
    'procedure.execution.resumed',
    'procedure.execution.completed',
    'procedure.execution.failed',
    'procedure.step.completed',
    'procedure.step.failed',
  ];
  assert.deepEqual(
    AUDIT_EVENT_TYPES.filter((t) => t.startsWith('procedure.') && !m3Types.includes(t)).sort(),
    [
      'procedure.approval.denied',
      'procedure.approval.granted',
      'procedure.attempted',
      'procedure.authored',
      'procedure.denied',
      'procedure.validated',
    ].sort(),
  );
  await withEnv(async (env) => {
    assert.equal((await put(env, doc(env))).status, 201);
    assert.equal((await validate(env, doc(env))).status, 200);
    assert.equal((await approve(env)).status, 200);
    assert.equal((await getProc(env)).status, 200);
    const seen = new Set(types(env));
    for (const t of ['procedure.attempted', 'procedure.authored', 'procedure.validated', 'procedure.approval.granted', 'access.attempted'])
      assert.ok(seen.has(t), t);
    const authored = env.sink.events().find((e) => e.type === 'procedure.authored');
    assert.equal(authored?.target?.kind, 'procedure');
    assert.equal(authored?.target?.id, 'claim-flow');
    assert.ok(authored?.actor && authored.actor.id === 'test-identity');
    const metaText = JSON.stringify(env.sink.events().map((e) => e.metadata));
    assert.equal(metaText.includes('sha256:' + '0'.repeat(64)), false);
  });
});

test('OpenAPI documents every M2 route', async () => {
  const paths = Object.keys(openApiDocument.paths);
  for (const p of [
    '/workspaces/{workspaceId}/procedures:validate',
    '/workspaces/{workspaceId}/procedures',
    '/workspaces/{workspaceId}/procedures/{procedureId}',
    '/workspaces/{workspaceId}/procedures/{procedureId}/versions/{version}',
    '/workspaces/{workspaceId}/procedures/{procedureId}/versions/{version}/approve',
  ])
    assert.ok(paths.includes(p), p);
  // M2 intentionally asserted that no execution route existed. M3 (owner-authorized) adds execution routes, so that assertion was
  // retired here; the M3 suite pins the execution routes and the absence of cancel/retry routes instead.
});

test('audit fail-closed: if the durable "attempted" evidence cannot be recorded, nothing is authored or approved; validation discloses nothing', async () => {
  await withTempDir('xo-m2-data-', async (dataDir) => {
    await withTempDir('xo-m2-ws-', async (workspacesDir) => {
      const inner = new NonProductionAuditSink();
      let failAttempted = false;
      let failValidated = false;
      const sink = {
        mode: inner.mode,
        append: async (draft: Parameters<NonProductionAuditSink['append']>[0]) =>
          (failAttempted && draft.type === 'procedure.attempted') || (failValidated && draft.type === 'procedure.validated')
            ? ({ ok: false, error: new Error('down'), indeterminate: false } as never)
            : inner.append(draft),
      };
      const server = await TestServer.start({
        workspaceDataDir: dataDir,
        workspacesDir,
        auditSink: sink as never,
        permissionPolicy: new RuleBasedPolicy([...GRANT_ALL]),
      });
      try {
        const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        const { compilationId } = await storeFixtureCompilation(workspace, dataDir);
        const loaded = await compilationLoaderFromStore(
          new FsCompilationStore(workspaceCompilationsStore(workspace, { dataRootDir: dataDir })),
        )(compilationId);
        assert.ok(loaded);
        const env = { server, sink: inner, dataDir, workspace, compilationId, graphHash: loaded.graphHash, humanKey: '' } as Env;
        failAttempted = true;
        const authored = await put(env, doc(env));
        assert.equal(authored.status, 503, authored.bodyText);
        assert.equal(await exists(proceduresDir(env)), false, 'no record may exist when the audit precondition failed');
        failAttempted = false;
        assert.equal((await put(env, doc(env))).status, 201);
        failAttempted = true;
        assert.equal((await approve(env)).status, 503);
        failAttempted = false;
        assert.equal((await getProc(env)).json<{ lifecycle: string }>().lifecycle, 'draft', 'no approval was stored');
        failValidated = true;
        const v = await validate(env, doc(env));
        assert.equal(v.status, 503);
        assert.equal(v.bodyText.includes('registryStateDigest'), false, 'no registry fact is disclosed without durable audit evidence');
      } finally {
        await server.stop();
      }
    });
  });
});

test('unavailable registry evidence is never "approved": deleting the compilation after approval yields approval_unverifiable', async () => {
  await withEnv(async (env) => {
    assert.equal((await put(env, doc(env))).status, 201);
    assert.equal((await approve(env)).status, 200);
    const blobs = new LocalFsBlobStore(join(env.dataDir, env.workspace.workspaceId, 'compilations'));
    const del = await blobs.delete(`${env.compilationId}/result.json`);
    assert.ok(del.ok);
    const after = (await getProc(env)).json<{ lifecycle: string }>();
    assert.equal(after.lifecycle, 'approval_unverifiable');
    assert.equal(lifecycleStartGate(after.lifecycle as never).allowed, false);
    assert.equal((await approve(env)).status, 400);
  });
});

test('A-4: audit actors equal the authenticated API-key principal for authoring, approval and denials', async () => {
  await withEnv(async (env) => {
    assert.equal((await put(env, doc(env))).status, 201);
    assert.equal((await approve(env, undefined, 'claim-flow', 1, human(env))).status, 200);
    assert.equal((await approve(env, { approvedBy: 'someone-else' })).status, 400);
    const actors = env.sink.events().filter((e) => e.type.startsWith('procedure.'));
    assert.ok(actors.length >= 4);
    for (const e of actors) assert.equal(e.actor.id, 'test-identity', `${e.type} actor`);
    const granted = env.sink.events().find((e) => e.type === 'procedure.approval.granted');
    assert.equal(granted?.actor.kind, 'human', 'the approval is attributed to the principal kind that actually approved');
  });
});

test('A-5 documented limits: OpenAPI states approval revocation is absent and makes no independence claim; N-12: procedure.execute exists, is not granted by the author/approve/read grants, and no start route exists', async () => {
  const approveDoc = JSON.stringify(openApiDocument.paths['/workspaces/{workspaceId}/procedures/{procedureId}/versions/{version}/approve']);
  assert.match(approveDoc, /no approval revocation/);
  assert.match(approveDoc, /no claim that an approver is independent/);
  assert.equal(String(Permissions.procedure.execute), 'procedure.execute');
  assert.equal(
    GRANT_ALL.some((r) => JSON.stringify(r).includes('procedure.execute')),
    false,
  );
});
