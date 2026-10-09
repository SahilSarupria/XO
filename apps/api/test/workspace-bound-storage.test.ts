import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PackageInstaller } from '@xo/package-sdk';
import { TestServer, withTempDir } from './test-helpers.js';
import { buildFixtureBundle } from './fixtures.js';
import { workspacePackagesStore } from '../src/workspace/workspace-context.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

/**
 * P0.2's per-route-family test files (`package-routes.test.ts`,
 * `registry-routes.test.ts`, `runtime-routes.test.ts`) each already
 * prove their own happy path, legacy-route-400, and cross-identity-404
 * behavior. What's here instead is the handful of security properties
 * the milestone brief calls out explicitly that are *identical* across
 * all three route families by construction — every one of them funnels
 * through the exact same `requireOwnedWorkspace` (see
 * `workspace/workspace-context.ts`) — so proving them once per family,
 * table-driven, is more honest than three near-duplicate test files:
 * a regression in the shared function would show up here as three
 * failures across three different route prefixes, not as one narrow
 * package-only (or registry-only) failure that could be mistaken for a
 * one-off.
 */

const ROUTE_FAMILIES = [
  { label: 'package', method: 'POST' as const, suffix: '/packages/resolve', body: { nameAtVersion: 'nope@1.0.0' } },
  { label: 'registry', method: 'GET' as const, suffix: '/registry/search?q=anything', body: undefined },
  { label: 'runtime', method: 'GET' as const, suffix: '/runtime/context', body: undefined },
];

test('unauthenticated requests to every workspace-bound route family are rejected (401), never reaching workspace resolution', async () => {
  const server = await TestServer.start();
  try {
    const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
    for (const family of ROUTE_FAMILIES) {
      const res = await server.request(family.method, `/workspaces/${workspace.workspaceId}${family.suffix}`, family.body, {}, { skipAuth: true });
      assert.equal(res.status, 401, `expected 401 for unauthenticated ${family.label} request`);
    }
  } finally {
    await server.stop();
  }
});

test('an unknown (but syntactically valid) workspace id fails closed as 404 across every route family', async () => {
  const server = await TestServer.start();
  try {
    const unknownId = 'ws_ffffffffffffffffffffffffffffffff';
    for (const family of ROUTE_FAMILIES) {
      const res = await server.request(family.method, `/workspaces/${unknownId}${family.suffix}`, family.body);
      assert.equal(res.status, 404, `expected 404 for unknown workspace on ${family.label} route`);
    }
  } finally {
    await server.stop();
  }
});

test('absolute-path-shaped and traversal-shaped workspace ids are rejected cleanly (4xx) across every route family, never a 500 and never a path-escaping read', async () => {
  const server = await TestServer.start();
  try {
    // Only attempts that survive URL/router segmentation as a single
    // `:workspaceId` path segment are meaningful here — anything
    // containing a literal `/` becomes a different route shape and is
    // rejected by the router itself before ever reaching a handler
    // (still a clean 4xx, just for a different, equally valid reason).
    const maliciousIds = [
      encodeURIComponent('/etc/passwd'),
      encodeURIComponent('../../etc/passwd'),
      'ws_' + '2e2e2f'.repeat(6), // well-formed-looking but not a real record
      '%2e%2e%2f%2e%2e%2f',
    ];
    for (const family of ROUTE_FAMILIES) {
      for (const maliciousId of maliciousIds) {
        const res = await server.request(family.method, `/workspaces/${maliciousId}${family.suffix}`, family.body);
        assert.ok([400, 404].includes(res.status), `expected a clean 4xx for malicious workspace id "${maliciousId}" on ${family.label} route, got ${res.status}`);
      }
    }
  } finally {
    await server.stop();
  }
});

test('a legacy ?store=/?registry= query parameter never influences which workspace/directory is used, across every route family', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    await withTempDir('xo-api-attacker-', async (attackerDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir });
      try {
        const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        const attackerParam = encodeURIComponent(attackerDir);

        const packageRes = await server.request('POST', `/workspaces/${workspace.workspaceId}/packages/resolve?store=${attackerParam}`, { nameAtVersion: 'nope@1.0.0' });
        assert.equal(packageRes.status, 404); // resolves against the empty *workspace* store, not the attacker directory

        const registryRes = await server.request('GET', `/workspaces/${workspace.workspaceId}/registry/search?q=anything&registry=${attackerParam}`);
        assert.equal(registryRes.status, 200); // real RegistryClient call against the workspace's own (empty) registry store

        const runtimeRes = await server.request('GET', `/workspaces/${workspace.workspaceId}/runtime/context?store=${attackerParam}`);
        assert.equal(runtimeRes.status, 200);
        assert.deepEqual(runtimeRes.json<{ mountedPackages: readonly unknown[] }>().mountedPackages, []); // nothing mounted from the attacker directory

        // The attacker directory itself must never have been touched.
        assert.equal(existsSync(join(attackerDir, workspace.workspaceId)), false);
      } finally {
        await server.stop();
      }
    });
  });
});

test('workspace-scoped writes land under the expected server-controlled namespace on disk: <dataRootDir>/<workspaceId>/{packages,registry}, never anywhere else', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();

      const store = workspacePackagesStore(workspace, { dataRootDir: dataDir });
      const bundle = buildFixtureBundle({ name: 'xo_namespace_pkg', version: '1.0.0' });
      const installed = await new PackageInstaller(store).install(bundle);
      assert.equal(installed.ok, true);

      // A real, successful write happened via the HTTP-shaped
      // `workspacePackagesStore` seam `package-routes.ts` itself uses —
      // confirm it landed at exactly the documented convention
      // (`workspace-context.ts`'s `workspace-data/<workspaceId>/packages/`)
      // realized on disk as `<dataRootDir>/<workspaceId>/packages`, and
      // nowhere else (not flat under `dataRootDir`, not under `registry`).
      assert.equal(existsSync(join(dataDir, workspace.workspaceId, 'packages')), true);
      assert.equal(existsSync(join(dataDir, workspace.workspaceId, 'registry')), false);

      // The HTTP route reading this same workspace sees the same data — proving the route and the direct store agree on location.
      const manifestRes = await server.request('GET', `/workspaces/${workspace.workspaceId}/packages/xo_namespace_pkg/1.0.0/manifest`);
      assert.equal(manifestRes.status, 200);
    } finally {
      await server.stop();
    }
  });
});
