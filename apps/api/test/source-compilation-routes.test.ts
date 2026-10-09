import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TestServer, withTempDir } from './test-helpers.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

interface SourceWire {
  readonly sourceId: string;
  readonly digestSha256: string;
}

interface CompilationWire {
  readonly compilationId: string;
  readonly workspaceId: string;
  readonly identityId: string;
  readonly sourceId: string;
  readonly sourceDigestSha256: string;
  readonly status: 'running' | 'succeeded' | 'failed';
  readonly createdAt: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly resultStorageKey?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

interface CapabilityWire {
  readonly capabilityId: string;
  readonly contractId: string;
  readonly name: string;
  readonly description: string;
  readonly status: string;
  readonly executionClass?: string;
  readonly confidence: number;
}

/** Proven to produce discoverable capabilities — the exact same fixture `apps/cli/test/workflow.test.ts` uses. */
const OBLIGATION_MARKDOWN =
  '# Vendor Agreement\n\n' +
  'Acme Corp shall send a confirmation email to the Client upon completion of each milestone.\n\n' +
  'The team shall generate a summary report weekly and deliver it to the Client.\n' +
  'The team shall notify the Client of any delay within 24 hours.\n';

async function createWorkspace(server: TestServer, extraHeaders?: Readonly<Record<string, string>>): Promise<WorkspaceRecord> {
  return (await server.request('POST', '/workspaces', {}, extraHeaders)).json<WorkspaceRecord>();
}

async function uploadSource(server: TestServer, workspaceId: string, filename: string, bytes: Buffer, extraHeaders?: Readonly<Record<string, string>>): Promise<SourceWire> {
  return (await server.request('POST', `/workspaces/${workspaceId}/sources?filename=${filename}`, bytes, extraHeaders)).json<SourceWire>();
}

test('POST .../sources/:sourceId/compile succeeds for a real, extractable markdown source and returns 201 with a succeeded record', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const source = await uploadSource(server, workspace.workspaceId, 'agreement.md', Buffer.from(OBLIGATION_MARKDOWN));

      const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/sources/${source.sourceId}/compile`);
      assert.equal(res.status, 201);
      const body = res.json<CompilationWire>();
      assert.match(body.compilationId, /^cmp_[0-9a-f]{32}$/);
      assert.equal(body.workspaceId, workspace.workspaceId);
      assert.equal(body.identityId, server.identityId);
      assert.equal(body.sourceId, source.sourceId);
      assert.equal(body.status, 'succeeded');
      assert.ok(body.startedAt);
      assert.ok(body.completedAt);
      assert.equal(body.errorCode, undefined);
    } finally {
      await server.stop();
    }
  });
});

test('compilation record is persisted and independently retrievable via GET .../compilations/:compilationId', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const source = await uploadSource(server, workspace.workspaceId, 'agreement.md', Buffer.from(OBLIGATION_MARKDOWN));
      const compiled = (await server.request('POST', `/workspaces/${workspace.workspaceId}/sources/${source.sourceId}/compile`)).json<CompilationWire>();

      const fetched = await server.request('GET', `/workspaces/${workspace.workspaceId}/compilations/${compiled.compilationId}`);
      assert.equal(fetched.status, 200);
      assert.deepEqual(fetched.json<CompilationWire>(), compiled);

      const listed = await server.request('GET', `/workspaces/${workspace.workspaceId}/compilations`);
      assert.equal(listed.status, 200);
      const ids = listed.json<{ compilations: readonly CompilationWire[] }>().compilations.map((c) => c.compilationId);
      assert.deepEqual(ids, [compiled.compilationId]);
    } finally {
      await server.stop();
    }
  });
});

test('GET .../compilations/:compilationId/capabilities returns capabilities derived from the real compiled result', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const source = await uploadSource(server, workspace.workspaceId, 'agreement.md', Buffer.from(OBLIGATION_MARKDOWN));
      const compiled = (await server.request('POST', `/workspaces/${workspace.workspaceId}/sources/${source.sourceId}/compile`)).json<CompilationWire>();

      const res = await server.request('GET', `/workspaces/${workspace.workspaceId}/compilations/${compiled.compilationId}/capabilities`);
      assert.equal(res.status, 200);
      const body = res.json<{ compilationId: string; capabilities: readonly CapabilityWire[] }>();
      assert.equal(body.compilationId, compiled.compilationId);
      assert.ok(body.capabilities.length > 0, 'expected at least one discovered capability from obligation-language markdown');
      for (const cap of body.capabilities) {
        assert.ok(cap.capabilityId.length > 0);
        assert.ok(cap.contractId.length > 0);
        assert.ok(['resolved', 'unresolved', 'ambiguous', 'denied'].includes(cap.status));
        assert.equal(typeof cap.confidence, 'number');
      }
    } finally {
      await server.stop();
    }
  });
});

test('source digest is recorded correctly at compilation time', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const payload = Buffer.from(OBLIGATION_MARKDOWN);
      const source = await uploadSource(server, workspace.workspaceId, 'agreement.md', payload);
      assert.equal(source.digestSha256, createHash('sha256').update(payload).digest('hex'));

      const compiled = (await server.request('POST', `/workspaces/${workspace.workspaceId}/sources/${source.sourceId}/compile`)).json<CompilationWire>();
      assert.equal(compiled.sourceDigestSha256, source.digestSha256);
    } finally {
      await server.stop();
    }
  });
});

test('an unknown workspace returns 404 on every compilation route', async () => {
  const server = await TestServer.start();
  try {
    const unknownId = 'ws_ffffffffffffffffffffffffffffffff';
    assert.equal((await server.request('POST', `/workspaces/${unknownId}/sources/src_ffffffffffffffffffffffffffffffff/compile`)).status, 404);
    assert.equal((await server.request('GET', `/workspaces/${unknownId}/compilations`)).status, 404);
    assert.equal((await server.request('GET', `/workspaces/${unknownId}/compilations/cmp_ffffffffffffffffffffffffffffffff`)).status, 404);
    assert.equal((await server.request('GET', `/workspaces/${unknownId}/compilations/cmp_ffffffffffffffffffffffffffffffff/capabilities`)).status, 404);
  } finally {
    await server.stop();
  }
});

test('cross-identity workspace access returns 404 on compile/list/get/capabilities', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const owner = await createWorkspace(server);
      const source = await uploadSource(server, owner.workspaceId, 'agreement.md', Buffer.from(OBLIGATION_MARKDOWN));
      const compiled = (await server.request('POST', `/workspaces/${owner.workspaceId}/sources/${source.sourceId}/compile`)).json<CompilationWire>();

      const other = await server.issueAdditionalIdentity('identity-b');
      const asOther = TestServer.authHeader(other.apiKey);

      assert.equal((await server.request('POST', `/workspaces/${owner.workspaceId}/sources/${source.sourceId}/compile`, undefined, asOther)).status, 404);
      assert.equal((await server.request('GET', `/workspaces/${owner.workspaceId}/compilations`, undefined, asOther)).status, 404);
      assert.equal((await server.request('GET', `/workspaces/${owner.workspaceId}/compilations/${compiled.compilationId}`, undefined, asOther)).status, 404);
      assert.equal((await server.request('GET', `/workspaces/${owner.workspaceId}/compilations/${compiled.compilationId}/capabilities`, undefined, asOther)).status, 404);
    } finally {
      await server.stop();
    }
  });
});

test('an unknown source id returns 404 from the compile route', async () => {
  const server = await TestServer.start();
  try {
    const workspace = await createWorkspace(server);
    const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/sources/src_ffffffffffffffffffffffffffffffff/compile`);
    assert.equal(res.status, 404);
  } finally {
    await server.stop();
  }
});

