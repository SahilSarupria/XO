// UW-1 — workspace audit log: external anchoring (detects a wholesale rewrite or a cut tail) and retention purge as a recorded event.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { LocalFsBlobStore } from '@xo/storage';
import { Permissions, RuleBasedPolicy } from '@xo/permissions';
import { FsAuditLog } from '../src/audit/fs-audit-log.js';
import { FileAuditAnchorSink, auditAnchorSinkFromEnv, type AuditAnchor, type AuditAnchorSink } from '../src/audit/anchor.js';
import { computeEntryHash, GENESIS_HASH, type AuditEntry, type AuditEventInput } from '../src/audit/audit-entry.js';
import { TestServer, withTempDir } from './test-helpers.js';

const DAY = 86_400_000;
const ACTOR = { identityId: 'alice', kind: 'user' } as const;
const OPERATOR = { identityId: 'ops', kind: 'service' } as const;
const ev = (n: number): AuditEventInput => ({ event: 'settings.updated', actor: ACTOR, result: 'succeeded', detail: { n } });

interface Fixture {
  readonly dir: string;
  readonly store: LocalFsBlobStore;
  readonly anchors: FileAuditAnchorSink;
  clock: Date;
  log(anchor?: AuditAnchorSink | null): FsAuditLog;
}

async function withLog(fn: (f: Fixture) => Promise<void>): Promise<void> {
  await withTempDir('xo-audit-anchor-', async (dir) => {
    const f: Fixture = {
      dir,
      store: new LocalFsBlobStore(join(dir, 'ws', 'audit')),
      anchors: new FileAuditAnchorSink(join(dir, 'anchors')),
      clock: new Date('2026-01-01T00:00:00.000Z'),
      log(anchor) {
        return new FsAuditLog(this.store, 'ws_test', () => this.clock, anchor === null ? undefined : (anchor ?? this.anchors));
      },
    };
    await fn(f);
  });
}

const entryPath = (f: Fixture, seq: number) => join(f.dir, 'ws', 'audit', 'entries', `${String(seq).padStart(12, '0')}.json`);
const headPath = (f: Fixture) => join(f.dir, 'ws', 'audit', 'head.json');

/** Rewrite the chain from `fromSeq` consistently (every hash and link recomputed), as someone with storage access could. */
async function rewriteFrom(f: Fixture, fromSeq: number, upTo: number, edit: (e: AuditEntry) => AuditEntry): Promise<void> {
  let prev = fromSeq === 1 ? GENESIS_HASH : (JSON.parse(await readFile(entryPath(f, fromSeq - 1), 'utf8')) as AuditEntry).hash;
  for (let seq = fromSeq; seq <= upTo; seq++) {
    const old = JSON.parse(await readFile(entryPath(f, seq), 'utf8')) as AuditEntry;
    const { hash: _drop, ...rest } = seq === fromSeq ? edit(old) : old;
    const unsigned = { ...rest, prevHash: prev };
    const hash = computeEntryHash(unsigned);
    await writeFile(entryPath(f, seq), JSON.stringify({ ...unsigned, hash }));
    prev = hash;
  }
  await writeFile(headPath(f), JSON.stringify({ seq: upTo, hash: prev }));
}

test('every append is anchored with its seq, hash and entry time; verify compares the chain with the anchors', async () => {
  await withLog(async (f) => {
    const log = f.log();
    for (let i = 1; i <= 3; i++) await log.append(ev(i));
    const anchors = await f.anchors.list('workspace:ws_test');
    assert.deepEqual(
      anchors.map((a) => a.seq),
      [1, 2, 3],
    );
    assert.equal(anchors[2]?.hash, (await log.head()).hash);
    assert.equal(anchors[0]?.entryAt, f.clock.toISOString());
    const v = await log.verify();
    assert.equal(v.ok, true);
    assert.deepEqual(v.anchoring, { checked: 3, highestAnchoredSeq: 3 });
  });
});

test('a consistently rewritten chain passes the chain check alone but fails against the anchors', async () => {
  await withLog(async (f) => {
    const log = f.log();
    for (let i = 1; i <= 4; i++) await log.append(ev(i));
    await rewriteFrom(f, 2, 4, (e) => ({ ...e, result: 'denied' }));
    assert.equal((await f.log(null).verify()).ok, true, 'without anchors the rewrite is invisible (the documented limit)');
    const v = await log.verify();
    assert.equal(v.ok, false);
    assert.deepEqual(v.brokenAt, { seq: 2, reason: 'anchor_mismatch' });
  });
});

