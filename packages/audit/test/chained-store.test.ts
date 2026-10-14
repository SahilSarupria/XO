import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorCode } from '@xo/errors';
import {
  CHAIN_LOCK_FILE,
  CHAIN_LOG_FILE,
  ChainedAuditStore,
  defaultFileOps,
  isDurableReceipt,
  readClosedChainedLog,
  verifyClosedChainedLog,
  type ChainedAuditStoreOptions,
  type FileOps,
} from '../src/index.js';
import { controller, draft, principal, tmpDir } from './helpers.js';

const KEY = Buffer.alloc(32, 7);
async function open(dir: string, extra: Partial<ChainedAuditStoreOptions> = {}): Promise<ChainedAuditStore> {
  const r = await ChainedAuditStore.open({ dir, ...extra });
  assert.ok(r.ok, r.ok ? '' : r.error.message);
  return r.value;
}
async function grant(as = 'auditor') {
  const g = await controller().authorize(principal('service', as), 'read');
  assert.ok(g.ok, 'grant');
  return g.value;
}
const lines = async (dir: string) => (await readFile(join(dir, CHAIN_LOG_FILE), 'utf8')).split('\n').filter(Boolean);
const rewrite = (dir: string, ls: string[]) => writeFile(join(dir, CHAIN_LOG_FILE), `${ls.join('\n')}\n`);
const attempt = (op: string, extra = {}) =>
  draft({ idempotencyKey: `${op}:attempt`, lifecycle: { operationId: op, phase: 'attempt' }, ...extra });
const terminal = (op: string, extra = {}) =>
  draft({ idempotencyKey: `${op}:terminal`, outcome: 'completed', lifecycle: { operationId: op, phase: 'terminal' }, ...extra });

async function filled(dir: string, extra: Partial<ChainedAuditStoreOptions> = {}, n = 4): Promise<void> {
  const s = await open(dir, extra);
  for (let i = 0; i < n; i++) assert.ok((await s.append(draft({ idempotencyKey: `k${i}`, correlationId: `c${i}` }))).ok);
  await s.close();
}

test('writes: durable branded receipt, gap-free seq, authorized verified read, one history', async () => {
  const dir = await tmpDir();
  const s = await open(dir);
  const a = await s.append(draft({ idempotencyKey: 'a' }));
  const b = await s.append(draft({ idempotencyKey: 'b' }));
  assert.ok(a.ok && b.ok && isDurableReceipt(a.receipt) && a.receipt.guarantee === 'fsync-file');
  assert.ok(a.ok && b.ok && a.event.seq === 1 && b.event.seq === 2);
  const r = await s.read(await grant());
  assert.ok(r.ok && r.value.events.map((e) => e.seq).join() === '1,2');
  const v = await s.verify(await grant());
  assert.ok(v.ok && v.value.records === 3 && v.value.events === 2, 'header + 2 events');
  await s.close();
});

test('reads and verify require a valid, single-use grant; denied principals get nothing', async () => {
  const dir = await tmpDir();
  const s = await open(dir);
  assert.ok((await s.append(draft())).ok);
  assert.equal((await s.read({ kind: 'xo.audit.access-grant', action: 'read' })).ok, false, 'forged grant refused');
  const g = await grant();
  assert.ok((await s.read(g)).ok);
  const reuse = await s.read(g);
  assert.ok(!reuse.ok && reuse.error.code === ErrorCode.AUDIT_ACCESS_DENIED, 'grant is single use');
  const denied = await controller({ allow: false }).authorize(principal('service', 'auditor'), 'read');
  assert.equal(denied.ok, false);
  const wrongAction = await controller().authorize(principal('service', 'auditor'), 'purge');
  assert.ok(wrongAction.ok);
  assert.equal((await s.verify(wrongAction.value)).ok, false, 'a purge grant cannot read');
  await s.close();
});

test('duplicates are idempotent across restart; conflicts are refused and persist nothing', async () => {
  const dir = await tmpDir();
  const s1 = await open(dir);
  const first = await s1.append(draft({ idempotencyKey: 'k' }));
  assert.ok(first.ok);
  await s1.close();
  const s2 = await open(dir);
  const dup = await s2.append(draft({ idempotencyKey: 'k' }));
  assert.ok(dup.ok && dup.duplicate && first.ok && dup.event.eventId === first.event.eventId && isDurableReceipt(dup.receipt));
  const bad = await s2.append(draft({ idempotencyKey: 'k', reasonCode: 'OTHER' }));
  assert.ok(!bad.ok && bad.error.code === ErrorCode.AUDIT_CONFLICT);
  assert.equal((await lines(dir)).length, 2, 'header + one event only');
  await s2.close();
});

