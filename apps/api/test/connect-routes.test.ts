import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  InMemoryConnectStateStore,
  createConnectService,
  failResult,
  okResult,
  type ConnectResult,
  type FolderEntry,
  type Listing,
  type LocalFolderBackend,
  type ReadOutcome,
  type SourceFacts,
} from '@xo/connect';
import { TestServer } from './test-helpers.js';

const entry = (key: string): FolderEntry => ({
  key,
  name: key,
  extension: '.txt',
  sizeBytes: 1,
  modifiedAt: '2026-11-01T00:00:00.000Z',
  depth: 0,
  contentAcquirable: true,
});

class Backend implements LocalFolderBackend {
  maxItemsPerRead = 10;
  denied = false;
  reads: string[][] = [];
  async list(_p: unknown, r: { root: string }): Promise<ConnectResult<Listing>> {
    if (this.denied) return failResult('denied', 'denied');
    return okResult({
      sourceId: 'src-' + createHash('sha256').update(r.root).digest('hex').slice(0, 12),
      entries: [entry('a.txt'), entry('b.txt')],
      truncated: false,
      totalBytes: 2,
      skippedByReason: {},
      limitsHit: [],
    });
  }
  async read(_p: unknown, r: { keys: readonly string[] }): Promise<ConnectResult<ReadOutcome>> {
    this.reads.push([...r.keys]);
    return okResult({ itemsRead: r.keys.length, partial: false, errorCodes: [] });
  }
  facts(): SourceFacts {
    return { authorization: 'granted', connection: 'validated', acquisition: 'succeeded', unavailable: false };
  }
}

const withServer = async (fn: (s: TestServer, b: Backend) => Promise<void>): Promise<void> => {
  const backend = new Backend();
  const connect = createConnectService({ backend, store: new InMemoryConnectStateStore() });
  const server = await TestServer.start({ connect });
  try {
    await fn(server, backend);
  } finally {
    await server.stop();
  }
};

test('connect routes are not registered when no Connect service is supplied', async () => {
  const server = await TestServer.start({});
  try {
    assert.equal((await server.request('GET', '/connect/sources')).status, 404);
  } finally {
    await server.stop();
  }
});

test('unauthenticated requests are refused before any Connect logic runs', async () => {
  await withServer(async (s, b) => {
    for (const [m, p] of [
      ['GET', '/connect/sources'],
      ['GET', '/connect/dashboard'],
      ['POST', '/connect/local-folders'],
      ['POST', '/connect/sources/x/read'],
    ] as const)
      assert.equal((await s.request(m, p, m === 'POST' ? {} : undefined, {}, { skipAuth: true })).status, 401);
    assert.deepEqual(b.reads, []);
  });
});

test('catalog marks cloud sources coming soon', async () => {
  await withServer(async (s) => {
    const r = await s.request('GET', '/connect/catalog');
    assert.equal(r.status, 200);
    const { sources } = r.json<{ sources: { kind: string; availability: string }[] }>();
    assert.equal(sources.find((x) => x.kind === 'microsoft_365')?.availability, 'coming_soon');
    assert.equal(sources.find((x) => x.kind === 'local_folder')?.availability, 'available');
  });
});

test('journey over HTTP: preview, connect, read, disconnect; identity comes from the key, never the body', async () => {
  await withServer(async (s, b) => {
    const pv = await s.request('POST', '/connect/local-folders/preview', { root: '/data/x' });
    assert.equal(pv.status, 200);
    const c = await s.request('POST', '/connect/local-folders', {
      root: '/data/x',
      includeKeys: ['a.txt'],
      ownerId: 'someone-else',
      principal: { id: 'evil' },
    });
    assert.equal(c.status, 201);
    const id = c.json<{ source: { id: string } }>().source.id;
    assert.equal((await s.request('POST', `/connect/sources/${id}/read`)).status, 200);
    assert.deepEqual(b.reads, [['a.txt']]);
    const list = await s.request('GET', '/connect/sources');
    assert.equal(list.json<{ sources: unknown[] }>().sources.length, 1);
    const d = await s.request('POST', `/connect/sources/${id}/disconnect`);
    assert.equal(d.json<{ effects: { existingKnowledge: string } }>().effects.existingKnowledge, 'kept');
    assert.equal((await s.request('POST', `/connect/sources/${id}/read`)).status, 409);
    assert.equal(b.reads.length, 1);
  });
});

test('another identity cannot see or act on the source', async () => {
  await withServer(async (s) => {
    const c = await s.request('POST', '/connect/local-folders', { root: '/data/x', includeKeys: ['a.txt'] });
    const id = c.json<{ source: { id: string } }>().source.id;
    const other = await s.issueAdditionalIdentity('other-identity');
    const h = TestServer.authHeader(other.apiKey);
    assert.equal((await s.request('GET', `/connect/sources/${id}`, undefined, h)).status, 404);
    assert.equal((await s.request('POST', `/connect/sources/${id}/read`, undefined, h)).status, 404);
    assert.equal((await s.request('POST', `/connect/sources/${id}/disconnect`, undefined, h)).status, 404);
    assert.equal((await s.request('GET', '/connect/sources', undefined, h)).json<{ sources: unknown[] }>().sources.length, 0);
  });
});

test('errors map to stable statuses and carry no internals', async () => {
  await withServer(async (s, b) => {
    assert.equal((await s.request('POST', '/connect/local-folders', { root: '/data/x', includeKeys: [] })).status, 400);
    assert.equal((await s.request('POST', '/connect/local-folders', { root: 'relative', includeKeys: ['a.txt'] })).status, 400);
    assert.equal((await s.request('POST', '/connect/local-folders', { root: '/d', includeKeys: ['../etc/passwd'] })).status, 400);
    assert.equal(
      (await s.request('POST', '/connect/local-folders', Buffer.from('not json'), { 'content-type': 'application/json' })).status,
      400,
    );
    b.denied = true;
    const d = await s.request('POST', '/connect/local-folders', { root: '/data/y', includeKeys: ['a.txt'] });
    assert.equal(d.status, 403);
    assert.deepEqual(Object.keys(d.json<{ error: object }>().error).sort(), ['code', 'message', 'retryable']);
    assert.equal((await s.request('GET', '/connect/sources/nope')).status, 404);
  });
});

test('capabilities: 503 when no authorization gate is configured (never a guessed "allowed")', async () => {
  await withServer(async (s) => {
    assert.equal((await s.request('GET', '/connect/capabilities')).status, 503);
  });
});

test('knowledge routes: validated at the edge and 503 when the host keeps no knowledge', async () => {
  await withServer(async (s) => {
    assert.equal((await s.request('GET', '/connect/knowledge')).status, 400, 'neither q nor select');
    assert.equal((await s.request('GET', '/connect/knowledge?q=a&select=entities')).status, 400, 'both');
    assert.equal((await s.request('GET', '/connect/knowledge?q=a&limit=x')).status, 400);
    assert.equal((await s.request('GET', '/connect/knowledge?q=atlas')).status, 503);
    assert.equal((await s.request('GET', '/connect/knowledge/review')).status, 503);
  });
});
