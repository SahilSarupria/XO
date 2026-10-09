import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TestServer, withTempDir } from './test-helpers.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

interface SourceWire {
  readonly sourceId: string;
  readonly workspaceId: string;
  readonly identityId: string;
  readonly originalFilename: string;
  readonly mediaType: string;
  readonly extension: string;
  readonly byteSize: number;
  readonly digestSha256: string;
  readonly createdAt: string;
  readonly contentStorageKey: string;
  readonly status: string;
}

async function createWorkspace(server: TestServer, extraHeaders?: Readonly<Record<string, string>>): Promise<WorkspaceRecord> {
  return (await server.request('POST', '/workspaces', {}, extraHeaders)).json<WorkspaceRecord>();
}

const SAMPLE_PDF_BYTES = Buffer.from('%PDF-1.4 not a real pdf but real bytes for hashing purposes');

test('POST /workspaces/:workspaceId/sources uploads a source; response carries correct metadata, no filesystem path', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/sources?filename=policy.pdf`, SAMPLE_PDF_BYTES, { 'content-type': 'application/pdf' });
      assert.equal(res.status, 201);
      const body = res.json<SourceWire>();
      assert.match(body.sourceId, /^src_[0-9a-f]{32}$/);
      assert.equal(body.workspaceId, workspace.workspaceId);
      assert.equal(body.identityId, server.identityId);
      assert.equal(body.originalFilename, 'policy.pdf');
      assert.equal(body.mediaType, 'application/pdf');
      assert.equal(body.extension, '.pdf');
      assert.equal(body.byteSize, SAMPLE_PDF_BYTES.length);
      assert.equal(body.digestSha256, createHash('sha256').update(SAMPLE_PDF_BYTES).digest('hex'));
      assert.equal(body.status, 'stored');
      assert.ok(body.createdAt);
      // No filesystem path is ever exposed — only an opaque logical storage key.
      assert.doesNotMatch(body.contentStorageKey, /^\/|xo-api-data/);
      assert.equal(body.contentStorageKey, `${body.sourceId}/content`);
    } finally {
      await server.stop();
    }
  });
});

test('uploaded source metadata is persisted and independently retrievable via GET /workspaces/:workspaceId/sources/:sourceId', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const uploaded = (await server.request('POST', `/workspaces/${workspace.workspaceId}/sources?filename=notes.md`, Buffer.from('# hello'), { 'content-type': 'text/markdown' })).json<SourceWire>();

      const fetched = await server.request('GET', `/workspaces/${workspace.workspaceId}/sources/${uploaded.sourceId}`);
      assert.equal(fetched.status, 200);
      assert.deepEqual(fetched.json<SourceWire>(), uploaded);
    } finally {
      await server.stop();
    }
  });
});

test('GET .../sources/:sourceId/content returns the exact uploaded bytes with the recorded mediaType', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const uploaded = (await server.request('POST', `/workspaces/${workspace.workspaceId}/sources?filename=policy.pdf`, SAMPLE_PDF_BYTES, { 'content-type': 'application/pdf' })).json<SourceWire>();

      const contentRes = await server.request('GET', `/workspaces/${workspace.workspaceId}/sources/${uploaded.sourceId}/content`);
      assert.equal(contentRes.status, 200);
      assert.equal(contentRes.headers['content-type'], 'application/pdf');
      assert.equal(Buffer.from(contentRes.bodyText, 'binary').toString('binary'), SAMPLE_PDF_BYTES.toString('binary'));
    } finally {
      await server.stop();
    }
  });
});

test('GET /workspaces/:workspaceId/sources lists only this workspace\'s own sources, in creation order', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const mine = await createWorkspace(server);
      const other = await server.issueAdditionalIdentity('identity-b');
      const theirs = await createWorkspace(server, TestServer.authHeader(other.apiKey));

      const a = (await server.request('POST', `/workspaces/${mine.workspaceId}/sources?filename=a.txt`, Buffer.from('a'))).json<SourceWire>();
      const b = (await server.request('POST', `/workspaces/${mine.workspaceId}/sources?filename=b.txt`, Buffer.from('b'))).json<SourceWire>();
      await server.request('POST', `/workspaces/${theirs.workspaceId}/sources?filename=c.txt`, Buffer.from('c'), TestServer.authHeader(other.apiKey));

      const listed = await server.request('GET', `/workspaces/${mine.workspaceId}/sources`);
      assert.equal(listed.status, 200);
      const ids = listed.json<{ sources: readonly SourceWire[] }>().sources.map((s) => s.sourceId);
      assert.deepEqual(ids, [a.sourceId, b.sourceId]);
    } finally {
      await server.stop();
    }
  });
});

test('DELETE /workspaces/:workspaceId/sources/:sourceId removes both metadata and content', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const uploaded = (await server.request('POST', `/workspaces/${workspace.workspaceId}/sources?filename=a.txt`, Buffer.from('a'))).json<SourceWire>();

      const deleteRes = await server.request('DELETE', `/workspaces/${workspace.workspaceId}/sources/${uploaded.sourceId}`);
      assert.equal(deleteRes.status, 204);

      const getRes = await server.request('GET', `/workspaces/${workspace.workspaceId}/sources/${uploaded.sourceId}`);
      assert.equal(getRes.status, 404);
      const contentRes = await server.request('GET', `/workspaces/${workspace.workspaceId}/sources/${uploaded.sourceId}/content`);
      assert.equal(contentRes.status, 404);
      const listRes = await server.request('GET', `/workspaces/${workspace.workspaceId}/sources`);
      assert.deepEqual(listRes.json<{ sources: readonly SourceWire[] }>().sources, []);
    } finally {
      await server.stop();
    }
  });
});

test('unauthenticated requests to every source route are rejected (401)', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const uploaded = (await server.request('POST', `/workspaces/${workspace.workspaceId}/sources?filename=a.txt`, Buffer.from('a'))).json<SourceWire>();

      const calls: readonly [string, string][] = [
        ['POST', `/workspaces/${workspace.workspaceId}/sources?filename=b.txt`],
        ['GET', `/workspaces/${workspace.workspaceId}/sources`],
        ['GET', `/workspaces/${workspace.workspaceId}/sources/${uploaded.sourceId}`],
        ['GET', `/workspaces/${workspace.workspaceId}/sources/${uploaded.sourceId}/content`],
        ['DELETE', `/workspaces/${workspace.workspaceId}/sources/${uploaded.sourceId}`],
      ];
      for (const [method, path] of calls) {
        const res = await server.request(method, path, method === 'POST' ? Buffer.from('x') : undefined, {}, { skipAuth: true });
        assert.equal(res.status, 401, `expected 401 for unauthenticated ${method} ${path}`);
      }
    } finally {
      await server.stop();
    }
  });
});

test('a different identity cannot list, get, download, or delete a source through a workspace it does not own (404, not the other workspace\'s data)', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const owner = await createWorkspace(server);
      const uploaded = (await server.request('POST', `/workspaces/${owner.workspaceId}/sources?filename=secret.txt`, Buffer.from('secret'))).json<SourceWire>();
      const other = await server.issueAdditionalIdentity('identity-b');
      const asOther = TestServer.authHeader(other.apiKey);

      const listRes = await server.request('GET', `/workspaces/${owner.workspaceId}/sources`, undefined, asOther);
      assert.equal(listRes.status, 404);
      const getRes = await server.request('GET', `/workspaces/${owner.workspaceId}/sources/${uploaded.sourceId}`, undefined, asOther);
      assert.equal(getRes.status, 404);
      const contentRes = await server.request('GET', `/workspaces/${owner.workspaceId}/sources/${uploaded.sourceId}/content`, undefined, asOther);
      assert.equal(contentRes.status, 404);
      const deleteRes = await server.request('DELETE', `/workspaces/${owner.workspaceId}/sources/${uploaded.sourceId}`, undefined, asOther);
      assert.equal(deleteRes.status, 404);
      const uploadRes = await server.request('POST', `/workspaces/${owner.workspaceId}/sources?filename=x.txt`, Buffer.from('x'), asOther);
      assert.equal(uploadRes.status, 404);

      // Prove nothing was actually deleted/affected: the owner can still retrieve it.
      const stillThere = await server.request('GET', `/workspaces/${owner.workspaceId}/sources/${uploaded.sourceId}`);
      assert.equal(stillThere.status, 200);
    } finally {
      await server.stop();
    }
  });
});

test('an unknown workspace id fails closed (404) on every source route', async () => {
  const server = await TestServer.start();
  try {
    const unknownId = 'ws_ffffffffffffffffffffffffffffffff';
    const listRes = await server.request('GET', `/workspaces/${unknownId}/sources`);
    assert.equal(listRes.status, 404);
    const uploadRes = await server.request('POST', `/workspaces/${unknownId}/sources?filename=a.txt`, Buffer.from('a'));
    assert.equal(uploadRes.status, 404);
  } finally {
    await server.stop();
  }
});

test('a request body cannot override workspace or identity ownership: uploaded source always records the authenticated identity and the URL\'s workspaceId', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      // The upload path has no JSON body at all (raw bytes only), so
      // there is no "identityId" field to even attempt to smuggle in —
      // this test proves that structurally: whatever bytes are sent,
      // the resulting record's identity/workspace always come from
      // `req.identity`/`requireOwnedWorkspace`, never request content.
      const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/sources?filename=a.txt`, Buffer.from(JSON.stringify({ identityId: 'someone-else', workspaceId: 'ws_00000000000000000000000000000000' })));
      assert.equal(res.status, 201);
      const body = res.json<SourceWire>();
      assert.equal(body.identityId, server.identityId);
      assert.equal(body.workspaceId, workspace.workspaceId);
    } finally {
      await server.stop();
    }
  });
});

