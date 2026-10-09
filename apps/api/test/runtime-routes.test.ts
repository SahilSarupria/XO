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

test('POST /workspaces/:workspaceId/runtime/execute rejects a request missing "input"', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/runtime/execute`, { query: 'anything' }, { 'x-xo-api-key': 'fake-key' });
      assert.equal(res.status, 400);
      assert.equal(res.json<{ error: { code: string } }>().error.code, 'XO_RUNTIME_INVALID_REQUEST');
    } finally {
      await server.stop();
    }
  });
});

test('POST /workspaces/:workspaceId/runtime/execute rejects a request with neither "capabilityId" nor "query"', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/runtime/execute`, { input: 'hello' }, { 'x-xo-api-key': 'fake-key' });
      assert.equal(res.status, 400);
    } finally {
      await server.stop();
    }
  });
});

test('POST /workspaces/:workspaceId/runtime/execute reports 400 for an unknown provider id', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/runtime/execute`, { input: 'hi', query: 'q' }, { 'x-xo-provider': 'not-a-real-provider' });
      assert.equal(res.status, 400);
      assert.match(res.json<{ error: { message: string } }>().error.message, /unknown provider/);
    } finally {
      await server.stop();
    }
  });
});

test('POST /workspaces/:workspaceId/runtime/execute reports 400 when the default (anthropic) provider has no API key configured', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    // Explicitly clear rather than assume the sandbox happens to have
    // no ANTHROPIC_API_KEY set — this test's whole point is "no key
    // resolves anywhere", so it shouldn't depend on ambient env state.
    const previous = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/runtime/execute`, { input: 'hi', query: 'q' });
      assert.equal(res.status, 400);
      assert.match(res.json<{ error: { message: string } }>().error.message, /API key/);
    } finally {
      await server.stop();
      if (previous !== undefined) process.env['ANTHROPIC_API_KEY'] = previous;
    }
  });
});

test('POST /workspaces/:workspaceId/runtime/execute reports 400 for the ollama provider (no key needed) with no model specified, since it advertises none of its own', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/runtime/execute`, { input: 'hi', query: 'q' }, { 'x-xo-provider': 'ollama' });
      assert.equal(res.status, 400);
      assert.match(res.json<{ error: { message: string } }>().error.message, /advertises no models/);
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
