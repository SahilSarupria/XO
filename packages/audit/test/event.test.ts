import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '@xo/errors';
import {
  actorFromPrincipal,
  ANONYMOUS_ACTOR,
  isDurableReceipt,
  validateDraft,
  NonProductionAuditSink,
  assertNotAuditData,
} from '../src/index.js';
import { draft, principal } from './helpers.js';

test('a well-formed draft validates', () => {
  const r = validateDraft(
    draft({ reasonCode: 'XO_RUNTIME_PERMISSION_DENIED', metadata: { capabilityKind: 'rule', attempt: 1, replay: false } }),
  );
  assert.equal(r.ok, true);
});

test('actor must be minted from a VERIFIED principal', () => {
  assert.throws(() => actorFromPrincipal({ kind: 'service', id: 'svc' } as never), /verified/);
  const forged = JSON.parse(JSON.stringify(actorFromPrincipal(principal('human', 'alice'))));
  const r = validateDraft({ ...draft(), actor: forged });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, ErrorCode.AUDIT_EVENT_INVALID);
  assert.equal(validateDraft({ ...draft(), actor: { kind: 'human', id: 'root' } }).ok, false);
  assert.equal(validateDraft({ ...draft(), actor: ANONYMOUS_ACTOR }).ok, true);
});

test('request-supplied trusted fields are rejected (id, seq, time, receipt, retention, classification)', () => {
  for (const extra of ['eventId', 'seq', 'recordedAt', 'retainUntil', 'receipt', 'classification', 'schemaVersion', 'durable']) {
    const r = validateDraft({ ...draft(), [extra]: 'x' });
    assert.equal(r.ok, false, extra);
  }
  for (const key of ['recordedAt', 'receipt', 'eventId', 'outcome', 'seq']) {
    assert.equal(validateDraft(draft({ metadata: { [key]: 'x' } })).ok, false, `metadata.${key}`);
  }
});

test('metadata rejects secrets, content-bearing keys and opaque blobs — without echoing the value', () => {
  const secret = 'Bearer abcdef1234567890SECRETVALUE';
  const cases: Record<string, string | number | boolean>[] = [
    { note: secret },
    { authToken: 'x' },
    { apiKey: 'x' },
    { prompt: 'summarize this' },
    { inputPayload: 'x' },
    { documentText: 'x' },
    { blob: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVm' },
    { jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig' },
    { pem: '-----BEGIN PRIVATE KEY-----' },
    { multi: 'a\nb' },
    { n: Number.NaN },
    { nested: { a: 1 } as never },
  ];
  for (const metadata of cases) {
    const r = validateDraft(draft({ metadata }));
    assert.equal(r.ok, false, JSON.stringify(metadata));
    if (!r.ok) assert.ok(!r.error.message.includes('SECRETVALUE') && !r.error.message.includes('abcdef'), 'error must not echo the value');
  }
});

test('unknown draft/target fields and malformed ids are rejected', () => {
  assert.equal(validateDraft({ ...draft(), extra: 1 }).ok, false);
  assert.equal(validateDraft(draft({ target: { kind: 'execution', id: '../etc/passwd' } })).ok, false);
  assert.equal(validateDraft(draft({ target: { kind: 'bogus' as never, id: 'x' } })).ok, false);
  assert.equal(validateDraft(draft({ type: 'nope' as never })).ok, false);
  assert.equal(validateDraft(draft({ outcome: 'maybe' as never })).ok, false);
  assert.equal(validateDraft(null).ok, false);
});

test('non-production sink: stable ids, volatile receipts only, no caller-controlled trusted fields', async () => {
  const sink = new NonProductionAuditSink(() => new Date('2026-01-01T00:00:00Z'));
  const a = await sink.append(draft());
  const b = await sink.append(draft());
  assert.ok(a.ok && b.ok);
  if (a.ok && b.ok) {
    assert.equal(a.receipt.guarantee, 'volatile-memory');
    assert.notEqual(a.event.eventId, b.event.eventId);
    assert.equal(b.event.seq, a.event.seq + 1);
    assert.equal(a.event.recordedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(isDurableReceipt(a.receipt), true);
  }
  const bad = await sink.append({ ...draft(), recordedAt: '1999-01-01' } as never);
  assert.equal(bad.ok, false);
});

test('receipts cannot be forged: literal, JSON/structured clone and spread all fail verification', async () => {
  const sink = new NonProductionAuditSink();
  const r = await sink.append(draft());
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(isDurableReceipt(r.receipt), true);
  assert.equal(isDurableReceipt({ ...r.receipt }), false);
  assert.equal(isDurableReceipt(JSON.parse(JSON.stringify(r.receipt))), false);
  assert.equal(isDurableReceipt(structuredClone(r.receipt)), false);
  assert.equal(
    isDurableReceipt({ kind: 'xo.audit.receipt', eventId: 'x', seq: 1, storeId: 's', recordedAt: 'now', guarantee: 'fsync-file' }),
    false,
  );
  assert.equal(isDurableReceipt(null), false);
});

test('model exclusion: audit events, receipts, serialized lines and nested containers are refused at the guard', async () => {
  const sink = new NonProductionAuditSink();
  const r = await sink.append(draft());
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.throws(
    () => assertNotAuditData(r.event, 'test boundary'),
    (e: Error) => /restricted audit data/.test(e.message) && !e.message.includes('exec-1'),
  );
  assert.throws(() => assertNotAuditData(r.receipt, 'test boundary'));
  assert.throws(() => assertNotAuditData(JSON.stringify(r.event), 'test boundary'));
  assert.throws(() => assertNotAuditData({ slices: [{ content: { deep: [r.event] } }] }, 'test boundary'));
  assert.doesNotThrow(() => assertNotAuditData({ content: 'ordinary policy text', nodes: [{ id: 'n1' }] }, 'test boundary'));
});
