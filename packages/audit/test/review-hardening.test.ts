/**
 * C0.3 review regressions. Each test reproduces a concrete defect found in code review of the C0.3 commits.
 * They were written FAILING first against 1e909b9 and then fixed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorCode } from '@xo/errors';
import { CHAIN_LOCK_FILE, CHAIN_LOG_FILE, ChainedAuditStore, readClosedChainedLog, type AuditExtensionSchemas } from '../src/index.js';
import { validateExtensionSchema } from '../src/extension.js';
import { FILTERS } from '../src/validate.js';
import { controller, draft, principal, tmpDir } from './helpers.js';

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, x]) => [k, sortKeys(x)]),
        )
      : v;
const canonical = (v: unknown): string => JSON.stringify(sortKeys(v));
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** What an attacker who can rewrite the whole (UNKEYED) file can do: edit a record and re-chain everything after it. */
async function rechain(dir: string, edit: (rec: Record<string, unknown>, index: number) => void): Promise<void> {
  const lines = (await readFile(join(dir, CHAIN_LOG_FILE), 'utf8')).split('\n').filter(Boolean);
  let prev = '0'.repeat(64);
  const out = lines.map((l, i) => {
    const rec = JSON.parse(l) as Record<string, unknown>;
    edit(rec, i);
    rec['prevHash'] = prev;
    delete rec['hash'];
    rec['hash'] = sha(canonical(rec));
    prev = rec['hash'] as string;
    return JSON.stringify(rec);
  });
  await writeFile(join(dir, CHAIN_LOG_FILE), `${out.join('\n')}\n`);
}

test('REVIEW-1 (single writer): racing to take over a STALE lock yields at most one writer (before the fix: ~2% of rounds had several)', async () => {
  let multi = 0;
  for (let round = 0; round < 250; round++) {
    const dir = await tmpDir();
    // A crashed writer: lock left behind by a provably dead pid on this host.
    await writeFile(join(dir, CHAIN_LOCK_FILE), JSON.stringify({ pid: 2 ** 22 + 777, host: hostname() }));
    const results = await Promise.all(Array.from({ length: 16 }, () => ChainedAuditStore.open({ dir })));
    const winners = results.filter((r) => r.ok);
    if (winners.length > 1) multi++;
    for (const w of winners) if (w.ok) await w.value.close();
    for (const r of results) if (!r.ok) assert.ok(r.error.code === ErrorCode.AUDIT_LOCKED, 'losers fail closed with AUDIT_LOCKED');
  }
  assert.equal(multi, 0, `${multi} of 250 rounds produced more than one simultaneous writer`);
});

test('REVIEW-1b: a takeover guard left by a crash fails CLOSED (AUDIT_LOCKED) instead of risking a second writer', async () => {
  const dir = await tmpDir();
  await writeFile(join(dir, CHAIN_LOCK_FILE), JSON.stringify({ pid: 2 ** 22 + 777, host: hostname() }));
  await writeFile(join(dir, `${CHAIN_LOCK_FILE}.takeover`), '{}');
  const r = await ChainedAuditStore.open({ dir });
  assert.ok(!r.ok && r.error.code === ErrorCode.AUDIT_LOCKED);
});

test('REVIEW-2 (read boundary): a CLOSED log cannot be read without an authorization grant', async () => {
  const dir = await tmpDir();
  const s = await ChainedAuditStore.open({ dir });
  assert.ok(s.ok);
  if (!s.ok) return;
  assert.ok((await s.value.append(draft({ idempotencyKey: 'k' }))).ok);
  await s.value.close();
  assert.ok(!(await readClosedChainedLog(dir, undefined)).ok, 'events must not be readable without a grant');
  assert.ok(!(await readClosedChainedLog(dir, { kind: 'xo.audit.access-grant', action: 'read' })).ok, 'a forged grant reads nothing');
  const wrong = await controller().authorize(principal('service', 'auditor'), 'purge');
  assert.ok(wrong.ok && !(await readClosedChainedLog(dir, wrong.value)).ok, 'a purge grant cannot read');
  const g = await controller().authorize(principal('service', 'auditor'), 'read');
  assert.ok(g.ok);
  if (!g.ok) return;
  const granted = await readClosedChainedLog(dir, g.value);
  assert.ok(granted.ok && granted.value.length === 1, 'an authorized caller can read');
});

test('REVIEW-3 (re-validation): a persisted event with a malformed actor is corruption even if the chain was re-hashed', async () => {
  for (const mutate of [
    (ev: Record<string, unknown>) => ((ev['actor'] as Record<string, unknown>)['note'] = 'Bearer abcdefghijklmnop0123456789'),
    (ev: Record<string, unknown>) => (ev['actor'] = { kind: 'root', id: 'x' }),
    (ev: Record<string, unknown>) => (ev['actor'] = { kind: 'human', id: 'has space/../etc' }),
    (ev: Record<string, unknown>) => (ev['retainUntil'] = '2000-01-01T00:00:00.000Z'),
    (ev: Record<string, unknown>) => (ev['eventId'] = 'not-an-id'),
  ]) {
    const dir = await tmpDir();
    const s = await ChainedAuditStore.open({ dir });
    assert.ok(s.ok);
    if (!s.ok) return;
    assert.ok((await s.value.append(draft({ idempotencyKey: 'k' }))).ok);
    await s.value.close();
    await rechain(dir, (rec) => {
      if (rec['kind'] === 'event') mutate(rec['event'] as Record<string, unknown>);
    });
    const reopened = await ChainedAuditStore.open({ dir });
    assert.ok(!reopened.ok && reopened.error.code === ErrorCode.AUDIT_CORRUPT, 'malformed stored event must fail closed');
  }
});

