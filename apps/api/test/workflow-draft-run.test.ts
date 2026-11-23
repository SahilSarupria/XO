import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer, withTempDir } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, storeFixtureCompilation } from './workflow-fixtures.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

interface DraftWire {
  definitionId: string;
  revision: number;
  analysis: {
    runnable: boolean;
    wellFormed: boolean;
    errors: { message: string }[];
    blockers: { nodeId?: string; message: string }[];
    plan?: {
      compilationId: string;
      path: string[];
      steps: { capabilityId: string; executionClass: string; approved: boolean }[];
      branches: { taken: string; value: number }[];
    };
  };
}

interface Env {
  server: TestServer;
  workspace: WorkspaceRecord;
  compilationId: string;
  drafts: string;
}

async function withEnv(fn: (env: Env) => Promise<void>): Promise<void> {
  await withTempDir('xo-draft-data-', async (dataDir) =>
    withTempDir('xo-draft-ws-', async (workspacesDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir });
      try {
        const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        const { compilationId } = await storeFixtureCompilation(workspace, dataDir);
        await fn({ server, workspace, compilationId, drafts: `/workspaces/${workspace.workspaceId}/workflow-definitions` });
      } finally {
        await server.stop();
      }
    }),
  );
}

const cap = (env: Env, id: string, capabilityId: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'capability',
  config: { packageName: 'fixture', capabilityId, memoryScope: 'none', compilationId: env.compilationId, ...extra },
});
const manual = { id: 'start', kind: 'trigger', config: { type: 'manual' } };

async function save(env: Env, body: unknown): Promise<DraftWire> {
  const res = await env.server.request('POST', env.drafts, body);
  assert.equal(res.status, 201, res.bodyText);
  return res.json<DraftWire>();
}

const flowDraft = (env: Env) => ({
  name: 'flow',
  nodes: [manual, cap(env, 'a', IDS.flowA), cap(env, 'b', IDS.flowB)],
  edges: [
    { from: 'start', to: 'a' },
    { from: 'a', to: 'b' },
  ],
});

test('analysis resolves the plan from the stored compilation and says runnable only then', async () => {
  await withEnv(async (env) => {
    const ok = await save(env, flowDraft(env));
    assert.equal(ok.analysis.runnable, true, JSON.stringify(ok.analysis));
    assert.deepEqual(
      ok.analysis.plan?.steps.map((s) => [s.capabilityId, s.executionClass, s.approved]),
      [
        [IDS.flowA, 'deterministic_rule', false],
        [IDS.flowB, 'deterministic_rule', false],
      ],
    );
    assert.equal(ok.analysis.plan?.compilationId, env.compilationId);

    const noCompilation = await save(env, {
      ...flowDraft(env),
      nodes: [
        manual,
        { ...cap(env, 'a', IDS.flowA), config: { packageName: 'p', capabilityId: IDS.flowA, memoryScope: 'none' } },
        cap(env, 'b', IDS.flowB),
      ],
    });
    assert.equal(noCompilation.analysis.runnable, false);
    assert.match(noCompilation.analysis.blockers.map((b) => b.message).join('|'), /does not say which compilation/);

    const unknown = await save(env, {
      ...flowDraft(env),
      nodes: [manual, cap(env, 'a', IDS.flowA, { compilationId: 'cmp_nope' }), cap(env, 'b', IDS.flowB, { compilationId: 'cmp_nope' })],
    });
    assert.match(unknown.analysis.blockers.map((b) => b.message).join('|'), /it does not exist in this workspace/);

    const unboundCap = await save(env, { ...flowDraft(env), nodes: [manual, cap(env, 'a', IDS.orphan), cap(env, 'b', IDS.flowB)] });
    assert.equal(unboundCap.analysis.runnable, false);

    const missingCap = await save(env, {
      ...flowDraft(env),
      nodes: [manual, cap(env, 'a', 'cap_does_not_exist'), cap(env, 'b', IDS.flowB)],
    });
    assert.match(missingCap.analysis.blockers.map((b) => b.message).join('|'), /does not exist in compilation/);
  });
});

test('node-kinds reports exactly what analysis enforces', async () => {
  await withEnv(async (env) => {
    const res = await env.server.request('GET', `${env.drafts}/node-kinds`);
    assert.equal(res.status, 200, res.bodyText);
    const kinds = res.json<{
      kinds: { kind: string; supported: boolean; reason?: string; variants?: { value: string; supported: boolean }[] }[];
    }>().kinds;
    assert.deepEqual(
      kinds.filter((k) => k.supported).map((k) => k.kind),
      ['trigger', 'capability', 'branch', 'human_review'],
    );
    for (const k of kinds.filter((x) => !x.supported)) assert.ok((k.reason ?? '').length > 0, `${k.kind} states why`);
    const trigger = kinds.find((k) => k.kind === 'trigger')!;
    assert.deepEqual(
      trigger.variants?.filter((v) => v.supported).map((v) => v.value),
      ['manual'],
    );
    // The same support rules block a draft built from an unsupported variant.
    const sched = await save(env, {
      ...flowDraft(env),
      nodes: [{ id: 'start', kind: 'trigger', config: { type: 'schedule' } }, ...flowDraft(env).nodes.slice(1)],
    });
    assert.equal(sched.analysis.runnable, false);
  });
});
