import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorCode } from '@xo/errors';
import { FileAuditStore, defaultFileOps, isDurableReceipt, resolveAuditConfig, type FileOps } from '../src/index.js';
import { controller, draft, principal, tmpDir } from './helpers.js';

const DAY = 86_400_000;
const retention = { defaultRetentionMs: 30 * DAY, minimumRetentionMs: 7 * DAY };

async function open(dir: string, extra: Partial<Parameters<typeof FileAuditStore.open>[0]> = {}): Promise<FileAuditStore> {
  return FileAuditStore.open({ dir, retention, ...extra });
}
async function lines(dir: string): Promise<string[]> {
  return (await readFile(join(dir, 'audit.jsonl'), 'utf8')).split('\n').filter((l) => l.length > 0);
}
async function readAll(store: FileAuditStore, as = 'auditor') {
  const g = await controller().authorize(principal('service', as), 'read');
  assert.ok(g.ok, 'read grant');
  const r = await store.read(g.value);
  assert.ok(r.ok);
  return r.value;
}

test('retention policy is REQUIRED to open a durable store (no silent indefinite retention)', async () => {
  const dir = await tmpDir();
  await assert.rejects(
    () => FileAuditStore.open({ dir } as never),
    (e: { code: string }) => e.code === ErrorCode.AUDIT_CONFIG_INVALID,
  );
  await assert.rejects(
    () => FileAuditStore.open({ dir, retention: { defaultRetentionMs: 1, minimumRetentionMs: 2 } }),
    (e: { code: string }) => e.code === ErrorCode.AUDIT_CONFIG_INVALID,
  );
  await assert.rejects(() => FileAuditStore.open({ dir, retention: { defaultRetentionMs: 5, minimumRetentionMs: 0 } }));
});

test('startup config: production without retention fails; partial config fails; dev without config is explicit non-production', () => {
  assert.equal(resolveAuditConfig({ NODE_ENV: 'production' }).ok, false);
  assert.equal(resolveAuditConfig({ XO_AUDIT_DIR: '/x' }).ok, false);
  assert.equal(resolveAuditConfig({ XO_AUDIT_DIR: '/x', XO_AUDIT_RETENTION_DAYS: '10', XO_AUDIT_MIN_RETENTION_DAYS: '30' }).ok, false);
  assert.equal(resolveAuditConfig({ XO_AUDIT_DIR: '/x', XO_AUDIT_RETENTION_DAYS: 'abc', XO_AUDIT_MIN_RETENTION_DAYS: '3' }).ok, false);
  const np = resolveAuditConfig({});
  assert.ok(np.ok && np.value.mode === 'non-production');
  const ok = resolveAuditConfig({
    NODE_ENV: 'production',
    XO_AUDIT_DIR: '/x',
    XO_AUDIT_RETENTION_DAYS: '30',
    XO_AUDIT_MIN_RETENTION_DAYS: '7',
  });
  assert.ok(ok.ok && ok.value.mode === 'durable' && ok.value.defaultRetentionMs === 30 * DAY);
});

test('append: fsync receipt, trusted time/retention, restrictive permissions, strictly increasing seq', async () => {
  const dir = await tmpDir();
  const store = await open(dir, { clock: () => new Date('2026-03-01T00:00:00Z') });
  const a = await store.append(draft());
  const b = await store.append(draft({ outcome: 'allowed', type: 'access.attempted' }));
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  assert.equal(isDurableReceipt(a.receipt), true);
  assert.equal(a.receipt.guarantee, 'fsync-file');
  assert.equal(a.receipt.eventId, a.event.eventId);
  assert.equal(a.event.recordedAt, '2026-03-01T00:00:00.000Z');
  assert.equal(a.event.retainUntil, new Date(Date.parse('2026-03-01T00:00:00Z') + 30 * DAY).toISOString());
  assert.equal(a.event.classification, 'restricted');
  assert.equal(b.event.seq, a.event.seq + 1);
  assert.equal((await stat(join(dir, 'audit.jsonl'))).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await lines(dir)).length, 2);
  // the returned event is immutable; mutating it cannot alter what is on disk
  assert.throws(() => {
    (a.event as { outcome: string }).outcome = 'denied';
  });
});

test('append writes nothing sensitive: the line contains only contract fields', async () => {
  const dir = await tmpDir();
  const store = await open(dir);
  await store.append(draft({ metadata: { capabilityKind: 'rule' } }));
  const ev = JSON.parse((await lines(dir))[0] as string) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(ev).sort(),
    [
      'action',
      'actor',
      'classification',
      'correlationId',
      'eventId',
      'metadata',
      'outcome',
      'recordedAt',
      'retainUntil',
      'schemaVersion',
      'seq',
      'target',
      'type',
    ].sort(),
  );
});