test('a source uploaded to a different (owned) workspace cannot be compiled through this workspace\'s route (404, cross-workspace source)', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspaceA = await createWorkspace(server);
      const workspaceB = await createWorkspace(server);
      const sourceInA = await uploadSource(server, workspaceA.workspaceId, 'agreement.md', Buffer.from(OBLIGATION_MARKDOWN));

      const res = await server.request('POST', `/workspaces/${workspaceB.workspaceId}/sources/${sourceInA.sourceId}/compile`);
      assert.equal(res.status, 404);
    } finally {
      await server.stop();
    }
  });
});

test('unauthenticated requests to every compilation route are rejected (401)', async () => {
  const server = await TestServer.start();
  try {
    const workspace = await createWorkspace(server);
    const calls: readonly [string, string][] = [
      ['POST', `/workspaces/${workspace.workspaceId}/sources/src_ffffffffffffffffffffffffffffffff/compile`],
      ['GET', `/workspaces/${workspace.workspaceId}/compilations`],
      ['GET', `/workspaces/${workspace.workspaceId}/compilations/cmp_ffffffffffffffffffffffffffffffff`],
      ['GET', `/workspaces/${workspace.workspaceId}/compilations/cmp_ffffffffffffffffffffffffffffffff/capabilities`],
    ];
    for (const [method, path] of calls) {
      const res = await server.request(method, path, undefined, {}, { skipAuth: true });
      assert.equal(res.status, 401, `expected 401 for unauthenticated ${method} ${path}`);
    }
  } finally {
    await server.stop();
  }
});

