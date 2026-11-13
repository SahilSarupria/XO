// UW-3 — resumable uploads: chunked, resumable after a dropped connection, verified, and stored through the same door as any upload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { LocalFsBlobStore } from '@xo/storage';
import { TestServer, withTempDir } from './test-helpers.js';
import { MAX_OPEN_SESSIONS_PER_IDENTITY, UPLOAD_SESSION_TTL_MS, UploadSessionStore } from '../src/sources/upload-sessions.js';

interface SessionWire {
  uploadId: string;
  offset: number;
  size: number;
  maxChunkBytes: number;
}

async function withWorkspace(fn: (server: TestServer, base: string) => Promise<void>): Promise<void> {
  await withTempDir('xo-resumable-', async (dir) => {
    const server = await TestServer.start({ workspaceDataDir: join(dir, 'data'), workspacesDir: join(dir, 'workspaces') });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      await fn(server, `/workspaces/${ws}`);
    } finally {
      await server.stop();
    }
  });
}

const file = Buffer.from('id,decision\n' + Array.from({ length: 400 }, (_, i) => `${i},${i % 2 === 0 ? 'paid' : 'denied'}`).join('\n'));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

test('a file sent in chunks, interrupted and resumed from the server offset, completes into an ordinary source', async () => {
  await withWorkspace(async (server, base) => {
    const opened = await server.request('POST', `${base}/uploads`, { filename: 'claims.csv', size: file.length, sha256: sha(file) });
    assert.equal(opened.status, 201, opened.bodyText);
    const s = opened.json<SessionWire>();
    assert.equal(s.offset, 0);
    const third = Math.ceil(file.length / 3);

    const first = await server.request('PUT', `${base}/uploads/${s.uploadId}?offset=0`, file.subarray(0, third));
    assert.equal(first.json<SessionWire>().offset, third);
    // the phone lost the response and re-sends the same chunk: refused, and the client learns where to continue
    const replay = await server.request('PUT', `${base}/uploads/${s.uploadId}?offset=0`, file.subarray(0, third));
    assert.equal(replay.status, 412);
    assert.match(replay.bodyText, new RegExp(`continues at byte ${third}`));
    const status = (await server.request('GET', `${base}/uploads/${s.uploadId}`)).json<SessionWire>();
    assert.equal(status.offset, third);

    await server.request('PUT', `${base}/uploads/${s.uploadId}?offset=${third}`, file.subarray(third, 2 * third));
    const early = await server.request('POST', `${base}/uploads/${s.uploadId}/complete`);
    assert.equal(early.status, 412, 'not complete until every byte is in');
    await server.request('PUT', `${base}/uploads/${s.uploadId}?offset=${2 * third}`, file.subarray(2 * third));

    const done = await server.request('POST', `${base}/uploads/${s.uploadId}/complete`);
    assert.equal(done.status, 201, done.bodyText);
    const rec = done.json<{ sourceId: string; stats: { rows: number }; digestSha256: string; originalFilename: string }>();
    assert.equal(rec.originalFilename, 'claims.csv');
    assert.equal(rec.stats.rows, 400, 'the same door-time reading as a single-request upload');
    const content = await server.request('GET', `${base}/sources/${rec.sourceId}/content`);
    assert.equal(content.bodyText, file.toString('utf8'), 'the stored bytes are exactly the file');
    assert.equal((await server.request('GET', `${base}/uploads/${s.uploadId}`)).status, 404, 'the session is gone once stored');
    const audit = (await server.request('GET', `${base}/audit/events?event=source.uploaded`)).json<{ events: unknown[] }>().events;
    assert.equal(audit.length, 1);
  });
});

test('refusals: bad offsets, oversized or empty chunks, a wrong checksum, a broken file at the door, another person, bad sessions', async () => {
  await withWorkspace(async (server, base) => {
    const open = async (body: unknown) => server.request('POST', `${base}/uploads`, body);
    assert.equal((await open({ filename: 'x.exe', size: 10 })).status, 400);
    assert.equal((await open({ filename: '../x.csv', size: 10 })).status, 400);
    assert.equal((await open({ filename: 'x.csv', size: 0 })).status, 400);
    assert.equal((await open({ filename: 'x.csv', size: 10, sha256: 'ABC' })).status, 400);

    const s = (await open({ filename: 'x.csv', size: 10, sha256: sha(Buffer.from('0123456789')) })).json<SessionWire>();
    const put = (offset: number, body: Buffer) => server.request('PUT', `${base}/uploads/${s.uploadId}?offset=${offset}`, body);
    assert.equal((await put(3, Buffer.from('abc'))).status, 412, 'a gap is refused');
    assert.equal((await put(0, Buffer.from('0123456789AB'))).status, 400, 'past the declared size');
    assert.equal((await server.request('PUT', `${base}/uploads/${s.uploadId}`, Buffer.from('a'))).status, 400, 'offset is required');
    await put(0, Buffer.from('9876543210'));
    const wrong = await server.request('POST', `${base}/uploads/${s.uploadId}/complete`);
    assert.equal(wrong.status, 422);
    assert.match(wrong.bodyText, /XO_UPLOAD_INTEGRITY_FAILED/);
    assert.equal((await server.request('GET', `${base}/uploads/${s.uploadId}`)).status, 404, 'a mismatched upload is discarded');

    const broken = Buffer.from('name,amount\n"never closed,1');
    const b = (await open({ filename: 'broken.csv', size: broken.length })).json<SessionWire>();
    await server.request('PUT', `${base}/uploads/${b.uploadId}?offset=0`, broken);
    const refused = await server.request('POST', `${base}/uploads/${b.uploadId}/complete`);
    assert.equal(refused.status, 400);
    assert.match(refused.bodyText, /never closed/);
    assert.equal((await server.request('GET', `${base}/sources`)).json<{ sources: unknown[] }>().sources.length, 0);

    const other = await server.issueAdditionalIdentity('someone-else');
    const theirs = await server.request('GET', `${base}/uploads/${b.uploadId}`, undefined, TestServer.authHeader(other.apiKey));
    assert.equal(theirs.status, 404, 'another identity cannot see it (and is not even a member)');
    assert.equal((await server.request('GET', `${base}/uploads/upl_${'0'.repeat(32)}`)).status, 404);
    assert.equal((await server.request('GET', `${base}/uploads/not-an-id`)).status, 404);
    assert.equal((await server.request('DELETE', `${base}/uploads/${b.uploadId}`)).status, 200);
    assert.equal((await server.request('GET', `${base}/uploads/${b.uploadId}`)).status, 404);
  });
});

test('sessions expire, and one identity cannot hold more than the limit open', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-upload-store-'));
  try {
    let now = new Date('2026-11-13T00:00:00Z');
    const store = new UploadSessionStore(new LocalFsBlobStore(dir), () => now);
    const input = { identityId: 'alice', filename: 'a.csv', extension: '.csv', mediaType: 'text/csv', size: 5 };
    const first = await store.open(input);
    for (let i = 1; i < MAX_OPEN_SESSIONS_PER_IDENTITY; i++) await store.open(input);
    await assert.rejects(store.open(input), (e: { code?: string }) => e.code === 'XO_UPLOAD_SESSION_LIMIT');
    await store.open({ ...input, identityId: 'bob' });
    now = new Date(now.getTime() + UPLOAD_SESSION_TTL_MS + 1);
    await assert.rejects(store.get(first.uploadId, 'alice'), /expired/);
    await store.open(input); // expired sessions no longer count
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