test('concurrent writers (one store, 60 parallel appends): unique, contiguous seq; no lost or interleaved lines', async () => {
  const dir = await tmpDir();
  const store = await open(dir);
  const results = await Promise.all(Array.from({ length: 60 }, (_, i) => store.append(draft({ correlationId: `c-${i}` }))));
  assert.ok(results.every((r) => r.ok));
  const ls = await lines(dir);
  assert.equal(ls.length, 60);
  const seqs = ls.map((l) => (JSON.parse(l) as { seq: number }).seq).sort((x, y) => x - y);
  assert.deepEqual(
    seqs,
    Array.from({ length: 60 }, (_, i) => i + 1),
  );
  assert.equal(new Set(ls.map((l) => (JSON.parse(l) as { eventId: string }).eventId)).size, 60);
});

test('concurrent writers (two store instances, same directory, advisory lock): still contiguous', async () => {
  const dir = await tmpDir();
  const s1 = await open(dir);
  const s2 = await open(dir);
  const results = await Promise.all(
    Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? s1 : s2).append(draft({ correlationId: `c-${i}` }))),
  );
  assert.ok(results.every((r) => r.ok));
  const seqs = (await lines(dir)).map((l) => (JSON.parse(l) as { seq: number }).seq).sort((x, y) => x - y);
  assert.deepEqual(
    seqs,
    Array.from({ length: 40 }, (_, i) => i + 1),
  );
});

test('storage failure at fsync: NO receipt, indeterminate, and idempotent retry never duplicates', async () => {
  const dir = await tmpDir();
  let failSync = true;
  const ops: FileOps = {
    ...defaultFileOps,
    openAppend: async (p) => {
      const h = await defaultFileOps.openAppend(p);
      return {
        write: (d) => h.write(d),
        sync: async () => {
          if (failSync) throw new Error('EIO simulated');
          await h.sync();
        },
        close: () => h.close(),
      };
    },
  };
  const store = await open(dir, { ops });
  const d = draft({ idempotencyKey: 'op-1-start' });
  const first = await store.append(d);
  assert.equal(first.ok, false);
  if (!first.ok) {
    assert.equal(first.indeterminate, true);
    assert.equal(first.error.code, ErrorCode.AUDIT_UNAVAILABLE);
    assert.ok(!first.error.message.includes('EIO'), 'infrastructure detail stays in cause');
  }
  failSync = false;
  const retry = await store.append(d);
  assert.ok(retry.ok);
  assert.equal((await lines(dir)).length, 1, 'bytes landed once; the retry de-duplicated');
  const again = await store.append(d);
  assert.ok(again.ok && retry.ok && again.event.eventId === retry.event.eventId);
});

test('retry confirmation: a dedupe hit still requires a successful fsync before a receipt is minted', async () => {
  const dir = await tmpDir();
  const store = await open(dir);
  assert.ok((await store.append(draft({ idempotencyKey: 'k1' }))).ok);
  let failSync = true;
  const flaky = await open(dir, {
    ops: {
      ...defaultFileOps,
      openAppend: async (p) => {
        const h = await defaultFileOps.openAppend(p);
        return {
          write: (x) => h.write(x),
          sync: async () => {
            if (failSync) throw new Error('x');
            await h.sync();
          },
          close: () => h.close(),
        };
      },
    },
  });
  const r = await flaky.append(draft({ idempotencyKey: 'k1' }));
  assert.equal(r.ok, false);
  failSync = false;
  assert.ok((await flaky.append(draft({ idempotencyKey: 'k1' }))).ok);
});

test('partial write (torn tail): failure reported, tail terminated on next append, corruption reported on read, valid events intact', async () => {
  const dir = await tmpDir();
  let tear = false;
  const ops: FileOps = {
    ...defaultFileOps,
    openAppend: async (p) => {
      const h = await defaultFileOps.openAppend(p);
      return {
        write: async (d) => {
          if (!tear) return h.write(d);
          await h.write(d.subarray(0, Math.floor(d.length / 2)));
          throw new Error('crash mid-write');
        },
        sync: () => h.sync(),
        close: () => h.close(),
      };
    },
  };
  const store = await open(dir, { ops });
  assert.ok((await store.append(draft({ correlationId: 'good-1' }))).ok);
  tear = true;
  const torn = await store.append(draft({ correlationId: 'torn' }));
  assert.equal(torn.ok, false);
  tear = false;
  const after = await store.append(draft({ correlationId: 'good-2' }));
  assert.ok(after.ok);
  if (after.ok) assert.equal(after.event.seq, 2, 'torn event never got a seq slot');
  const res = await readAll(store);
  assert.deepEqual(
    res.events.map((e) => e.correlationId),
    ['good-1', 'good-2'],
  );
  assert.equal(res.corruptLines, 1);
});