test('a client cannot override identity/workspace ownership: the compilation record always records the authenticated identity and the URL workspaceId, and cannot select an arbitrary result storage key', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const source = await uploadSource(server, workspace.workspaceId, 'agreement.md', Buffer.from(OBLIGATION_MARKDOWN));

      // The compile route has no request body at all — there is no
      // "identityId"/"resultStorageKey" field to even attempt to
      // smuggle in. Confirm that structurally by sending an
      // (ignored) body anyway.
      const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/sources/${source.sourceId}/compile`, { identityId: 'someone-else', resultStorageKey: '../../etc/passwd' });
      assert.equal(res.status, 201);
      const body = res.json<CompilationWire>();
      assert.equal(body.identityId, server.identityId);
      assert.equal(body.workspaceId, workspace.workspaceId);
      assert.notEqual(body.resultStorageKey, '../../etc/passwd');
      assert.doesNotMatch(body.resultStorageKey ?? '', /\.\./);
    } finally {
      await server.stop();
    }
  });
});

test('compiling malformed content of a supported extension is represented as an honest failed compilation, not a crash or a fabricated success', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      // A .pdf-extension upload whose bytes are not a real PDF —
      // SUPPORTED_EXTENSIONS accepts the extension (P0.3's upload gate
      // only checks extension, not content), so this reaches the
      // compiler, which must genuinely fail to parse it.
      const source = await uploadSource(server, workspace.workspaceId, 'fake.pdf', Buffer.from('this is not a real pdf file'), { 'content-type': 'application/pdf' });

      const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/sources/${source.sourceId}/compile`);
      assert.equal(res.status, 200); // failed compilations are still a normal, successful HTTP response about that failure
      const body = res.json<CompilationWire>();
      assert.equal(body.status, 'failed');
      assert.ok(body.errorCode);
      assert.ok(body.errorMessage);
      assert.equal(body.resultStorageKey, undefined);

      // The failure is durably persisted, not just returned once.
      const fetched = await server.request('GET', `/workspaces/${workspace.workspaceId}/compilations/${body.compilationId}`);
      assert.equal(fetched.json<CompilationWire>().status, 'failed');

      // No capabilities exist for a failed compilation — fails closed, never an empty-but-200 fabrication.
      const capsRes = await server.request('GET', `/workspaces/${workspace.workspaceId}/compilations/${body.compilationId}/capabilities`);
      assert.equal(capsRes.status, 404);
    } finally {
      await server.stop();
    }
  });
});