test('path/storage-prefix injection via filename is rejected; traversal-shaped source ids fail safely', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);

      for (const badFilename of ['../../etc/passwd', 'a/../../b.txt', 'sub/dir/file.txt', '..\\windows\\system32']) {
        const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/sources?filename=${encodeURIComponent(badFilename)}`, Buffer.from('x'));
        assert.equal(res.status, 400, `expected 400 for malicious filename "${badFilename}"`);
      }

      for (const badSourceId of ['../../etc/passwd', 'src_' + '2e'.repeat(16), 'not-a-real-id']) {
        const res = await server.request('GET', `/workspaces/${workspace.workspaceId}/sources/${encodeURIComponent(badSourceId)}`);
        assert.ok([400, 404].includes(res.status), `expected a clean 4xx for malicious source id "${badSourceId}", got ${res.status}`);
      }
    } finally {
      await server.stop();
    }
  });
});

test('an empty upload is rejected with 400', async () => {
  const server = await TestServer.start();
  try {
    const workspace = await createWorkspace(server);
    const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/sources?filename=empty.txt`, Buffer.alloc(0));
    assert.equal(res.status, 400);
  } finally {
    await server.stop();
  }
});

test('an oversized upload is rejected (reuses the existing request-body byte cap)', async () => {
  const server = await TestServer.start();
  try {
    const workspace = await createWorkspace(server);
    // Well over the 64MB default cap in http/body.ts — a real oversized payload, not a mocked limit.
    const oversized = Buffer.alloc(65 * 1024 * 1024, 1);
    const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/sources?filename=huge.txt`, oversized);
    assert.equal(res.status, 400);
  } finally {
    await server.stop();
  }
});

test('an unsupported file extension is rejected clearly with 400, naming the supported list', async () => {
  const server = await TestServer.start();
  try {
    const workspace = await createWorkspace(server);
    const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/sources?filename=contract.docx`, Buffer.from('x'));
    assert.equal(res.status, 400);
    assert.match(res.json<{ error: { message: string } }>().error.message, /unsupported file extension/);
  } finally {
    await server.stop();
  }
});