test('a torn tail present at OPEN (previous process crashed) is handled by a fresh store', async () => {
  const dir = await tmpDir();
  const s1 = await open(dir);
  assert.ok((await s1.append(draft())).ok);
  await appendFile(join(dir, 'audit.jsonl'), '{"schemaVersion":1,"eventId":"half');
  const s2 = await open(dir);
  const r = await s2.append(draft({ correlationId: 'after-crash' }));
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.event.seq, 2);
  assert.equal((await readAll(s2)).corruptLines, 1);
});

test('invalid drafts are refused before any write', async () => {
  const dir = await tmpDir();
  const store = await open(dir);
  const r = await store.append({ ...draft(), recordedAt: '1999-01-01T00:00:00Z' } as never);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.indeterminate, false);
  await assert.rejects(() => readFile(join(dir, 'audit.jsonl')));
});

test('lock contention timeout is a failed append, not a hang or a false receipt', async () => {
  const dir = await tmpDir();
  const store = await open(dir, { lockTimeoutMs: 80, staleLockMs: 60_000 });
  await writeFile(join(dir, 'audit.lock'), '{"pid":1,"token":"other","at":0}');
  const r = await store.append(draft());
  assert.equal(r.ok, false);
});

test('a stale lock left by a dead process is recovered', async () => {
  const dir = await tmpDir();
  const store = await open(dir, { staleLockMs: 1, lockTimeoutMs: 2000 });
  await writeFile(join(dir, 'audit.lock'), '{"pid":99999,"token":"dead","at":0}');
  await new Promise((r) => setTimeout(r, 15));
  assert.ok((await store.append(draft())).ok);
});

// ── access control ────────────────────────────────────────────────────

test('reading requires a valid, current, single-use grant: none / forged / reused / wrong-action are all denied', async () => {
  const dir = await tmpDir();
  const store = await open(dir);
  await store.append(draft());
  for (const bogus of [
    undefined,
    null,
    {},
    { kind: 'xo.audit.access-grant', action: 'read', principalId: 'auditor', principalKind: 'service', issuedAtMs: Date.now() },
  ]) {
    const r = await store.read(bogus as never);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, ErrorCode.AUDIT_ACCESS_DENIED);
  }
  const c = controller();
  const g = await c.authorize(principal('service', 'auditor'), 'read');
  assert.ok(g.ok);
  if (!g.ok) return;
  assert.equal((await store.read({ ...g.value })).ok, false, 'a copy of a real grant does not verify');
  assert.equal((await store.read(g.value)).ok, true);
  assert.equal((await store.read(g.value)).ok, false, 'single use');
  const readGrant = await c.authorize(principal('service', 'auditor'), 'read');
  assert.ok(readGrant.ok);
  if (readGrant.ok) assert.equal((await store.purge(readGrant.value)).ok, false, 'a read grant cannot purge');
});

test('authorization is default-deny, kind-restricted, revocation-aware and re-evaluated on every access', async () => {
  const svc = principal('service', 'auditor');
  assert.equal((await controller({ allow: false }).authorize(svc, 'read')).ok, false, 'no policy rule => deny');
  assert.equal((await controller().authorize(principal('service', 'someone-else'), 'read')).ok, false, 'not named by policy => deny');
  assert.equal(
    (await controller().authorize({ kind: 'service', id: 'auditor' }, 'read')).ok,
    false,
    'unverified principal literal => deny',
  );
  assert.equal((await controller().authorize(undefined, 'read')).ok, false);
  assert.equal(
    (await controller().authorize(principal('human', 'alice'), 'read')).ok,
    false,
    'human denied by default even when policy names them',
  );
  assert.equal(
    (await controller({ kinds: ['service', 'human'] }).authorize(principal('human', 'alice'), 'read')).ok,
    true,
    'operator can widen kinds; policy still decides',
  );
  assert.equal((await controller({ kinds: ['service', 'human'] }).authorize(principal('human', 'bob'), 'read')).ok, false);
  const revoked = new Set<string>();
  const c = controller({ revoked });
  assert.equal((await c.authorize(svc, 'read')).ok, true);
  revoked.add('auditor');
  assert.equal((await c.authorize(svc, 'read')).ok, false, 'revoked after a previous success => denied at the next access');
  const throwing = new (controller().constructor as new (o: object) => ReturnType<typeof controller>)({
    permissionManager: {
      check: async () => {
        throw new Error('policy down');
      },
    },
  });
  assert.equal((await throwing.authorize(svc, 'read')).ok, false, 'policy failure fails closed');
});

test('an expired grant is refused', async () => {
  const dir = await tmpDir();
  const store = await open(dir, { grantMaxAgeMs: 1 });
  const g = await controller().authorize(principal('service', 'auditor'), 'read');
  assert.ok(g.ok);
  await new Promise((r) => setTimeout(r, 15));
  if (g.ok) assert.equal((await store.read(g.value)).ok, false);
});

