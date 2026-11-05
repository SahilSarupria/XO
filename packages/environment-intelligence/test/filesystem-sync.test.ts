/**
 * C7 / D-1: `LocalFilesystemConnector.incrementalSync` over the chosen items, and the REAL ingestion path (durable state store, evidence
 * ledger, audit recorder) fed by the real filesystem connector. Real files in a temp directory; the platform gate is stood in for by the
 * scripted test port (development authority), as in the other C4 tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MockClock } from '@xo/testing';
import {
  ConnectorRegistry,
  DiscoveryErrorCode,
  EiStateStore,
  EnvironmentInventory,
  EvidenceLedger,
  LocalFilesystemConnector,
  discoverSource,
  ingestSource,
  syncSource,
  type ConnectorContext,
  type FilesystemScope,
  type SourceId,
} from '../src/index.js';
import { TEST_PRINCIPAL, withSandbox } from './helpers.js';
import { readGrant } from './support/audit-grants.js';
import { FlakyRecorder } from './support/scripted-sync.js';
import { ScriptedAuthorization } from './support/scripted-authorization.js';

interface Env {
  readonly root: string;
  readonly outside: string;
  readonly deps: { registry: ConnectorRegistry; inventory: EnvironmentInventory };
  readonly ledger: EvidenceLedger;
  readonly store: EiStateStore;
  readonly recorder: FlakyRecorder;
  readonly authz: ScriptedAuthorization;
  readonly ctx: ConnectorContext;
  readonly scope: (keys: readonly string[]) => FilesystemScope;
  readonly sourceId: SourceId;
  /** Evidence already released by discovery (listing metadata), before any content is read. */
  readonly baseline: number;
}

async function env(base: string, allow: { list?: boolean; read?: boolean; ingest?: boolean } = {}): Promise<Env> {
  const root = join(await realpath(base), 'docs');
  const outside = join(await realpath(base), 'outside');
  await mkdir(join(root, 'sub'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, 'a.txt'), 'Invoice INV-1001 approved');
  await writeFile(join(root, 'b.md'), 'policy limit 500');
  await writeFile(join(root, 'sub', 'c.txt'), 'nested note');
  await writeFile(join(root, 'unchosen.txt'), 'not chosen');
  await writeFile(join(outside, 'secret.txt'), 'TOP SECRET');
  const opened = await EiStateStore.open({ dir: join(base, 'state') });
  if (!opened.ok) throw new Error('state open');
  const inventory = new EnvironmentInventory();
  const ledger = new EvidenceLedger();
  const started = await opened.value.start({ grant: await readGrant(), trust: { principal: TEST_PRINCIPAL }, inventory, ledger });
  if (!started.ok) throw new Error('state start');
  const registry = new ConnectorRegistry();
  registry.register(new LocalFilesystemConnector());
  const clock = new MockClock('2026-11-02T00:00:00.000Z');
  const recorder = new FlakyRecorder(clock);
  const a = { list: true, read: true, ingest: true, ...allow };
  const authz = new ScriptedAuthorization((r) =>
    r.operation === 'ingest_source'
      ? a.ingest
      : r.permission === 'filesystem.list'
        ? a.list
        : r.permission === 'filesystem.read'
          ? a.read
          : false,
  );
  const ctx: ConnectorContext = { clock, authorization: authz, principal: TEST_PRINCIPAL, audit: recorder, ledger, state: opened.value };
  const deps = { registry, inventory };
  const scope = (keys: readonly string[]): FilesystemScope => ({ kind: 'filesystem_root', root, includeKeys: keys });
  const run = await discoverSource(deps, { sourceType: 'local_filesystem', scope: scope([]) }, ctx);
  if (!run.ok || run.value.record.axes.authorization !== 'granted') throw new Error('source not established');
  return {
    baseline: ledger.counts().released,
    root,
    outside,
    deps,
    ledger,
    store: opened.value,
    recorder,
    authz,
    ctx,
    scope,
    sourceId: run.value.record.source.sourceId,
  };
}

const sync = (e: Env, keys: readonly string[], cursor?: string) =>
  syncSource(
    e.deps,
    { sourceId: e.sourceId, kind: 'document_content', scope: e.scope(keys), ...(cursor !== undefined ? { cursor } : {}) },
    e.ctx,
  );

