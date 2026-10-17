/**
 * C0.4 — header-only torn-log recovery, provable under the crash model. Opt-in (`creationMarker: true`); the default
 * C0.3 behaviour (a log with no complete record is CORRUPT and needs an operator) must stay exactly as it was.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorCode } from '@xo/errors';
import {
  CHAIN_INIT_MARKER,
  CHAIN_LOG_FILE,
  ChainedAuditStore,
  defaultFileOps,
  verifyClosedChainedLog,
  type FileOps,
} from '../src/index.js';
import { draft, tmpDir } from './helpers.js';

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

/** Writes only half of the FIRST line (the header), then fails: a crash during header creation. */
function crashDuringHeader(): FileOps {
  const wrap = (h: Awaited<ReturnType<FileOps['openNew']>>) => ({
    write: async (d: Buffer) => {
      await h.write(d.subarray(0, Math.floor(d.length / 2)));
      throw Object.assign(new Error('crash'), { code: 'EIO' });
    },
    sync: () => h.sync(),
    close: () => h.close(),
  });
  return { ...defaultFileOps, openNew: async (p) => wrap(await defaultFileOps.openNew(p)) };
}

test('marker: a clean creation leaves NO marker behind, and the option is off by default', async () => {
  const dir = await tmpDir();
  const s = await ChainedAuditStore.open({ dir, creationMarker: true });
  assert.ok(s.ok);
  if (!s.ok) return;
  assert.equal(await exists(join(dir, CHAIN_INIT_MARKER)), false, 'removed once the header is durable');
  assert.ok((await s.value.append(draft({ idempotencyKey: 'a' }))).ok);
  await s.value.close();
  const plain = await tmpDir();
  const p = await ChainedAuditStore.open({ dir: plain });
  assert.ok(p.ok);
  if (p.ok) await p.value.close();
  assert.equal(await exists(join(plain, CHAIN_INIT_MARKER)), false, 'default behaviour never creates a marker');
});

test('marker: a crash during header creation is recovered as fresh — nothing acknowledged can be lost', async () => {
  const dir = await tmpDir();
  const crashed = await ChainedAuditStore.open({ dir, creationMarker: true, ops: crashDuringHeader() });
  assert.ok(!crashed.ok, 'the crashed creation never returned a store, so nothing could have been acknowledged');
  assert.equal(await exists(join(dir, CHAIN_INIT_MARKER)), true, 'the marker survives the crash');
  const partial = await readFile(join(dir, CHAIN_LOG_FILE), 'utf8');
  assert.ok(partial.length > 0 && !partial.includes('\n'), 'a torn header: no complete record exists');

  const again = await ChainedAuditStore.open({ dir, creationMarker: true });
  assert.ok(again.ok, 'recovered under the marker');
  if (!again.ok) return;
  assert.equal(await exists(join(dir, CHAIN_INIT_MARKER)), false);
  assert.ok((await again.value.append(draft({ idempotencyKey: 'first' }))).ok);
  const cp = again.value.checkpoint();
  assert.equal(cp.events, 1, 'a brand-new chain: only the new event exists');
  await again.value.close();
  assert.ok((await verifyClosedChainedLog(dir)).ok);
});

test('marker: the SAME torn file WITHOUT the marker (or with the option off) is corruption needing an operator', async () => {
  const dir = await tmpDir();
  await ChainedAuditStore.open({ dir, creationMarker: true, ops: crashDuringHeader() });
  await import('node:fs/promises').then((fs) => fs.unlink(join(dir, CHAIN_INIT_MARKER)));
  const noMarker = await ChainedAuditStore.open({ dir, creationMarker: true });
  assert.ok(!noMarker.ok && noMarker.error.code === ErrorCode.AUDIT_CORRUPT, 'no marker: cannot prove nothing was acknowledged');

  const dir2 = await tmpDir();
  await ChainedAuditStore.open({ dir: dir2, creationMarker: true, ops: crashDuringHeader() });
  const optionOff = await ChainedAuditStore.open({ dir: dir2 });
  assert.ok(!optionOff.ok && optionOff.error.code === ErrorCode.AUDIT_CORRUPT, 'default C0.3 behaviour is unchanged');
});

test('marker: it never licenses discarding a COMPLETE record or a damaged middle', async () => {
  // (a) a marker next to a log that already has a complete header and an event: opened normally, nothing discarded.
  const dir = await tmpDir();
  const s = await ChainedAuditStore.open({ dir });
  assert.ok(s.ok);
  if (!s.ok) return;
  assert.ok((await s.value.append(draft({ idempotencyKey: 'keep' }))).ok);
  await s.value.close();
  await writeFile(join(dir, CHAIN_INIT_MARKER), '');
  const reopened = await ChainedAuditStore.open({ dir, creationMarker: true });
  assert.ok(reopened.ok);
  if (!reopened.ok) return;
  assert.equal(reopened.value.checkpoint().events, 1, 'the acknowledged event is still there');
  assert.equal(await exists(join(dir, CHAIN_INIT_MARKER)), false, 'a stale marker is cleared after verification');
  await reopened.value.close();

  // (b) a marker next to a log whose first COMPLETE line is damaged: corruption, never "fresh".
  const dir2 = await tmpDir();
  await writeFile(join(dir2, CHAIN_LOG_FILE), '{"not":"a header"}\n');
  await writeFile(join(dir2, CHAIN_INIT_MARKER), '');
  const damaged = await ChainedAuditStore.open({ dir: dir2, creationMarker: true });
  assert.ok(!damaged.ok && damaged.error.code === ErrorCode.AUDIT_CORRUPT);
  assert.equal((await readFile(join(dir2, CHAIN_LOG_FILE), 'utf8')).length, '{"not":"a header"}\n'.length, 'nothing was truncated');
});