test('lifecycle: terminal needs an attempt, one terminal per operation, no attempt after terminal; open attempts survive restart', async () => {
  const dir = await tmpDir();
  const s = await open(dir);
  const early = await s.append(terminal('op-1'));
  assert.ok(!early.ok && early.error.code === ErrorCode.AUDIT_ORDER_VIOLATION);
  assert.ok((await s.append(attempt('op-1'))).ok);
  assert.ok((await s.append(attempt('op-2'))).ok);
  assert.deepEqual(s.openAttempts(), ['op-1', 'op-2']);
  assert.ok((await s.append(terminal('op-1'))).ok);
  const second = await s.append(terminal('op-1', { idempotencyKey: 'op-1:terminal-2', outcome: 'failed', type: 'access.denied' }));
  assert.ok(!second.ok && second.error.code === ErrorCode.AUDIT_CONFLICT, 'a second terminal is a conflict');
  const late = await s.append(attempt('op-1', { idempotencyKey: 'op-1:attempt-2' }));
  assert.ok(!late.ok && late.error.code === ErrorCode.AUDIT_ORDER_VIOLATION);
  await s.close();
  const again = await open(dir);
  assert.deepEqual(again.openAttempts(), ['op-2'], 'rebuilt from the verified log');
  await again.close();
});

test('tamper detection on open: modification, deletion, reordering, insertion, truncation of the middle', async () => {
  for (const mutate of [
    (ls: string[]) => ls.map((l, i) => (i === 2 ? l.replace('"outcome":"attempted"', '"outcome":"completed"') : l)),
    (ls: string[]) => ls.filter((_, i) => i !== 2),
    (ls: string[]) => [ls[0]!, ls[2]!, ls[1]!, ...ls.slice(3)],
    (ls: string[]) => [...ls.slice(0, 2), ls[1]!, ...ls.slice(2)],
  ]) {
    const dir = await tmpDir();
    await filled(dir);
    await rewrite(dir, mutate(await lines(dir)));
    const r = await ChainedAuditStore.open({ dir });
    assert.ok(!r.ok && r.error.code === ErrorCode.AUDIT_CORRUPT, 'opening a tampered log fails closed');
    assert.equal((await verifyClosedChainedLog(dir)).ok, false);
  }
});

test('a live store fails closed when the file is changed behind it: append AND read refuse, nothing unverified is returned', async () => {
  const dir = await tmpDir();
  const s = await open(dir);
  assert.ok((await s.append(draft({ idempotencyKey: 'a' }))).ok);
  assert.ok((await s.append(draft({ idempotencyKey: 'b' }))).ok);
  const ls = await lines(dir);
  await rewrite(
    dir,
    ls.map((l, i) => (i === 1 ? l.replace('read.execution', 'read.EXECUTION') : l)),
  );
  const r = await s.read(await grant());
  assert.ok(!r.ok && r.error.code === ErrorCode.AUDIT_CORRUPT);
  const w = await s.append(draft({ idempotencyKey: 'c' }));
  assert.ok(!w.ok && w.error.code === ErrorCode.AUDIT_CORRUPT && !w.indeterminate, 'appends refused after an integrity failure');
  await s.close();
});

test('appending to a file that was truncated/extended outside the writer is refused (size guard)', async () => {
  const dir = await tmpDir();
  const s = await open(dir);
  assert.ok((await s.append(draft({ idempotencyKey: 'a' }))).ok);
  await appendFile(join(dir, CHAIN_LOG_FILE), 'garbage');
  const w = await s.append(draft({ idempotencyKey: 'b' }));
  assert.ok(!w.ok && w.error.code === ErrorCode.AUDIT_CORRUPT);
  await s.close();
});

test('integrity keys: HMAC chains verify only with the key; mode/key mismatch is a config error; short keys refused', async () => {
  const dir = await tmpDir();
  await filled(dir, { integrityKey: KEY });
  assert.ok((await verifyClosedChainedLog(dir, { integrityKey: KEY })).ok);
  const wrong = await ChainedAuditStore.open({ dir, integrityKey: Buffer.alloc(32, 9) });
  assert.ok(!wrong.ok && wrong.error.code === ErrorCode.AUDIT_CORRUPT, 'wrong key: hashes do not verify');
  const none = await ChainedAuditStore.open({ dir });
  assert.ok(!none.ok && none.error.code === ErrorCode.AUDIT_CONFIG_INVALID, 'keyed log opened without a key');
  const short = await ChainedAuditStore.open({ dir: await tmpDir(), integrityKey: Buffer.alloc(8) });
  assert.ok(!short.ok && short.error.code === ErrorCode.AUDIT_CONFIG_INVALID);
});