test('read filters by correlation id and returns events in seq order', async () => {
  const dir = await tmpDir();
  const store = await open(dir);
  for (const c of ['a', 'b', 'a']) await store.append(draft({ correlationId: c }));
  const g = await controller().authorize(principal('service', 'auditor'), 'read');
  assert.ok(g.ok);
  if (!g.ok) return;
  const r = await store.read(g.value, { correlationId: 'a' });
  assert.ok(r.ok);
  if (r.ok)
    assert.deepEqual(
      r.value.events.map((e) => e.seq),
      [1, 3],
    );
});

// ── retention / purge ─────────────────────────────────────────────────

async function purgeAs(store: FileAuditStore, id = 'auditor') {
  const g = await controller().authorize(principal('service', id), 'purge');
  assert.ok(g.ok, 'purge grant');
  return store.purge(g.value);
}

test('purge never removes a record before retainUntil', async () => {
  const dir = await tmpDir();
  let now = new Date('2026-01-01T00:00:00Z');
  const store = await open(dir, { clock: () => now });
  await store.append(draft());
  now = new Date(now.getTime() + 10 * DAY); // past minimum (7d) but before retainUntil (30d)
  const r = await purgeAs(store);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.purged, 0);
  assert.equal((await lines(dir)).length, 1);
});

test('purge removes expired records, keeps others byte-identical, and leaves a content-free marker', async () => {
  const dir = await tmpDir();
  let now = new Date('2026-01-01T00:00:00Z');
  const store = await open(dir, { clock: () => now });
  await store.append(draft({ correlationId: 'old-1' }));
  await store.append(draft({ correlationId: 'old-2' }));
  now = new Date('2026-02-15T00:00:00Z');
  await store.append(draft({ correlationId: 'fresh' }));
  const before = await lines(dir);
  now = new Date('2026-02-20T00:00:00Z'); // old (31d+) expired; fresh (5d) not
  const r = await purgeAs(store);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.purged, 2);
  const after = await lines(dir);
  assert.equal(after[0], before[2], 'surviving event is byte-identical (never rewritten)');
  const marker = JSON.parse(after[1] as string) as { type: string; seq: number; actor: { id: string }; metadata: Record<string, number> };
  assert.equal(marker.type, 'audit.purged');
  assert.equal(marker.seq, 4);
  assert.equal(marker.actor.id, 'auditor');
  assert.deepEqual(marker.metadata, { purgedCount: 2, firstSeq: 1, lastSeq: 2 });
  assert.ok(!after.join('').includes('old-1'), 'purged content is gone');
  // sequence keeps increasing after purge
  const next = await store.append(draft());
  assert.ok(next.ok);
  if (next.ok) assert.equal(next.event.seq, 5);
});

test('purge enforces the configured MINIMUM retention even if a record claims an earlier retainUntil (negative control for tampered metadata)', async () => {
  const dir = await tmpDir();
  let now = new Date('2026-01-01T00:00:00Z');
  const store = await open(dir, { clock: () => now });
  await store.append(draft());
  const file = join(dir, 'audit.jsonl');
  const ev = JSON.parse((await readFile(file, 'utf8')).trim()) as Record<string, unknown>;
  ev['retainUntil'] = '2000-01-01T00:00:00.000Z';
  await writeFile(file, `${JSON.stringify(ev)}\n`);
  now = new Date('2026-01-03T00:00:00Z'); // 2 days old < 7 day minimum
  const r = await purgeAs(store);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.purged, 0);
});

test('purge requires authorization: unauthorized principal gets no grant, so nothing is removed', async () => {
  const dir = await tmpDir();
  let now = new Date('2026-01-01T00:00:00Z');
  const store = await open(dir, { clock: () => now });
  await store.append(draft());
  now = new Date('2027-01-01T00:00:00Z');
  const g = await controller().authorize(principal('service', 'intruder'), 'purge');
  assert.equal(g.ok, false);
  assert.equal((await store.purge(undefined as never)).ok, false);
  assert.equal((await lines(dir)).length, 1);
});

test('a crash during purge leaves the original file intact (atomic rename)', async () => {
  const dir = await tmpDir();
  let now = new Date('2026-01-01T00:00:00Z');
  let failNew = false;
  const ops: FileOps = {
    ...defaultFileOps,
    openNew: async (p) => {
      if (failNew) throw new Error('disk full');
      return defaultFileOps.openNew(p);
    },
  };
  const store = await open(dir, { clock: () => now, ops });
  await store.append(draft());
  now = new Date('2027-01-01T00:00:00Z');
  failNew = true;
  const r = await purgeAs(store);
  assert.equal(r.ok, false);
  assert.equal((await lines(dir)).length, 1, 'original untouched');
});