test('a removed tail (head moved back consistently) is detected as truncation', async () => {
  await withLog(async (f) => {
    const log = f.log();
    for (let i = 1; i <= 3; i++) await log.append(ev(i));
    const second = JSON.parse(await readFile(entryPath(f, 2), 'utf8')) as AuditEntry;
    await f.store.delete('entries/000000000003.json');
    await writeFile(headPath(f), JSON.stringify({ seq: 2, hash: second.hash }));
    assert.equal((await f.log(null).verify()).ok, true);
    assert.deepEqual((await log.verify()).brokenAt, { seq: 3, reason: 'anchor_truncated' });
  });
});

test('a failed anchor write does not fail the append; the next anchor covers the entry', async () => {
  await withLog(async (f) => {
    let fail = true;
    const flaky: AuditAnchorSink = {
      publish: (a: AuditAnchor) => (fail ? Promise.reject(new Error('anchor store down')) : f.anchors.publish(a)),
      list: (scope) => f.anchors.list(scope),
    };
    const log = f.log(flaky);
    const first = await log.append(ev(1));
    assert.equal(first.seq, 1);
    fail = false;
    await log.append(ev(2));
    assert.deepEqual(
      (await f.anchors.list('workspace:ws_test')).map((a) => a.seq),
      [2],
    );
    assert.equal((await log.verify()).ok, true);
  });
});

test('unreadable anchors fail verification rather than passing silently', async () => {
  await withLog(async (f) => {
    const log = f.log();
    await log.append(ev(1));
    await writeFile(join(f.dir, 'anchors', 'workspace__ws_test.anchors.jsonl'), '{not json\n');
    assert.equal((await log.verify()).brokenAt?.reason, 'anchor_unreadable');
  });
});

test('purge removes only entries older than the retention, records exactly what it removed, and the log still verifies', async () => {
  await withLog(async (f) => {
    const log = f.log();
    for (let i = 1; i <= 3; i++) await log.append(ev(i)); // 2026-01-01
    f.clock = new Date('2026-03-01T00:00:00.000Z');
    await log.append(ev(4)); // recent
    f.clock = new Date('2026-03-10T00:00:00.000Z');

    const dry = await log.purge({ retentionDays: 30, actor: OPERATOR, dryRun: true });
    assert.equal(dry.removed, 3);
    assert.equal(dry.event, undefined);
    assert.equal((await log.all()).length, 4, 'a dry run changes nothing');

    const result = await log.purge({ retentionDays: 30, actor: OPERATOR });
    assert.equal(result.removed, 3);
    assert.equal(result.purgedThroughSeq, 3);
    const record = result.event!;
    assert.equal(record.event, 'audit.purged');
    assert.equal(record.seq, 5);
    assert.deepEqual(
      { ...record.detail },
      {
        fromSeq: 1,
        throughSeq: 3,
        throughHash: record.detail?.['throughHash'],
        throughAt: '2026-01-01T00:00:00.000Z',
        removed: 3,
        cutoff: new Date(f.clock.getTime() - 30 * DAY).toISOString(),
        retentionDays: 30,
      },
    );
    assert.deepEqual(
      (await log.all()).map((e) => e.seq),
      [4, 5],
    );
    assert.deepEqual(
      (await log.list()).entries.map((e) => e.seq),
      [5, 4],
    );
    assert.equal(await f.store.has('entries/000000000001.json'), false);
    const v = await log.verify();
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(v.purgedThroughSeq, 3);
    assert.deepEqual(v.anchoring, { checked: 5, highestAnchoredSeq: 5 });

    // appends continue on the same chain, and a second purge with nothing old enough is a no-op (no record written)
    await log.append(ev(6));
    const none = await log.purge({ retentionDays: 30, actor: OPERATOR });
    assert.equal(none.removed, 0);
    assert.equal((await log.head()).seq, 6);
    assert.equal((await log.verify()).ok, true);
  });
});