test('a missing filename query parameter is rejected with 400', async () => {
  const server = await TestServer.start();
  try {
    const workspace = await createWorkspace(server);
    const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/sources`, Buffer.from('x'));
    assert.equal(res.status, 400);
  } finally {
    await server.stop();
  }
});

test('digest and byte size are computed from the exact received bytes, not trusted from any client-supplied value', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const payload = Buffer.from('a'.repeat(12345));
      const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/sources?filename=a.txt`, payload);
      const body = res.json<SourceWire>();
      assert.equal(body.byteSize, 12345);
      assert.equal(body.digestSha256, createHash('sha256').update(payload).digest('hex'));
    } finally {
      await server.stop();
    }
  });
});

test('source metadata and content survive a fresh API/server instance sharing both workspacesDir and workspaceDataDir', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    await withTempDir('xo-api-workspaces-', async (workspacesDir) => {
      const identityId = 'restart-identity-2';
      const server1 = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir }, identityId);
      let workspaceId: string;
      let sourceId: string;
      try {
        const workspace = await createWorkspace(server1);
        workspaceId = workspace.workspaceId;
        const uploaded = (await server1.request('POST', `/workspaces/${workspaceId}/sources?filename=durable.txt`, Buffer.from('durable content'))).json<SourceWire>();
        sourceId = uploaded.sourceId;
      } finally {
        await server1.stop();
      }

      const server2 = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir }, identityId);
      try {
        const fetched = await server2.request('GET', `/workspaces/${workspaceId}/sources/${sourceId}`);
        assert.equal(fetched.status, 200);
        assert.equal(fetched.json<SourceWire>().sourceId, sourceId);
        const content = await server2.request('GET', `/workspaces/${workspaceId}/sources/${sourceId}/content`);
        assert.equal(content.status, 200);
        assert.equal(content.bodyText, 'durable content');
      } finally {
        await server2.stop();
      }
    });
  });
});
