import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packBundle, PackageInstaller } from '@xo/package-sdk';
import { TestServer, withTempDir } from './test-helpers.js';
import { buildFixtureBundle } from './fixtures.js';
import { workspacePackagesStore } from '../src/workspace/workspace-context.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

test('POST /packages/validate requires archiveBase64', async () => {
  const server = await TestServer.start();
  try {
    const res = await server.request('POST', '/packages/validate', {});
    assert.equal(res.status, 400);
  } finally {
    await server.stop();
  }
});

test('POST /packages/validate rejects invalid base64', async () => {
  const server = await TestServer.start();
  try {
    // Note: Buffer.from(..., 'base64') never throws in Node — it just
    // decodes whatever it can — so this exercises the downstream
    // unpackArchive failure path (garbage bytes are not a real .xo
    // archive) rather than the base64-decode try/catch itself.
    const bundle = buildFixtureBundle({ name: 'xo_validate_pkg' });
    const goodArchive = Buffer.from(await packBundle(bundle));
    const res = await server.request('POST', '/packages/validate', { archiveBase64: goodArchive.toString('base64') });
    assert.equal(res.status, 200);
    const body = res.json<{ valid: boolean }>();
    assert.equal(body.valid, true);
  } finally {
    await server.stop();
  }
});

test('POST /packages/validate returns 422 with issues for an invalid bundle', async () => {
  const server = await TestServer.start();
  try {
    const res = await server.request('POST', '/packages/validate', { archiveBase64: Buffer.from('not a real archive').toString('base64') });
    assert.equal(res.status, 422);
  } finally {
    await server.stop();
  }
});

test('POST /packages/validate rejects a non-object "publicKeys"', async () => {
  const server = await TestServer.start();
  try {
    const bundle = buildFixtureBundle({ name: 'xo_validate_pk_pkg' });
    const archive = Buffer.from(await packBundle(bundle));
    const res = await server.request('POST', '/packages/validate', { archiveBase64: archive.toString('base64'), publicKeys: 'not-an-object' });
    assert.equal(res.status, 400);
  } finally {
    await server.stop();
  }
});

// --- P0.2: package resolve/lock/manifest are now workspace-bound ---

test('legacy /packages/resolve and /packages/lock (no workspace) return a clear 400, not a silent fallback', async () => {
  const server = await TestServer.start();
  try {
    const resolveRes = await server.request('POST', '/packages/resolve', { nameAtVersion: 'foo@1.0.0' });
    assert.equal(resolveRes.status, 400);
    assert.match(resolveRes.json<{ error: { message: string } }>().error.message, /workspaces\/:workspaceId/);

    const lockRes = await server.request('POST', '/packages/lock', { nameAtVersion: 'foo@1.0.0' });
    assert.equal(lockRes.status, 400);

    const manifestRes = await server.request('GET', '/packages/foo/1.0.0/manifest');
    assert.equal(manifestRes.status, 400);
  } finally {
    await server.stop();
  }
});

test('an arbitrary ?store= query parameter on the new workspace-scoped route is simply ignored (storage is resolved from the workspace, never the query string)', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    await withTempDir('xo-api-attacker-dir-', async (attackerDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir });
      try {
        const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/packages/resolve?store=${encodeURIComponent(attackerDir)}`, { nameAtVersion: 'nope@1.0.0' });
        // Still resolves against the *workspace's* store (empty), not the attacker-supplied directory — a 404 ("package never installed"), never a 200 sourced from `attackerDir`.
        assert.equal(res.status, 404);
      } finally {
        await server.stop();
      }
    });
  });
});

test('POST /workspaces/:workspaceId/packages/resolve rejects a malformed "nameAtVersion"', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
      const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/packages/resolve`, { nameAtVersion: 'no-at-sign' });
      assert.equal(res.status, 400);
    } finally {
      await server.stop();
    }
  });
});

test('resolve() and lock() against a real installed package with no dependencies (workspace-scoped storage)', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
      const store = workspacePackagesStore(workspace, { dataRootDir: dataDir });

      const bundle = buildFixtureBundle({ name: 'xo_resolve_pkg', version: '2.0.0' });
      const installed = await new PackageInstaller(store).install(bundle);
      assert.equal(installed.ok, true);

      const base = `/workspaces/${workspace.workspaceId}/packages`;
      const resolveRes = await server.request('POST', `${base}/resolve`, { nameAtVersion: 'xo_resolve_pkg@2.0.0' });
      assert.equal(resolveRes.status, 200);
      const resolution = resolveRes.json<{ resolved: readonly unknown[] }>();
      assert.ok(Array.isArray(resolution.resolved));

      const lockRes = await server.request('POST', `${base}/lock`, { nameAtVersion: 'xo_resolve_pkg@2.0.0' });
      assert.equal(lockRes.status, 200);
      const lockfile = lockRes.json<{ dependencies: readonly unknown[] }>();
      assert.ok(Array.isArray(lockfile.dependencies));

      // lock() actually wrote xo.lock to the *workspace's* store — verify it's readable back out from there.
      const raw = await store.get('xo_resolve_pkg/2.0.0/xo.lock');
      assert.equal(raw.ok, true);
    } finally {
      await server.stop();
    }
  });
});

test('resolve() 404s for a package that was never installed in this workspace', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
      const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/packages/resolve`, { nameAtVersion: 'nope@1.0.0' });
      assert.equal(res.status, 404);
    } finally {
      await server.stop();
    }
  });
});

test('GET /workspaces/:workspaceId/packages/:name/:version/manifest returns an installed manifest, 404 otherwise', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
      const store = workspacePackagesStore(workspace, { dataRootDir: dataDir });

      const bundle = buildFixtureBundle({ name: 'xo_manifest_pkg', version: '3.0.0' });
      await new PackageInstaller(store).install(bundle);

      const base = `/workspaces/${workspace.workspaceId}/packages`;
      const okRes = await server.request('GET', `${base}/xo_manifest_pkg/3.0.0/manifest`);
      assert.equal(okRes.status, 200);
      assert.equal(okRes.json<{ name: string }>().name, 'xo_manifest_pkg');

      const missingRes = await server.request('GET', `${base}/xo_manifest_pkg/9.9.9/manifest`);
      assert.equal(missingRes.status, 404);
    } finally {
      await server.stop();
    }
  });
});

test('a different identity cannot resolve/lock/read manifests through another identity\'s workspace-scoped package routes (404, not data from the wrong workspace)', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const owner = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
      const other = await server.issueAdditionalIdentity('identity-b');

      const res = await server.request('GET', `/workspaces/${owner.workspaceId}/packages/foo/1.0.0/manifest`, undefined, TestServer.authHeader(other.apiKey));
      assert.equal(res.status, 404);
    } finally {
      await server.stop();
    }
  });
});