test('sync returns evidence for exactly the chosen items, attributed to incremental_sync with read permission', async () => {
  await withSandbox(async ({ base }) => {
    const e = await env(base);
    const r = await sync(e, ['a.txt', 'sub/c.txt']);
    assert.ok(r.ok);
    assert.deepEqual(r.value.evidence.map((x) => x.resourceKey).sort(), ['a.txt', 'sub/c.txt']);
    assert.ok(
      r.value.evidence.every(
        (x) => x.provenance.access.operation === 'incremental_sync' && x.provenance.access.permission === 'filesystem.read',
      ),
    );
    assert.deepEqual(r.value.removed, []);
    assert.match(r.value.nextCursor ?? '', /^m1-[0-9a-f]{16}$/);
    const events = e.recorder.inner.events().filter((x) => x.operation === 'incremental_sync');
    assert.deepEqual(
      events.map((x) => x.phase),
      ['attempt', 'terminal'],
    );
    assert.equal(events[0]?.permission, 'filesystem.read');
    await e.store.close();
  });
});

test('a chosen item that is gone is reported as deleted, not as a failure; an unchanged tree makes no progress', async () => {
  await withSandbox(async ({ base }) => {
    const e = await env(base);
    const first = await sync(e, ['a.txt', 'b.md']);
    assert.ok(first.ok);
    const cursor = first.value.nextCursor as string;
    const again = await sync(e, ['a.txt', 'b.md'], cursor);
    assert.ok(again.ok);
    assert.equal(again.value.evidence.length, 0);
    assert.equal(again.value.nextCursor, cursor);
    await rm(join(e.root, 'b.md'));
    const gone = await sync(e, ['a.txt', 'b.md'], cursor);
    assert.ok(gone.ok);
    assert.deepEqual(gone.value.removed, [{ resourceKey: 'b.md', reason: 'deleted' }]);
    assert.deepEqual(
      gone.value.evidence.map((x) => x.resourceKey),
      ['a.txt'],
    );
    assert.notEqual(gone.value.nextCursor, cursor);
    await writeFile(join(e.root, 'a.txt'), 'changed');
    const changed = await sync(e, ['a.txt'], cursor);
    assert.ok(changed.ok && changed.value.evidence.length === 1 && changed.value.nextCursor !== cursor);
    await e.store.close();
  });
});

test('the chosen items are required, bounded and never widened', async () => {
  await withSandbox(async ({ base }) => {
    const e = await env(base);
    const none = await sync(e, []);
    assert.ok(!none.ok && none.error.code === DiscoveryErrorCode.INVALID_SCOPE);
    const many = await sync(
      e,
      Array.from({ length: 201 }, (_, i) => `f${i}.txt`),
    );
    assert.ok(!many.ok && many.error.code === DiscoveryErrorCode.LIMIT_EXCEEDED);
    const r = await sync(e, ['a.txt']);
    assert.ok(r.ok && !r.value.evidence.some((x) => x.resourceKey === 'unchosen.txt'));
    await e.store.close();
  });
});

test('boundary: escaping keys, symlinks and denied reads are refused and are never mistaken for deletions', async () => {
  await withSandbox(async ({ base }) => {
    const e = await env(base);
    for (const key of ['../outside/secret.txt', '/etc/passwd', 'a/../../x']) {
      const r = await sync(e, [key]);
      assert.ok(!r.ok, `key ${key} must be refused`);
    }
    await symlink(join(e.outside, 'secret.txt'), join(e.root, 'link.txt'));
    const link = await sync(e, ['a.txt', 'link.txt']);
    assert.ok(!link.ok, 'a symlink fails the whole sync; it is not a deletion');
    await e.store.close();
  });
});

test('without filesystem.read nothing is read and nothing is returned', async () => {
  await withSandbox(async ({ base }) => {
    const e = await env(base, { read: false });
    const r = await sync(e, ['a.txt']);
    assert.ok(!r.ok);
    assert.equal(e.ledger.counts().released - e.baseline, 0);
    await e.store.close();
  });
});

