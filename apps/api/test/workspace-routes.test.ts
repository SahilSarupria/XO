import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestServer } from './test-helpers.js';

interface WorkspaceWire {
  readonly workspaceId: string;
  readonly identityId: string;
  readonly name?: string;
  readonly createdAt: string;
  readonly storageKeyPrefix: string;
}

async function withWorkspacesDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'xo-api-test-workspaces-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('POST /workspaces creates a workspace owned by the authenticated identity', async () => {
  await withWorkspacesDir(async (workspacesDir) => {
    const server = await TestServer.start({ workspacesDir });
    try {
      const res = await server.request('POST', '/workspaces', { name: 'Aastha pilot' });
      assert.equal(res.status, 201);
      const body = res.json<WorkspaceWire>();
      assert.match(body.workspaceId, /^ws_[0-9a-f]{32}$/);
      assert.equal(body.identityId, server.identityId);
      assert.equal(body.name, 'Aastha pilot');
      assert.ok(body.createdAt);
      // No filesystem path is ever exposed to the client — only an opaque logical key prefix.
      assert.equal(body.storageKeyPrefix, `workspace-data/${body.workspaceId}/`);
      assert.doesNotMatch(body.storageKeyPrefix, /^\/|\.\.\//);
    } finally {
      await server.stop();
    }
  });
});

test('POST /workspaces works with no body at all (name is optional)', async () => {
  await withWorkspacesDir(async (workspacesDir) => {
    const server = await TestServer.start({ workspacesDir });
    try {
      const res = await server.request('POST', '/workspaces');
      assert.equal(res.status, 201);
      const body = res.json<WorkspaceWire>();
      assert.equal(body.name, undefined);
      assert.equal(body.identityId, server.identityId);
    } finally {
      await server.stop();
    }
  });
});

test('a created workspace is persisted: immediately retrievable by GET /workspaces/:id', async () => {
  await withWorkspacesDir(async (workspacesDir) => {
    const server = await TestServer.start({ workspacesDir });
    try {
      const created = (await server.request('POST', '/workspaces', { name: 'W1' })).json<WorkspaceWire>();
      const fetched = await server.request('GET', `/workspaces/${created.workspaceId}`);
      assert.equal(fetched.status, 200);
      assert.deepEqual(fetched.json<WorkspaceWire>(), created);
    } finally {
      await server.stop();
    }
  });
});

test('GET /workspaces lists only workspaces owned by the authenticated identity', async () => {
  await withWorkspacesDir(async (workspacesDir) => {
    const server = await TestServer.start({ workspacesDir });
    try {
      const other = await server.issueAdditionalIdentity('identity-b');

      const mine1 = (await server.request('POST', '/workspaces', { name: 'mine-1' })).json<WorkspaceWire>();
      const mine2 = (await server.request('POST', '/workspaces', { name: 'mine-2' })).json<WorkspaceWire>();
      const theirs = (await server.request('POST', '/workspaces', { name: 'theirs' }, TestServer.authHeader(other.apiKey))).json<WorkspaceWire>();

      const listMine = await server.request('GET', '/workspaces');
      assert.equal(listMine.status, 200);
      const mineIds = listMine.json<{ workspaces: readonly WorkspaceWire[] }>().workspaces.map((w) => w.workspaceId);
      assert.ok(mineIds.includes(mine1.workspaceId));
      assert.ok(mineIds.includes(mine2.workspaceId));
      assert.ok(!mineIds.includes(theirs.workspaceId));

      const listTheirs = await server.request('GET', '/workspaces', undefined, TestServer.authHeader(other.apiKey));
      const theirIds = listTheirs.json<{ workspaces: readonly WorkspaceWire[] }>().workspaces.map((w) => w.workspaceId);
      assert.deepEqual(theirIds, [theirs.workspaceId]);
    } finally {
      await server.stop();
    }
  });
});

test('GET /workspaces/:id retrieves an owned workspace', async () => {
  await withWorkspacesDir(async (workspacesDir) => {
    const server = await TestServer.start({ workspacesDir });
    try {
      const created = (await server.request('POST', '/workspaces', { name: 'mine' })).json<WorkspaceWire>();
      const res = await server.request('GET', `/workspaces/${created.workspaceId}`);
      assert.equal(res.status, 200);
      assert.equal(res.json<WorkspaceWire>().workspaceId, created.workspaceId);
    } finally {
      await server.stop();
    }
  });
});

