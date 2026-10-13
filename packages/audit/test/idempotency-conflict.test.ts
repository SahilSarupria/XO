import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorCode } from '@xo/errors';
import { FileAuditStore, NonProductionAuditSink, validateDraft, type AuditExtensionSchemas } from '../src/index.js';
import { draft, tmpDir } from './helpers.js';

const retention = { defaultRetentionMs: 30 * 86_400_000, minimumRetentionMs: 7 * 86_400_000 };

test('platform store: exact retry is a duplicate (original event, flagged); same key with DIFFERENT content is AUDIT_CONFLICT and writes nothing', async () => {
  const dir = await tmpDir();
  const store = await FileAuditStore.open({ dir, retention });
  const first = await store.append(draft({ idempotencyKey: 'op-1', outcome: 'attempted' }));
  assert.ok(first.ok && first.duplicate === false);
  const retry = await store.append(draft({ idempotencyKey: 'op-1', outcome: 'attempted' }));
  assert.ok(retry.ok && retry.duplicate === true && first.ok && retry.event.eventId === first.event.eventId);
  const conflict = await store.append(draft({ idempotencyKey: 'op-1', outcome: 'denied', type: 'access.denied' }));
  assert.equal(conflict.ok, false);
  if (!conflict.ok) {
    assert.equal(conflict.error.code, ErrorCode.AUDIT_CONFLICT);
    assert.equal(conflict.indeterminate, false);
  }
  const text = await readFile(join(dir, 'audit.jsonl'), 'utf8');
  assert.equal(text.split('\n').filter(Boolean).length, 1, 'neither the duplicate nor the conflict wrote anything');
});

test('platform store: the conflict is also detected across a restart (index rebuilt from the file)', async () => {
  const dir = await tmpDir();
  const a = await FileAuditStore.open({ dir, retention });
  assert.ok((await a.append(draft({ idempotencyKey: 'k-restart' }))).ok);
  const b = await FileAuditStore.open({ dir, retention });
  const same = await b.append(draft({ idempotencyKey: 'k-restart' }));
  assert.ok(same.ok && same.duplicate);
  const diff = await b.append(draft({ idempotencyKey: 'k-restart', reasonCode: 'SOME_OTHER_REASON' }));
  assert.ok(!diff.ok && diff.error.code === ErrorCode.AUDIT_CONFLICT);
});

test('non-production sink applies the same duplicate/conflict rules', async () => {
  const sink = new NonProductionAuditSink();
  assert.ok((await sink.append(draft({ idempotencyKey: 'k' }))).ok);
  const dup = await sink.append(draft({ idempotencyKey: 'k' }));
  assert.ok(dup.ok && dup.duplicate);
  const conflict = await sink.append(draft({ idempotencyKey: 'k', outcome: 'failed', type: 'access.denied' }));
  assert.ok(!conflict.ok && conflict.error.code === ErrorCode.AUDIT_CONFLICT);
  assert.equal(sink.events().length, 1);
});

test('the unchained platform store REFUSES lifecycle and unregistered extensions instead of silently dropping the guarantee', async () => {
  const dir = await tmpDir();
  const store = await FileAuditStore.open({ dir, retention });
  const life = await store.append(draft({ lifecycle: { operationId: 'op-9', phase: 'attempt' } }));
  assert.ok(!life.ok && life.error.code === ErrorCode.AUDIT_EVENT_INVALID);
  const ext = await store.append(draft({ extensions: { 'x-acme-demo': { n: 1 } } }));
  assert.ok(!ext.ok && ext.error.code === ErrorCode.AUDIT_EVENT_INVALID);
});

const schemas: AuditExtensionSchemas = {
  'x-acme-demo': {
    namespace: 'x-acme-demo',
    fields: {
      n: { kind: 'count' },
      digest: { kind: 'opaque', pattern: /^sha256:[0-9a-f]{64}$/, maxLength: 71, optional: true },
      ids: { kind: 'list', max: 3, of: { kind: 'id' }, optional: true },
      label: { kind: 'id', optional: true },
    },
  },
};
const ok = (ext: unknown) => validateDraft(draft({ extensions: ext as never }), { extensionSchemas: schemas });

test('extensions: strictly typed and bounded; the GLOBAL secret filter is not weakened', () => {
  const hex = 'a'.repeat(64);
  assert.ok(
    ok({ 'x-acme-demo': { n: 1, digest: `sha256:${hex}`, ids: ['ev_abc', 'ev_def'] } }).ok,
    'valid shape incl. an anchored opaque digest',
  );
  assert.ok(!ok({ 'x-acme-demo': { n: 1, extra: 'x' } }).ok, 'unknown member rejected');
  assert.ok(!ok({ 'x-acme-demo': { n: -1 } }).ok && !ok({ 'x-acme-demo': { n: 1.5 } }).ok, 'counts are non-negative integers');
  assert.ok(!ok({ 'x-acme-demo': { n: 1, ids: ['a', 'b', 'c', 'd'] } }).ok, 'list bound enforced');
  assert.ok(
    !ok({ 'x-acme-demo': { n: 1, digest: `sha256:${hex}0` } }).ok && !ok({ 'x-acme-demo': { n: 1, digest: hex } }).ok,
    'opaque must match its anchored pattern exactly',
  );
  assert.ok(!ok({ 'x-acme-demo': { n: 1, label: 'Bearer abcdef0123456789' } }).ok, 'bearer token in an id field rejected');
  assert.ok(!ok({ 'x-acme-demo': { n: 1, label: 'sk-ABCDEFGHIJKLMNOPQRSTUVWX' } }).ok, 'provider-key-shaped value rejected');
  assert.ok(
    !ok({ 'x-acme-demo': { n: 1, label: 'A'.repeat(60) } }).ok,
    'long opaque blob in an id field rejected (opaque filter still applies to ids)',
  );
  assert.ok(!ok({ 'x-other-ns': { n: 1 } }).ok, 'unregistered namespace rejected');
  const bad = ok({ 'x-acme-demo': { n: 1, label: 'Bearer abcdef0123456789' } });
  assert.ok(!bad.ok && !bad.error.message.includes('abcdef0123456789'), 'the offending value is never echoed');
});

test('extension schemas cannot declare sensitive-named fields or unbounded lists', async () => {
  const { validateExtensionSchema } = await import('../src/extension.js');
  const { FILTERS } = await import('../src/validate.js');
  assert.ok(!validateExtensionSchema({ namespace: 'x-a-b', fields: { token: { kind: 'id' } } }, FILTERS).ok);
  assert.ok(!validateExtensionSchema({ namespace: 'x-a-b', fields: { fileContent: { kind: 'id' } } }, FILTERS).ok);
  assert.ok(
    !validateExtensionSchema({ namespace: 'x-a-b', fields: { ids: { kind: 'list', max: 10_000_000, of: { kind: 'id' } } } }, FILTERS).ok,
  );
  assert.ok(
    !validateExtensionSchema({ namespace: 'x-a-b', fields: { d: { kind: 'opaque', pattern: /sha256/, maxLength: 10 } } }, FILTERS).ok,
    'unanchored pattern rejected',
  );
  assert.ok(!validateExtensionSchema({ namespace: 'bad', fields: {} }, FILTERS).ok);
});