test('REAL INGEST: chosen files become eligible evidence; deleting one retires its evidence; unchosen files never enter', async () => {
  await withSandbox(async ({ base }) => {
    const e = await env(base);
    const scope = e.scope(['a.txt', 'b.md', 'sub/c.txt']);
    const req = { sourceId: e.sourceId, kind: 'document_content' as const, scope };
    const first = await ingestSource(e.deps, req, e.ctx);
    assert.ok(first.ok, first.ok ? '' : JSON.stringify(first.error.context) + first.error.message);
    assert.equal(first.value.items.length, 3);
    for (const i of first.value.items) assert.equal(e.ledger.isEligible(i.evidenceId), true);
    assert.equal(e.ledger.counts().released - e.baseline, 3);

    await rm(join(e.root, 'b.md'));
    const second = await ingestSource(e.deps, req, e.ctx);
    assert.ok(second.ok, second.ok ? '' : second.error.code);
    assert.equal(second.value.retired.length, 1);
    assert.equal(second.value.retired[0]?.reason, 'deleted');
    const retiredId = second.value.retired[0]?.evidenceId as never;
    assert.equal(e.ledger.isEligible(retiredId), false, 'deleted content is no longer eligible');
    assert.equal(e.ledger.counts().released - e.baseline, 2);

    await writeFile(join(e.root, 'a.txt'), 'Invoice INV-1001 now 900');
    const third = await ingestSource(e.deps, req, e.ctx);
    assert.ok(third.ok);
    assert.equal(
      third.value.retired.some((r) => r.reason === 'superseded'),
      true,
      'changed content supersedes the old evidence',
    );
    await rename(join(e.root, 'sub'), join(e.root, 'moved'));
    const fourth = await ingestSource(e.deps, req, e.ctx);
    assert.ok(fourth.ok && fourth.value.retired.some((r) => r.reason === 'deleted'));
    assert.equal(e.ledger.counts().released - e.baseline, 1);
    await e.store.close();
  });
});

test('REAL INGEST needs its own authorization: without it nothing is read or recorded as ingested', async () => {
  await withSandbox(async ({ base }) => {
    const e = await env(base, { ingest: false });
    const r = await ingestSource(e.deps, { sourceId: e.sourceId, kind: 'document_content', scope: e.scope(['a.txt']) }, e.ctx);
    assert.ok(!r.ok);
    assert.equal(e.ledger.counts().released - e.baseline, 0);
    await e.store.close();
  });
});

test('structuredRecords is opt-in and strict: only an exact record file carries its records; nothing else about content is retained', async () => {
  await withSandbox(async ({ base }) => {
    const e = await env(base);
    const rec = (n: number) => ({ type: 'statement', i: n });
    await writeFile(join(e.root, 'org.json'), JSON.stringify({ schema: 'ei.org-record.v1', records: [rec(1), rec(2)] }));
    await writeFile(join(e.root, 'other.json'), JSON.stringify({ hello: 'secret-text' }));
    await writeFile(join(e.root, 'wrongschema.json'), JSON.stringify({ schema: 'something.else', records: [rec(1)] }));
    await writeFile(
      join(e.root, 'toomany.json'),
      JSON.stringify({ schema: 'ei.org-record.v1', records: Array.from({ length: 201 }, (_, i) => rec(i)) }),
    );
    await writeFile(join(e.root, 'notrecords.json'), JSON.stringify({ schema: 'ei.org-record.v1', records: [1, 'x'] }));
    let deep: unknown = { v: 1 };
    for (let i = 0; i < 12; i += 1) deep = { nest: deep };
    await writeFile(join(e.root, 'deep.json'), JSON.stringify({ schema: 'ei.org-record.v1', records: [deep] }));
    await writeFile(join(e.root, 'org.txt'), JSON.stringify({ schema: 'ei.org-record.v1', records: [rec(1)] }));
    const keys = ['org.json', 'other.json', 'wrongschema.json', 'toomany.json', 'notrecords.json', 'deep.json', 'org.txt'];
    const payloadOf = (r: Awaited<ReturnType<typeof sync>>, key: string) =>
      r.ok ? (r.value.evidence.find((x) => x.resourceKey === key)?.payload as Record<string, unknown>) : undefined;

    const off = await sync(e, keys);
    assert.ok(off.ok);
    for (const k of keys) assert.equal(payloadOf(off, k)?.['records'], undefined, `${k} carries no records unless opted in`);

    const on = await syncSource(
      e.deps,
      { sourceId: e.sourceId, kind: 'document_content', scope: { ...e.scope(keys), structuredRecords: true } },
      e.ctx,
    );
    assert.ok(on.ok);
    assert.equal(payloadOf(on, 'org.json')?.['schema'], 'ei.org-record.v1');
    assert.equal((payloadOf(on, 'org.json')?.['records'] as unknown[]).length, 2);
    for (const k of keys.filter((k) => k !== 'org.json'))
      assert.equal(payloadOf(on, k)?.['records'], undefined, `${k} must not carry records`);
    assert.doesNotMatch(JSON.stringify(on.value.evidence), /secret-text/, 'content of non-record files is never retained');
    await e.store.close();
  });
});