test('an UNKEYED chain is rewritable end to end — documented limitation, not tamper-proofing', async () => {
  // An attacker who can rewrite the whole file can drop the LAST record and the remaining prefix still verifies.
  const dir = await tmpDir();
  await filled(dir);
  const ls = await lines(dir);
  await rewrite(dir, ls.slice(0, -1));
  const v = await verifyClosedChainedLog(dir);
  assert.ok(v.ok, 'tail deletion is NOT detectable from the file alone');
});

test('an external checkpoint DOES detect tail truncation and a rewritten prefix (the only supported defence)', async () => {
  const dir = await tmpDir();
  const s = await open(dir);
  for (let i = 0; i < 3; i++) assert.ok((await s.append(draft({ idempotencyKey: `k${i}` }))).ok);
  const cp = s.checkpoint();
  await s.close();
  assert.ok((await verifyClosedChainedLog(dir, { expectedHead: cp })).ok);
  const ls = await lines(dir);
  await rewrite(dir, ls.slice(0, -1));
  const cut = await verifyClosedChainedLog(dir, { expectedHead: cp });
  assert.ok(!cut.ok && cut.error.code === ErrorCode.AUDIT_CORRUPT);
  const grown = await open(dir);
  assert.ok((await grown.append(draft({ idempotencyKey: 'later' }))).ok);
  await grown.close();
  assert.ok(
    !(await verifyClosedChainedLog(dir, { expectedHead: cp })).ok,
    'history rewritten before the checkpoint position no longer contains it',
  );
});

function failingOps(state: { failWrite?: boolean; failSync?: boolean; partial?: boolean }): FileOps {
  const wrap = (h: Awaited<ReturnType<FileOps['openAppend']>>) => ({
    write: async (d: Buffer) => {
      if (state.partial) {
        await h.write(d.subarray(0, Math.floor(d.length / 2)));
        throw new Error('EIO partial');
      }
      if (state.failWrite) throw new Error('EIO write');
      await h.write(d);
    },
    sync: async () => {
      if (state.failSync) throw new Error('EIO sync');
      await h.sync();
    },
    close: () => h.close(),
  });
  return {
    ...defaultFileOps,
    // A fresh log is created through openNew and keeps that handle for appends, so both paths must inject faults.
    openAppend: async (p) => wrap(await defaultFileOps.openAppend(p)),
    openNew: async (p) => wrap(await defaultFileOps.openNew(p)),
  };
}

test('indeterminate append (fsync fails after the bytes landed): no receipt, instance poisoned, restart reconciles the retry to the ORIGINAL event', async () => {
  const dir = await tmpDir();
  const state = { failSync: false };
  const s = await open(dir, { ops: failingOps(state) });
  assert.ok((await s.append(draft({ idempotencyKey: 'ok' }))).ok);
  state.failSync = true;
  const lost = await s.append(draft({ idempotencyKey: 'maybe' }));
  assert.ok(!lost.ok && lost.indeterminate && lost.error.code === ErrorCode.AUDIT_UNAVAILABLE);
  assert.ok(!lost.error.message.includes('EIO'), 'infrastructure detail stays out of the message');
  state.failSync = false;
  const blocked = await s.append(draft({ idempotencyKey: 'next' }));
  assert.ok(!blocked.ok && !blocked.indeterminate, 'poisoned: no append can follow an unconfirmed one in this instance');
  await s.close();
  const again = await open(dir);
  const retry = await again.append(draft({ idempotencyKey: 'maybe' }));
  assert.ok(retry.ok && retry.duplicate, 'the line landed; the retry returns it instead of writing a second copy');
  assert.equal((await lines(dir)).length, 3, 'header + ok + maybe');
  await again.close();
});

test('write failure with NO bytes landed: retry after restart writes it exactly once', async () => {
  const dir = await tmpDir();
  const state = { failWrite: false };
  const s = await open(dir, { ops: failingOps(state) });
  state.failWrite = true;
  const lost = await s.append(draft({ idempotencyKey: 'x' }));
  assert.ok(!lost.ok && lost.indeterminate);
  await s.close();
  const again = await open(dir);
  const retry = await again.append(draft({ idempotencyKey: 'x' }));
  assert.ok(retry.ok && !retry.duplicate);
  assert.equal((await lines(dir)).length, 2);
  await again.close();
});

