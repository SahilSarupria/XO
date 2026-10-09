import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packBundle } from '@xo/package-sdk';
import { TestServer, withTempDir } from './test-helpers.js';
import { buildFixtureBundle } from './fixtures.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

async function createWorkspace(server: TestServer): Promise<WorkspaceRecord> {
  return (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
}

// --- P0.2: every registry route is now workspace-bound ---

test('legacy /registry/packages (no workspace) returns a clear 400, not a silent fallback', async () => {
  const server = await TestServer.start();
  try {
    const res = await server.request('POST', '/registry/packages', Buffer.from([1, 2, 3]));
    assert.equal(res.status, 400);
    assert.match(res.json<{ error: { message: string } }>().error.message, /workspaces\/:workspaceId/);
  } finally {
    await server.stop();
  }
});

test('an arbitrary ?registry= query parameter on the new workspace-scoped route is simply ignored (storage is resolved from the workspace, never the query string)', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    await withTempDir('xo-api-attacker-registry-', async (attackerDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir });
      try {
        const workspace = await createWorkspace(server);
        const res = await server.request('GET', `/workspaces/${workspace.workspaceId}/registry/packages/sha256%3Adoesnotexist?registry=${encodeURIComponent(attackerDir)}`);
        // 404 from the workspace's own (empty) registry, never a result that could only have come from `attackerDir`.
        assert.equal(res.status, 404);
      } finally {
        await server.stop();
      }
    });
  });
});

test('POST /workspaces/:workspaceId/registry/packages rejects an empty body', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/registry/packages`, Buffer.alloc(0));
      assert.equal(res.status, 400);
    } finally {
      await server.stop();
    }
  });
});

test('publish -> get -> search -> inspect round-trips a real bundle through real RegistryClient logic (workspace-scoped)', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const base = `/workspaces/${workspace.workspaceId}/registry`;
      const bundle = buildFixtureBundle({ name: 'xo_route_test_pkg' });
      const archiveBytes = Buffer.from(await packBundle(bundle));

      const publishRes = await server.request('POST', `${base}/packages`, archiveBytes);
      assert.equal(publishRes.status, 201);
      const published = publishRes.json<{ id: string; publishedAt: string }>();
      assert.equal(published.id, bundle.manifest.merkleRoot);

      const getRes = await server.request('GET', `${base}/packages/${encodeURIComponent(published.id)}`);
      assert.equal(getRes.status, 200);
      assert.equal(getRes.json<{ manifest: { name: string } }>().manifest.name, 'xo_route_test_pkg');

      const searchRes = await server.request('GET', `${base}/search?q=xo_route_test_pkg`);
      assert.equal(searchRes.status, 200);
      const searchBody = searchRes.json<{ records: readonly { id: string }[] }>();
      assert.ok(searchBody.records.some((r) => r.id === published.id));

      const inspectRes = await server.request('GET', `${base}/packages/${encodeURIComponent(published.id)}/inspect`);
      assert.equal(inspectRes.status, 200);
      const inspectBody = inspectRes.json<{ record: { id: string }; benchmarkRuns: readonly unknown[] }>();
      assert.equal(inspectBody.record.id, published.id);
      assert.deepEqual(inspectBody.benchmarkRuns, []);
    } finally {
      await server.stop();
    }
  });
});

test('publish rejects a tampered bundle with 422, matching PackageValidator/RegistryClient behavior', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const bundle = buildFixtureBundle({ name: 'xo_tampered_pkg' });
      const tamperedComponents = bundle.components.map((component) => (component.kind === 'safety_rules' ? { ...component, data: new TextEncoder().encode('{"rules":["tampered"]}') } : component));
      const archiveBytes = Buffer.from(await packBundle({ ...bundle, components: tamperedComponents }));

      const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/registry/packages`, archiveBytes);
      assert.equal(res.status, 422);
    } finally {
      await server.stop();
    }
  });
});

test('GET /workspaces/:workspaceId/registry/packages/:id returns 404 for an unknown package id', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const res = await server.request('GET', `/workspaces/${workspace.workspaceId}/registry/packages/sha256%3Adoesnotexist`);
      assert.equal(res.status, 404);
    } finally {
      await server.stop();
    }
  });
});

