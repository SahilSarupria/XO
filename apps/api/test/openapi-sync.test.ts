import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFsBlobStore } from '@xo/storage';
import { buildRouter } from '../src/server.js';
import { openApiDocument } from '../src/openapi.js';
import { studioPaths } from '../src/openapi-studio.js';
import { FsApiKeyStore } from '../src/auth/fs-api-key-store.js';
import { roleAllows, type WorkspacePermission } from '../src/workspace/permissions.js';
import { TestServer } from './test-helpers.js';

const PERMISSIONS: readonly WorkspacePermission[] = ['read', 'author', 'publish', 'review', 'audit', 'manage'];

type Op = { 'x-xo-permission'?: string; responses: Record<string, unknown> };
const operations = (): { method: string; path: string; op: Op }[] =>
  Object.entries(studioPaths).flatMap(([path, item]) =>
    Object.entries(item as Record<string, Op>).map(([method, op]) => ({ method: method.toUpperCase(), path, op })),
  );

test('every served /workspaces/... route (and /regions) is documented in the API document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-openapi-'));
  try {
    const router = buildRouter({
      apiKeyStore: new FsApiKeyStore(new LocalFsBlobStore(join(dir, 'k'))),
      workspacesDir: join(dir, 'w'),
      workspaceDataDir: join(dir, 'd'),
    });
    const paths = openApiDocument.paths as unknown as Record<string, Record<string, unknown>>;
    const missing = router
      .registeredRoutes()
      .filter((r) => r.path.startsWith('/workspaces/') || r.path === '/regions')
      .filter((r) => paths[r.path]?.[r.method.toLowerCase()] === undefined)
      .map((r) => `${r.method} ${r.path}`);
    assert.deepEqual(missing, [], 'routes served but not documented');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('every documented Studio operation declares a real permission and its failure responses', () => {
  for (const { method, path, op } of operations()) {
    if (path === '/regions') continue;
    const where = `${method} ${path}`;
    assert.ok(
      PERMISSIONS.includes(op['x-xo-permission'] as WorkspacePermission),
      `${where}: x-xo-permission must be one of ${PERMISSIONS.join(', ')}`,
    );
    assert.ok('401' in op.responses && '404' in op.responses, `${where}: documents 401 and 404`);
    if (op['x-xo-permission'] !== 'read') assert.ok('403' in op.responses, `${where}: a permission-gated route documents 403`);
  }
});

test('documented permissions match enforcement: a viewer is refused (403) exactly where read is not enough, and an outsider always gets 404', async () => {
  const dirs = {
    workspacesDir: await mkdtemp(join(tmpdir(), 'xo-oa-ws-')),
    workspaceDataDir: await mkdtemp(join(tmpdir(), 'xo-oa-data-')),
  };
  const server = await TestServer.start(dirs);
  try {
    const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
    const viewer = await server.issueAdditionalIdentity('viewer-1');
    const outsider = await server.issueAdditionalIdentity('outsider-1');
    await server.request('POST', `/workspaces/${ws}/members`, { identityId: 'viewer-1', role: 'viewer' });

    const fill = (p: string) =>
      p
        .replace('{workspaceId}', ws)
        .replace('{executionId}', 'exec_x')
        .replace('{requestId}', 'ir_x')
        .replace('{packageId}', 'sha256%3Ax')
        .replace('{name}', 'n')
        .replace('{version}', '1.0.0')
        .replace('{identityId}', 'someone')
        .replace('{threadId}', 'cht_' + '0'.repeat(32))
        .replace('{definitionId}', 'wfd_' + '0'.repeat(32));

    let checked = 0;
    for (const { method, path, op } of operations()) {
      if (path === '/regions') continue;
      const permission = op['x-xo-permission'] as WorkspacePermission;
      const url = fill(path);
      const send = (headers: Record<string, string>) =>
        server.request(method, url, method === 'GET' || method === 'DELETE' ? undefined : {}, headers);

      const asOutsider = await send(TestServer.authHeader(outsider.apiKey));
      assert.equal(asOutsider.status, 404, `${method} ${path}: a non-member must get 404, got ${asOutsider.status}`);

      const asViewer = await send(TestServer.authHeader(viewer.apiKey));
      if (roleAllows('viewer', permission))
        assert.notEqual(asViewer.status, 403, `${method} ${path}: documented "${permission}" but a viewer was refused`);
      else assert.equal(asViewer.status, 403, `${method} ${path}: documented "${permission}" but a viewer got ${asViewer.status}`);
      checked++;
    }
    assert.equal(checked, operations().filter((o) => o.path !== '/regions').length, 'every documented Studio operation was exercised');
  } finally {
    await server.stop();
    await rm(dirs.workspacesDir, { recursive: true, force: true });
    await rm(dirs.workspaceDataDir, { recursive: true, force: true });
  }
});