test('partial write (torn tail): the unacknowledged bytes are cut, RECORDED as a recovery in the chain, and history verifies', async () => {
  const dir = await tmpDir();
  const state = { partial: false };
  const s = await open(dir, { ops: failingOps(state) });
  assert.ok((await s.append(draft({ idempotencyKey: 'a' }))).ok);
  state.partial = true;
  const torn = await s.append(draft({ idempotencyKey: 'b' }));
  assert.ok(!torn.ok && torn.indeterminate);
  await s.close();
  const again = await open(dir);
  assert.equal(again.recoveryCount, 1);
  const ok2 = await again.append(draft({ idempotencyKey: 'b' }));
  assert.ok(ok2.ok && !ok2.duplicate, 'the torn write was never acknowledged, so it is written once now');
  const rep = await again.verify(await grant());
  assert.ok(rep.ok && rep.value.recoveries === 1 && rep.value.events === 2);
  await again.close();
});

test('single writer: a live lock fails closed (AUDIT_LOCKED); a stale lock from a dead process on this host is recovered', async () => {
  const dir = await tmpDir();
  const s = await open(dir);
  const second = await ChainedAuditStore.open({ dir });
  assert.ok(!second.ok && second.error.code === ErrorCode.AUDIT_LOCKED);
  const closedRead = await readClosedChainedLog(dir);
  assert.ok(!closedRead.ok && closedRead.error.code === ErrorCode.AUDIT_LOCKED, 'operator-local read refuses a live store');
  assert.ok(!(await verifyClosedChainedLog(dir)).ok, 'operator-local verify refuses a live store');
  await s.close();
  await writeFile(join(dir, CHAIN_LOCK_FILE), JSON.stringify({ pid: 2 ** 22 + 12345, host: (await import('node:os')).hostname() }));
  const recovered = await ChainedAuditStore.open({ dir });
  assert.ok(recovered.ok);
  if (recovered.ok) await recovered.value.close();
});

test('there is no purge/delete surface on the chained store', async () => {
  const s = await open(await tmpDir());
  for (const name of ['purge', 'delete', 'compact', 'truncate', 'remove'])
    assert.equal((s as unknown as Record<string, unknown>)[name], undefined);
  await s.close();
});

test('content-free: secrets and sensitive keys are rejected at the boundary and are absent from the persisted bytes', async () => {
  const dir = await tmpDir();
  const s = await open(dir);
  const secret = 'Bearer abcdefghijklmnop0123456789';
  const r1 = await s.append(draft({ metadata: { note: secret } }));
  const r2 = await s.append(draft({ metadata: { documentText: 'hello' } }));
  const r3 = await s.append({ ...draft(), sourceContents: 'file bytes' } as never);
  assert.ok(!r1.ok && !r2.ok && !r3.ok);
  assert.ok((await s.append(draft({ idempotencyKey: 'fine' }))).ok);
  const raw = await readFile(join(dir, CHAIN_LOG_FILE), 'utf8');
  for (const needle of [secret, 'hello', 'file bytes', 'sourceContents']) assert.ok(!raw.includes(needle));
  await s.close();
});

test('registered extensions persist, verify and are re-validated on reopen; unknown namespaces are refused', async () => {
  const dir = await tmpDir();
  const extensionSchemas = {
    'x-acme-demo': {
      namespace: 'x-acme-demo',
      fields: { n: { kind: 'count' as const }, d: { kind: 'opaque' as const, pattern: /^sha256:[0-9a-f]{64}$/, maxLength: 71 } },
    },
  };
  const s = await open(dir, { extensionSchemas });
  const d = `sha256:${'b'.repeat(64)}`;
  assert.ok((await s.append(draft({ idempotencyKey: 'e', extensions: { 'x-acme-demo': { n: 2, d } } }))).ok);
  assert.ok(!(await s.append(draft({ extensions: { 'x-nope-x': { n: 1 } } }))).ok);
  await s.close();
  const ok1 = await open(dir, { extensionSchemas });
  const r = await ok1.read(await grant());
  assert.ok(r.ok && r.value.events[0]!.extensions?.['x-acme-demo']?.['n'] === 2);
  await ok1.close();
  const without = await ChainedAuditStore.open({ dir });
  assert.ok(!without.ok && without.error.code === ErrorCode.AUDIT_CORRUPT, 'an event whose namespace is no longer registered fails closed');
});

test('truncation helper sanity: a zero-byte file is treated as fresh and gets a header', async () => {
  const dir = await tmpDir();
  await filled(dir, {}, 1);
  await truncate(join(dir, CHAIN_LOG_FILE), 0);
  const s = await open(dir);
  assert.ok((await s.append(draft({ idempotencyKey: 'n' }))).ok);
  await s.close();
});