test('purge refuses a log that does not verify, and refuses a retention that is not a positive whole number of days', async () => {
  await withLog(async (f) => {
    const log = f.log();
    for (let i = 1; i <= 2; i++) await log.append(ev(i));
    await assert.rejects(log.purge({ retentionDays: 0, actor: OPERATOR }), /whole days/);
    await assert.rejects(log.purge({ retentionDays: 1.5, actor: OPERATOR }), /whole days/);
    const e1 = JSON.parse(await readFile(entryPath(f, 1), 'utf8')) as AuditEntry;
    await writeFile(entryPath(f, 1), JSON.stringify({ ...e1, result: 'denied' }));
    f.clock = new Date('2027-01-01T00:00:00.000Z');
    await assert.rejects(log.purge({ retentionDays: 1, actor: OPERATOR }), /does not verify/);
    assert.equal(await f.store.has('entries/000000000001.json'), true, 'evidence of tampering is never purged');
  });
});

test('a purge interrupted after the pointer moved still verifies, and the next purge finishes the deletion', async () => {
  await withLog(async (f) => {
    const log = f.log();
    for (let i = 1; i <= 3; i++) await log.append(ev(i));
    f.clock = new Date('2026-06-01T00:00:00.000Z');
    await log.purge({ retentionDays: 30, actor: OPERATOR });
    // simulate the crash: put the purged entry files back as if deletion never ran
    for (let seq = 1; seq <= 3; seq++) await writeFile(entryPath(f, seq), JSON.stringify({ seq, leftover: true }));
    assert.equal((await log.verify()).ok, true, 'leftovers at or below the pointer are ignored');
    await log.purge({ retentionDays: 30, actor: OPERATOR });
    assert.equal(await f.store.has('entries/000000000002.json'), false);
  });
});

test('a forged purge (recent entries deleted, pointer and record written by someone with storage access) is caught by the anchors', async () => {
  await withLog(async (f) => {
    const log = f.log();
    for (let i = 1; i <= 3; i++) await log.append(ev(i)); // all at 2026-01-01: none is old enough to purge with 30 days
    const lastRemoved = JSON.parse(await readFile(entryPath(f, 2), 'utf8')) as AuditEntry;
    // the forger appends a self-consistent purge record WITHOUT anchoring it, claims entries 1..2 were old, and deletes them
    const forge = async (cutoff: string, throughAt: string) => {
      f.clock = new Date('2026-02-01T00:00:00.000Z');
      const forged = await f.log(null).append({
        event: 'audit.purged',
        actor: OPERATOR,
        result: 'succeeded',
        detail: { throughSeq: 2, throughHash: lastRemoved.hash, throughAt, cutoff, retentionDays: 30 },
      });
      await writeFile(
        join(f.dir, 'ws', 'audit', 'base.json'),
        JSON.stringify({ seq: 2, hash: lastRemoved.hash, purgeEventSeq: forged.seq }),
      );
      await f.store.delete('entries/000000000001.json');
      await f.store.delete('entries/000000000002.json');
    };
    // the stated cutoff predates the removed entries, which the anchors' entry times show
    await forge('2025-12-01T00:00:00.000Z', '2025-11-01T00:00:00.000Z');
    assert.equal((await f.log(null).verify()).ok, true, 'the chain alone cannot tell');
    const v = await log.verify();
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt?.reason, 'anchor_purge_too_recent');
  });
});

test('a purge record that no anchor covers is reported as unattested, even when the removed entries were old enough', async () => {
  await withLog(async (f) => {
    const log = f.log();
    for (let i = 1; i <= 3; i++) await log.append(ev(i));
    const second = JSON.parse(await readFile(entryPath(f, 2), 'utf8')) as AuditEntry;
    f.clock = new Date('2026-02-01T00:00:00.000Z');
    const forged = await f.log(null).append({
      event: 'audit.purged',
      actor: OPERATOR,
      result: 'succeeded',
      detail: {
        throughSeq: 2,
        throughHash: second.hash,
        throughAt: '2025-12-31T00:00:00.000Z',
        cutoff: '2026-01-02T00:00:00.000Z',
        retentionDays: 30,
      },
    });
    await writeFile(join(f.dir, 'ws', 'audit', 'base.json'), JSON.stringify({ seq: 2, hash: second.hash, purgeEventSeq: forged.seq }));
    assert.equal((await log.verify()).brokenAt?.reason, 'anchor_unattested_purge');
  });
});

