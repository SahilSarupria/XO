import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PackageInstaller } from '@xo/package-sdk';
import { TestServer, withTempDir } from './test-helpers.js';
import { buildFixtureBundle } from './fixtures.js';
import { workspacePackagesStore } from '../src/workspace/workspace-context.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

/**
 * A full happy-path execution (a real provider actually answering a
 * prompt) isn't exercised here — that needs a live network call to a
 * real model provider, which this sandbox doesn't have (see README.md's
 * "Known limitations"). What's covered instead is everything this
 * layer is actually responsible for: bootstrap, provider *resolution*
 * (config parsing, missing-key/missing-model detection), and request
 * validation — all real logic, all reachable without a live provider
 * call. `provider-factory.test.ts` covers `resolveProvider` itself in
 * more depth.
 *
 * P0.2: every route here moved from `?store=<client path>` to
 * `/workspaces/:workspaceId/runtime/...`.
 */

async function createWorkspace(server: TestServer): Promise<WorkspaceRecord> {
  return (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
}

test('legacy /runtime/context and /runtime/execute (no workspace) return a clear 400, not a silent fallback', async () => {
  const server = await TestServer.start();
  try {
    const contextRes = await server.request('GET', '/runtime/context');
    assert.equal(contextRes.status, 400);
    assert.match(contextRes.json<{ error: { message: string } }>().error.message, /workspaces\/:workspaceId/);

    const executeRes = await server.request('POST', '/runtime/execute', { input: 'hi', query: 'anything' });
    assert.equal(executeRes.status, 400);
  } finally {
    await server.stop();
  }
});

test('an arbitrary ?store= query parameter on the new workspace-scoped route is simply ignored (storage is resolved from the workspace, never the query string)', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    await withTempDir('xo-api-attacker-runtime-', async (attackerDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir });
      try {
        const workspace = await createWorkspace(server);
        const res = await server.request('GET', `/workspaces/${workspace.workspaceId}/runtime/context?store=${encodeURIComponent(attackerDir)}`);
        assert.equal(res.status, 200);
        // Empty workspace store, not whatever might be sitting in `attackerDir`.
        assert.deepEqual(res.json<{ mountedPackages: readonly unknown[] }>().mountedPackages, []);
      } finally {
        await server.stop();
      }
    });
  });
});

test('GET /workspaces/:workspaceId/runtime/context bootstraps against an empty workspace with no mounted packages', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const res = await server.request('GET', `/workspaces/${workspace.workspaceId}/runtime/context`);
      assert.equal(res.status, 200);
      const body = res.json<{ mountedPackages: readonly unknown[]; capabilities: readonly unknown[]; bootstrapWarnings: readonly unknown[] }>();
      assert.deepEqual(body.mountedPackages, []);
      assert.deepEqual(body.capabilities, []);
      assert.deepEqual(body.bootstrapWarnings, []);
    } finally {
      await server.stop();
    }
  });
});

test('GET /workspaces/:workspaceId/runtime/context reflects a real installed (capability-less) package as mounted, and NOT a package installed in a different workspace', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const otherWorkspace = await createWorkspace(server);

      const bundle = buildFixtureBundle({ name: 'xo_runtime_ctx_pkg' });
      await new PackageInstaller(workspacePackagesStore(workspace, { dataRootDir: dataDir })).install(bundle);

      const res = await server.request('GET', `/workspaces/${workspace.workspaceId}/runtime/context`);
      assert.equal(res.status, 200);
      const body = res.json<{ mountedPackages: readonly { name: string }[] }>();
      assert.equal(body.mountedPackages.length, 1);
      assert.equal(body.mountedPackages[0]?.name, 'xo_runtime_ctx_pkg');

      // The package was installed into `workspace`'s own package store,
      // not `otherWorkspace`'s — confirms storage isolation extends to
      // the runtime bootstrap, not only to package/registry routes.
      const otherRes = await server.request('GET', `/workspaces/${otherWorkspace.workspaceId}/runtime/context`);
      assert.deepEqual(otherRes.json<{ mountedPackages: readonly unknown[] }>().mountedPackages, []);
    } finally {
      await server.stop();
    }
  });
});

// P1.0 M1 — AI-assisted execution is DISABLED until the authorization gate
// (M2) is effective on this path. The five pre-M1 tests that exercised this
// route's request validation / provider resolution (missing "input", neither
// capabilityId nor query, unknown provider, missing API key, ollama with no
// model) tested behaviour of a path that is now refused before any of it
// runs; they are replaced by the assertions below (and the provider
// resolver itself stays covered by provider-factory.test.ts).
test('POST /workspaces/:workspaceId/runtime/execute is disabled (501) for every body/header combination, before any provider is resolved', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const url = `/workspaces/${workspace.workspaceId}/runtime/execute`;
      const attempts: ReadonlyArray<{ readonly body: unknown; readonly headers?: Record<string, string> }> = [
        { body: { input: 'hi', query: 'q' } },
        { body: { query: 'anything' } }, // would have been a 400 (missing input) pre-M1
        { body: { input: 'hello' } }, // would have been a 400 (no capabilityId/query) pre-M1
        { body: { input: 'hi', query: 'q' }, headers: { 'x-xo-provider': 'not-a-real-provider' } },
        { body: { input: 'hi', query: 'q' }, headers: { 'x-xo-provider': 'ollama', 'x-xo-base-url': 'http://127.0.0.1:1', 'x-xo-api-key': 'k' } },
      ];
      for (const attempt of attempts) {
        const res = await server.request('POST', url, attempt.body, attempt.headers);
        assert.equal(res.status, 501);
        const message = res.json<{ error: { message: string } }>().error.message;
        assert.match(message, /AI-assisted execution is disabled/);
        assert.doesNotMatch(message, /not-a-real-provider|127\.0\.0\.1|advertises no models|API key/);
      }
    } finally {
      await server.stop();
    }
  });
});

test('POST /workspaces/:workspaceId/runtime/execute: a different identity still gets the uniform 404 (ownership is checked before the disable), and no credential gets 401', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const owner = await createWorkspace(server);
      const other = await server.issueAdditionalIdentity('identity-b');
      const foreign = await server.request('POST', `/workspaces/${owner.workspaceId}/runtime/execute`, { input: 'hi', query: 'q' }, TestServer.authHeader(other.apiKey));
      assert.equal(foreign.status, 404);
      const unknown = await server.request('POST', `/workspaces/ws_does_not_exist/runtime/execute`, { input: 'hi', query: 'q' });
      assert.equal(unknown.status, 404);
      const none = await server.request('POST', `/workspaces/${owner.workspaceId}/runtime/execute`, { input: 'hi', query: 'q' }, {}, { skipAuth: true });
      assert.equal(none.status, 401);
    } finally {
      await server.stop();
    }
  });
});

test('a different identity cannot bootstrap runtime context through a workspace it does not own', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const owner = await createWorkspace(server);
      const other = await server.issueAdditionalIdentity('identity-b');
      const res = await server.request('GET', `/workspaces/${owner.workspaceId}/runtime/context`, undefined, TestServer.authHeader(other.apiKey));
      assert.equal(res.status, 404);
    } finally {
      await server.stop();
    }
  });
});