test('identity A cannot retrieve identity B workspace by id — fails closed as 404, not 403 (no existence leak)', async () => {
  await withWorkspacesDir(async (workspacesDir) => {
    const server = await TestServer.start({ workspacesDir }, 'identity-a');
    try {
      const b = await server.issueAdditionalIdentity('identity-b');
      const bWorkspace = (await server.request('POST', '/workspaces', { name: 'b-only' }, TestServer.authHeader(b.apiKey))).json<WorkspaceWire>();

      const asA = await server.request('GET', `/workspaces/${bWorkspace.workspaceId}`);
      assert.equal(asA.status, 404);

      // Confirm this is indistinguishable in shape from a genuinely unknown id.
      const unknown = await server.request('GET', '/workspaces/ws_00000000000000000000000000000000');
      assert.equal(unknown.status, 404);
      assert.equal(asA.json<{ error: { code: string } }>().error.code, unknown.json<{ error: { code: string } }>().error.code);
    } finally {
      await server.stop();
    }
  });
});

test('unknown/malformed workspace id fails closed (404), never a 500 or a path-escaping read', async () => {
  await withWorkspacesDir(async (workspacesDir) => {
    const server = await TestServer.start({ workspacesDir });
    try {
      const wellFormedButUnknown = await server.request('GET', '/workspaces/ws_ffffffffffffffffffffffffffffffff');
      assert.equal(wellFormedButUnknown.status, 404);

      const malformed = await server.request('GET', '/workspaces/not-a-real-id');
      assert.equal(malformed.status, 404);
    } finally {
      await server.stop();
    }
  });
});

test('workspace id cannot be used to escape its storage namespace (path traversal attempt fails closed, not 500)', async () => {
  await withWorkspacesDir(async (workspacesDir) => {
    const server = await TestServer.start({ workspacesDir });
    try {
      const traversalAttempts = ['../../etc/passwd', '..%2f..%2fetc%2fpasswd', 'ws_' + '..'.repeat(16), '%2e%2e%2f%2e%2e%2f'];
      for (const attempt of traversalAttempts) {
        const res = await server.request('GET', `/workspaces/${attempt}`);
        assert.ok([400, 404].includes(res.status), `expected a clean 4xx for traversal attempt "${attempt}", got ${res.status}`);
      }
    } finally {
      await server.stop();
    }
  });
});

test('a request body cannot override the authenticated identity: identityId in the body is ignored', async () => {
  await withWorkspacesDir(async (workspacesDir) => {
    const server = await TestServer.start({ workspacesDir });
    try {
      const res = await server.request('POST', '/workspaces', { name: 'spoofed', identityId: 'someone-else' });
      assert.equal(res.status, 201);
      const body = res.json<WorkspaceWire>();
      assert.equal(body.identityId, server.identityId);
      assert.notEqual(body.identityId, 'someone-else');
    } finally {
      await server.stop();
    }
  });
});

test('workspace remains available after a fresh API/server instance starts against the same workspacesDir (survives restart)', async () => {
  await withWorkspacesDir(async (workspacesDir) => {
    const identityId = 'restart-identity';
    const server1 = await TestServer.start({ workspacesDir }, identityId);
    let workspaceId: string;
    try {
      const created = (await server1.request('POST', '/workspaces', { name: 'durable' })).json<WorkspaceWire>();
      workspaceId = created.workspaceId;
    } finally {
      await server1.stop();
    }

    // A genuinely fresh server instance — its own apiKeyStore/keysDir,
    // nothing shared with server1 except the workspacesDir on disk and
    // the plain identityId string, exactly what would be true across a
    // real process restart.
    const server2 = await TestServer.start({ workspacesDir }, identityId);
    try {
      const fetched = await server2.request('GET', `/workspaces/${workspaceId}`);
      assert.equal(fetched.status, 200);
      assert.equal(fetched.json<WorkspaceWire>().workspaceId, workspaceId);
      assert.equal(fetched.json<WorkspaceWire>().name, 'durable');
    } finally {
      await server2.stop();
    }
  });
});

test('unauthenticated requests to workspace routes are still rejected (existing auth behavior intact)', async () => {
  await withWorkspacesDir(async (workspacesDir) => {
    const server = await TestServer.start({ workspacesDir });
    try {
      const noAuth = await server.request('POST', '/workspaces', { name: 'x' }, {}, { skipAuth: true });
      assert.equal(noAuth.status, 401);

      const listNoAuth = await server.request('GET', '/workspaces', undefined, {}, { skipAuth: true });
      assert.equal(listNoAuth.status, 401);

      const badKey = await server.request('GET', '/workspaces', undefined, { authorization: 'Bearer xoak_not_a_real_key' });
      assert.equal(badKey.status, 401);
    } finally {
      await server.stop();
    }
  });
});