test('a purge pointer that disagrees with its record is reported as bad_purge', async () => {
  await withLog(async (f) => {
    const log = f.log(null);
    for (let i = 1; i <= 3; i++) await log.append(ev(i));
    f.clock = new Date('2026-06-01T00:00:00.000Z');
    await log.purge({ retentionDays: 30, actor: OPERATOR });
    const later = await log.append(ev(5));
    const base = JSON.parse(await readFile(join(f.dir, 'ws', 'audit', 'base.json'), 'utf8')) as { purgeEventSeq: number };
    // the pointer still links correctly, but names an ordinary entry as its purge record
    await writeFile(join(f.dir, 'ws', 'audit', 'base.json'), JSON.stringify({ ...base, purgeEventSeq: later.seq }));
    assert.deepEqual((await log.verify()).brokenAt, { seq: later.seq, reason: 'bad_purge' });
  });
});

test('XO_AUDIT_ANCHOR_DIR must be absolute; unset means no anchoring', () => {
  assert.equal(auditAnchorSinkFromEnv({}), undefined);
  assert.ok(auditAnchorSinkFromEnv({ XO_AUDIT_ANCHOR_DIR: '/var/lib/xo-anchors' }) instanceof FileAuditAnchorSink);
  assert.throws(() => auditAnchorSinkFromEnv({ XO_AUDIT_ANCHOR_DIR: 'relative/dir' }), /absolute/);
});

test('POST /audit/workspaces/:id/purge: needs the audit.purge grant (denial audited), a declared retention, and a real workspace', async () => {
  await withTempDir('xo-audit-purge-route-', async (dir) => {
    const policy = new RuleBasedPolicy([
      { id: 'purge', effect: 'ALLOW', match: { permission: Permissions.audit.purge, principalId: 'purger' } },
    ]);
    const server = await TestServer.start({
      workspaceDataDir: dir,
      permissionPolicy: policy,
      auditAnchor: new FileAuditAnchorSink(join(dir, 'anchors')),
    });
    const saved = process.env['XO_API_AUDIT_RETENTION_DAYS'];
    try {
      const w = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const purger = await server.issueAdditionalIdentity('purger');
      const path = `/audit/workspaces/${w}/purge`;

      const owner = await server.request('POST', path, {});
      assert.equal(owner.status, 403, 'workspace ownership is not the purge permission');

      delete process.env['XO_API_AUDIT_RETENTION_DAYS'];
      const noRetention = await server.request('POST', path, {}, TestServer.authHeader(purger.apiKey));
      assert.equal(noRetention.status, 412, noRetention.bodyText);

      process.env['XO_API_AUDIT_RETENTION_DAYS'] = '30';
      const ok = await server.request('POST', path, { dryRun: true }, TestServer.authHeader(purger.apiKey));
      assert.equal(ok.status, 200, ok.bodyText);
      assert.deepEqual(ok.json<{ removed: number; dryRun: boolean; retentionDays: number }>(), {
        ...ok.json<object>(),
        removed: 0,
        dryRun: true,
        retentionDays: 30,
      });
      const bad = await server.request('POST', path, { dryRun: 'yes' }, TestServer.authHeader(purger.apiKey));
      assert.equal(bad.status, 400);
      const missing = await server.request('POST', '/audit/workspaces/ws_doesnotexist/purge', {}, TestServer.authHeader(purger.apiKey));
      assert.equal(missing.status, 404);

      const verified = await server.request('GET', `/workspaces/${w}/audit/verify`);
      assert.equal(verified.status, 200);
      const body = verified.json<{ ok: boolean; anchoring?: { checked: number }; retention: { deletionSupported: boolean } }>();
      assert.equal(body.ok, true);
      assert.ok((body.anchoring?.checked ?? 0) >= 1, 'the server anchors workspace audit entries when configured');
      assert.equal(body.retention.deletionSupported, true, 'a declared retention means an operator may purge');
    } finally {
      if (saved === undefined) delete process.env['XO_API_AUDIT_RETENTION_DAYS'];
      else process.env['XO_API_AUDIT_RETENTION_DAYS'] = saved;
      await server.stop();
    }
  });
});