test('recordBenchmark -> listBenchmarksForPackage -> getBenchmark round-trip (workspace-scoped)', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const base = `/workspaces/${workspace.workspaceId}/registry`;
      const bundle = buildFixtureBundle({ name: 'xo_benchmark_pkg' });
      const published = (await server.request('POST', `${base}/packages`, Buffer.from(await packBundle(bundle)))).json<{ id: string }>();

      const recordRes = await server.request('POST', `${base}/packages/${encodeURIComponent(published.id)}/benchmarks`, { category: 'knowledge', score: 91.2 });
      assert.equal(recordRes.status, 201);
      const run = recordRes.json<{ id: string; category: string; score: number }>();
      assert.equal(run.category, 'knowledge');
      assert.equal(run.score, 91.2);

      const listRes = await server.request('GET', `${base}/packages/${encodeURIComponent(published.id)}/benchmarks`);
      assert.equal(listRes.status, 200);
      assert.equal(listRes.json<{ runs: readonly unknown[] }>().runs.length, 1);

      const getRes = await server.request('GET', `${base}/benchmarks/${encodeURIComponent(run.id)}`);
      assert.equal(getRes.status, 200);
      assert.equal(getRes.json<{ id: string }>().id, run.id);
    } finally {
      await server.stop();
    }
  });
});

test('recordBenchmark rejects a missing "score" with 400', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const base = `/workspaces/${workspace.workspaceId}/registry`;
      const bundle = buildFixtureBundle({ name: 'xo_badbenchmark_pkg' });
      const published = (await server.request('POST', `${base}/packages`, Buffer.from(await packBundle(bundle)))).json<{ id: string }>();

      const res = await server.request('POST', `${base}/packages/${encodeURIComponent(published.id)}/benchmarks`, { category: 'knowledge' });
      assert.equal(res.status, 400);
    } finally {
      await server.stop();
    }
  });
});

test('createLicense -> getLicense round-trip; rejects a royaltySplit entry missing basisPoints', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const base = `/workspaces/${workspace.workspaceId}/registry`;
      const bundle = buildFixtureBundle({ name: 'xo_license_pkg' });
      const published = (await server.request('POST', `${base}/packages`, Buffer.from(await packBundle(bundle)))).json<{ id: string }>();

      const createRes = await server.request('POST', `${base}/licenses`, { packageId: published.id, tier: 'commercial', royaltySplit: [{ role: 'creator', basisPoints: 10000 }] });
      assert.equal(createRes.status, 201);
      const license = createRes.json<{ id: string }>();

      const getRes = await server.request('GET', `${base}/licenses/${encodeURIComponent(license.id)}`);
      assert.equal(getRes.status, 200);

      const badRes = await server.request('POST', `${base}/licenses`, { packageId: published.id, tier: 'commercial', royaltySplit: [{ role: 'creator' }] });
      assert.equal(badRes.status, 400);
    } finally {
      await server.stop();
    }
  });
});

test('GET /workspaces/:workspaceId/registry/ledger/:entryHash/verify returns a boolean verified field', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const res = await server.request('GET', `/workspaces/${workspace.workspaceId}/registry/ledger/not-a-real-hash/verify`);
      assert.equal(res.status, 200);
      const body = res.json<{ verified: boolean }>();
      assert.equal(typeof body.verified, 'boolean');
    } finally {
      await server.stop();
    }
  });
});

test('a different identity gets 404 (not another workspace\'s registry data) when reaching through a workspace it does not own', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const owner = await createWorkspace(server);
      const bundle = buildFixtureBundle({ name: 'xo_owned_pkg' });
      const published = (await server.request('POST', `/workspaces/${owner.workspaceId}/registry/packages`, Buffer.from(await packBundle(bundle)))).json<{ id: string }>();

      const other = await server.issueAdditionalIdentity('identity-b');
      const res = await server.request('GET', `/workspaces/${owner.workspaceId}/registry/packages/${encodeURIComponent(published.id)}`, undefined, TestServer.authHeader(other.apiKey));
      assert.equal(res.status, 404);
    } finally {
      await server.stop();
    }
  });
});