test('REVIEW-4 (extension filter): an opaque pattern is enforced as FULLY anchored at match time, not by a prefix/suffix check of its source', async () => {
  const schemas: AuditExtensionSchemas = {
    'x-acme-demo': { namespace: 'x-acme-demo', fields: { d: { kind: 'opaque', pattern: /^sha256:[0-9a-f]{8}|zzz$/, maxLength: 40 } } },
  };
  const dir = await tmpDir();
  const s = await ChainedAuditStore.open({ dir, extensionSchemas: schemas });
  // Either the schema is refused at open, or a value that matches only one unanchored alternative is refused at write.
  if (!s.ok) return assert.equal(s.error.code, ErrorCode.AUDIT_CONFIG_INVALID);
  const r = await s.value.append(draft({ extensions: { 'x-acme-demo': { d: 'Bearer-secret-material-zzz' } } }));
  assert.ok(!r.ok, 'an alternation must not let a non-anchored value through');
  await s.value.close();
  assert.ok(
    validateExtensionSchema({ namespace: 'x-a-b', fields: { d: { kind: 'opaque', pattern: /^[a-f0-9]{8}$/, maxLength: 8 } } }, FILTERS).ok,
    'a correct anchored pattern stays valid',
  );
});

test('VERIFY (identity): canonical identity does not depend on key order of metadata or extensions, so a reordered retry is a duplicate, not a conflict', async () => {
  const schemas: AuditExtensionSchemas = {
    'x-acme-demo': {
      namespace: 'x-acme-demo',
      fields: {
        a: { kind: 'count' },
        o: { kind: 'object', fields: { x: { kind: 'id' }, y: { kind: 'bool' } } },
        l: { kind: 'list', max: 3, of: { kind: 'id' } },
      },
    },
  };
  const dir = await tmpDir();
  const s = await ChainedAuditStore.open({ dir, extensionSchemas: schemas });
  assert.ok(s.ok);
  if (!s.ok) return;
  const one = draft({
    idempotencyKey: 'order',
    metadata: { b: 'two', a: 'one' },
    extensions: { 'x-acme-demo': { a: 1, o: { x: 'p', y: true }, l: ['i', 'j'] } },
  });
  const two = draft({
    idempotencyKey: 'order',
    metadata: { a: 'one', b: 'two' },
    extensions: { 'x-acme-demo': { l: ['i', 'j'], o: { y: true, x: 'p' }, a: 1 } },
  });
  assert.ok((await s.value.append(one)).ok);
  const retry = await s.value.append(two);
  assert.ok(retry.ok && retry.duplicate, 'same content in a different key order is the same event');
  const reordered = await s.value.append(
    draft({
      idempotencyKey: 'order',
      metadata: { a: 'one', b: 'two' },
      extensions: { 'x-acme-demo': { a: 1, o: { x: 'p', y: true }, l: ['j', 'i'] } },
    }),
  );
  assert.ok(!reordered.ok && reordered.error.code === ErrorCode.AUDIT_CONFLICT, 'array ORDER is content');
  await s.value.close();
  const again = await ChainedAuditStore.open({ dir, extensionSchemas: schemas });
  assert.ok(again.ok);
  if (!again.ok) return;
  const afterRestart = await again.value.append(two);
  assert.ok(afterRestart.ok && afterRestart.duplicate, 'identity is stable across a restart');
  await again.value.close();
});

test('VERIFY (extension filter): secrets cannot enter through list items, nested objects, or look-alike opaque values', async () => {
  const schemas: AuditExtensionSchemas = {
    'x-acme-demo': {
      namespace: 'x-acme-demo',
      fields: {
        l: { kind: 'list', max: 3, of: { kind: 'id' }, optional: true },
        o: { kind: 'object', optional: true, fields: { x: { kind: 'id' } } },
        d: { kind: 'opaque', pattern: /^sha256:[0-9a-f]{64}$/, maxLength: 71, optional: true },
      },
    },
  };
  const dir = await tmpDir();
  const s = await ChainedAuditStore.open({ dir, extensionSchemas: schemas });
  assert.ok(s.ok);
  if (!s.ok) return;
  const secret = 'Bearer abcdefghijklmnop0123456789';
  for (const ext of [
    { l: ['fine', secret] },
    { l: ['x'.repeat(48)] },
    { o: { x: secret } },
    { o: { x: 'ok', extra: 'member' } },
    { d: `sha256:${'a'.repeat(63)}` },
    { d: `sha256:${'a'.repeat(64)}\nBearer abcdefghijklmnop0123456789` },
    { d: ['sha256'] },
    { l: { 0: 'a' } },
  ]) {
    const r = await s.value.append(draft({ extensions: { 'x-acme-demo': ext as never } }));
    assert.ok(!r.ok && r.error.code === ErrorCode.AUDIT_EVENT_INVALID, `rejected: ${JSON.stringify(Object.keys(ext))}`);
  }
  await s.value.close();
  const raw = await readFile(join(dir, CHAIN_LOG_FILE), 'utf8');
  assert.ok(!raw.includes('abcdefghijklmnop') && !raw.includes('extra'), 'nothing rejected reached the disk');
});
