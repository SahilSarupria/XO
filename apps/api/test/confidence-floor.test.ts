import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toJson } from '@xo/xoir';
import { MIN_EXECUTION_CONFIDENCE, effectiveMinConfidence } from '@xo/runtime';
import { TestServer, withTempDir } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, buildFixtureGraph, storeFixtureCompilation } from './workflow-fixtures.js';
import { FsExecutionStore } from '../src/executions/fs-execution-store.js';
import { workspaceExecutionsStore } from '../src/workspace/workspace-context.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

// CRD-02 / B1-01: the confidence floor is a platform invariant on the API execution route.

type NodeJson = { id: string; metadata?: { confidence: number }; confidence?: number };

async function withFloorEnv(
  confidences: Readonly<Record<string, number>>,
  fn: (run: (cap: string, input: Record<string, unknown>) => Promise<{ status: number; json<T>(): T }>, count: () => Promise<number>) => Promise<void>,
): Promise<void> {
  await withTempDir('xo-floor-data-', async (dataDir) => {
    await withTempDir('xo-floor-ws-', async (workspacesDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir });
      try {
        const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        const json = JSON.parse(JSON.stringify(toJson(buildFixtureGraph()))) as { nodes: NodeJson[] };
        for (const node of json.nodes) {
          const c = confidences[node.id];
          if (c === undefined) continue;
          if (node.metadata !== undefined) node.metadata.confidence = c;
          else node.confidence = c;
        }
        const { compilationId } = await storeFixtureCompilation(workspace, dataDir, json as unknown as ReturnType<typeof toJson>);
        const base = `/workspaces/${workspace.workspaceId}`;
        const run = async (cap: string, input: Record<string, unknown>) => {
          const a = await server.request('POST', `${base}/compilations/${compilationId}/capabilities/${cap}/approve`);
          assert.ok(a.status === 200 || a.status === 201, a.bodyText);
          return server.request('POST', `${base}/executions`, { compilationId, capabilityId: cap, input });
        };
        const count = async () => {
          const store = new FsExecutionStore(workspaceExecutionsStore(workspace, { dataRootDir: dataDir }));
          const listed = await store.list();
          assert.ok(listed.ok);
          return listed.value.length;
        };
        await fn(run, count);
      } finally {
        await server.stop();
      }
    });
  });
}

test('floor: a deterministic capability below 0.7 is refused (422) and no execution record is created', async () => {
  await withFloorEnv({ [IDS.flowA]: 0.5 }, async (run, count) => {
    const res = await run(IDS.flowA, { claim_amount: 15000 });
    assert.equal(res.status, 422);
    assert.equal(res.json<{ error: { code: string } }>().error.code, 'XO_RUNTIME_CONFIDENCE_BELOW_THRESHOLD');
    assert.equal(await count(), 0);
  });
});

test('floor: a deterministic capability at or above 0.7 still executes', async () => {
  await withFloorEnv({ [IDS.flowA]: 0.7 }, async (run) => {
    const res = await run(IDS.flowA, { claim_amount: 15000 });
    assert.ok(res.status === 200 || res.status === 201);
    assert.equal(res.json<{ status: string }>().status, 'succeeded');
  });
});

test('floor: a low-confidence human-escalation capability still reaches a human (never auto-executed, never unreviewable)', async () => {
  await withFloorEnv({ [IDS.hitlB]: 0.45 }, async (run) => {
    const res = await run(IDS.hitlB, {});
    assert.ok(res.status === 200 || res.status === 201);
    assert.equal(res.json<{ status: string }>().status, 'waiting_for_human');
  });
});

test('floor: it can be raised but never lowered, and junk values are ignored', () => {
  assert.equal(effectiveMinConfidence(), MIN_EXECUTION_CONFIDENCE);
  assert.equal(effectiveMinConfidence(0.1), MIN_EXECUTION_CONFIDENCE);
  assert.equal(effectiveMinConfidence(0), MIN_EXECUTION_CONFIDENCE);
  assert.equal(effectiveMinConfidence(Number.NaN), MIN_EXECUTION_CONFIDENCE);
  assert.equal(effectiveMinConfidence(-5), MIN_EXECUTION_CONFIDENCE);
  assert.equal(effectiveMinConfidence(0.9), 0.9);
});