test('every compile request creates a new compilation record (no digest-based reuse) — documented, deliberate behavior', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const source = await uploadSource(server, workspace.workspaceId, 'agreement.md', Buffer.from(OBLIGATION_MARKDOWN));

      const first = (await server.request('POST', `/workspaces/${workspace.workspaceId}/sources/${source.sourceId}/compile`)).json<CompilationWire>();
      const second = (await server.request('POST', `/workspaces/${workspace.workspaceId}/sources/${source.sourceId}/compile`)).json<CompilationWire>();

      assert.notEqual(first.compilationId, second.compilationId);
      assert.equal(first.sourceDigestSha256, second.sourceDigestSha256);
      assert.equal(first.status, 'succeeded');
      assert.equal(second.status, 'succeeded');

      const listed = await server.request('GET', `/workspaces/${workspace.workspaceId}/compilations`);
      assert.equal(listed.json<{ compilations: readonly CompilationWire[] }>().compilations.length, 2);
    } finally {
      await server.stop();
    }
  });
});

test('compilation results persist after a fresh server instance starts against the same workspacesDir/workspaceDataDir', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    await withTempDir('xo-api-workspaces-', async (workspacesDir) => {
      const identityId = 'restart-identity';
      const server1 = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir }, identityId);
      let workspaceId: string;
      let compilationId: string;
      try {
        const workspace = await createWorkspace(server1);
        workspaceId = workspace.workspaceId;
        const source = await uploadSource(server1, workspaceId, 'agreement.md', Buffer.from(OBLIGATION_MARKDOWN));
        const compiled = (await server1.request('POST', `/workspaces/${workspaceId}/sources/${source.sourceId}/compile`)).json<CompilationWire>();
        compilationId = compiled.compilationId;
      } finally {
        await server1.stop();
      }

      const server2 = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir }, identityId);
      try {
        const fetched = await server2.request('GET', `/workspaces/${workspaceId}/compilations/${compilationId}`);
        assert.equal(fetched.status, 200);
        assert.equal(fetched.json<CompilationWire>().status, 'succeeded');

        const capsRes = await server2.request('GET', `/workspaces/${workspaceId}/compilations/${compilationId}/capabilities`);
        assert.equal(capsRes.status, 200);
        assert.ok(capsRes.json<{ capabilities: readonly CapabilityWire[] }>().capabilities.length > 0);
      } finally {
        await server2.stop();
      }
    });
  });
});

test('Workspace A cannot retrieve Workspace B\'s compilations or capabilities even when both are owned by the same identity', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspaceA = await createWorkspace(server);
      const workspaceB = await createWorkspace(server);

      const sourceB = await uploadSource(server, workspaceB.workspaceId, 'agreement.md', Buffer.from(OBLIGATION_MARKDOWN));
      const compiledB = (await server.request('POST', `/workspaces/${workspaceB.workspaceId}/sources/${sourceB.sourceId}/compile`)).json<CompilationWire>();

      // B's compilation is not reachable via A's own (empty) compilations list or by id under A's workspace.
      const listUnderA = await server.request('GET', `/workspaces/${workspaceA.workspaceId}/compilations`);
      assert.deepEqual(listUnderA.json<{ compilations: readonly CompilationWire[] }>().compilations, []);
      const getUnderA = await server.request('GET', `/workspaces/${workspaceA.workspaceId}/compilations/${compiledB.compilationId}`);
      assert.equal(getUnderA.status, 404);
      const capsUnderA = await server.request('GET', `/workspaces/${workspaceA.workspaceId}/compilations/${compiledB.compilationId}/capabilities`);
      assert.equal(capsUnderA.status, 404);
    } finally {
      await server.stop();
    }
  });
});
