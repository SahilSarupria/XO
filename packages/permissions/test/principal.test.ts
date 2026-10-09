import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '@xo/errors';
import {
  assertAuthenticatedPrincipal,
  establishAuthenticatedPrincipal,
  isAuthenticatedPrincipal,
  parsePrincipal,
  principalsEqual,
  toPrincipalSnapshot,
} from '../src/index.js';

// P1.0 M1 — principal contract. Shape validation + the authenticated/attribution distinction.

test('valid human principal', () => {
  const r = parsePrincipal({ kind: 'human', id: 'alice@example.com' });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual({ ...r.value }, { kind: 'human', id: 'alice@example.com' });
});

test('valid service principal, with optional orgId', () => {
  const r = parsePrincipal({ kind: 'service', id: 'svc-ci_1', orgId: 'org.acme' });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual({ ...r.value }, { kind: 'service', id: 'svc-ci_1', orgId: 'org.acme' });
});

test('orgId is optional and absent means absent (no default org)', () => {
  const r = parsePrincipal({ kind: 'service', id: 'svc' });
  assert.equal(r.ok && 'orgId' in r.value, false);
});

for (const [name, input] of [
  ['missing id', { kind: 'human' }],
  ['empty id', { kind: 'human', id: '' }],
  ['whitespace id', { kind: 'human', id: '   ' }],
  ['id with slash (path-unsafe)', { kind: 'human', id: 'a/b' }],
  ['id with control char', { kind: 'human', id: 'a\nb' }],
  ['id too long', { kind: 'human', id: 'a'.repeat(129) }],
  ['non-string id', { kind: 'human', id: 7 }],
  ['missing kind', { id: 'x' }],
  ['invalid kind', { kind: 'admin', id: 'x' }],
  ['package-ish kind', { kind: 'package', id: 'x' }],
  ['malformed orgId (empty)', { kind: 'human', id: 'x', orgId: '' }],
  ['malformed orgId (non-string)', { kind: 'human', id: 'x', orgId: 5 }],
  ['malformed orgId (unsafe chars)', { kind: 'human', id: 'x', orgId: '../o' }],
  ['unknown authority-like field', { kind: 'human', id: 'x', roles: ['admin'] }],
  ['not an object', 'alice'],
  ['null', null],
  ['array', []],
] as const) {
  test(`rejects: ${name}`, () => {
    const r = parsePrincipal(input);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, ErrorCode.INVALID_ARGUMENT);
  });
}

test('parsed principal is a frozen copy, not the caller object', () => {
  const src = { kind: 'human', id: 'x' };
  const r = parsePrincipal(src);
  assert.ok(r.ok && r.value !== (src as unknown) && Object.isFrozen(r.value));
});

test('only establishAuthenticatedPrincipal output is authenticated; copies/JSON/parsed are not', () => {
  const parsed = parsePrincipal({ kind: 'human', id: 'x' });
  assert.ok(parsed.ok);
  const auth = establishAuthenticatedPrincipal({ kind: 'human', id: 'x' });
  assert.ok(auth.ok);
  assert.equal(isAuthenticatedPrincipal(auth.value), true);
  assert.equal(isAuthenticatedPrincipal(parsed.value), false);
  assert.equal(isAuthenticatedPrincipal({ ...auth.value }), false); // structural copy
  assert.equal(isAuthenticatedPrincipal(JSON.parse(JSON.stringify(auth.value))), false); // deserialized
  assert.equal(isAuthenticatedPrincipal(toPrincipalSnapshot(auth.value)), false); // persisted snapshot
  assert.equal(isAuthenticatedPrincipal(undefined), false);
  assert.equal(isAuthenticatedPrincipal('x'), false);
  assert.throws(() => assertAuthenticatedPrincipal({ kind: 'human', id: 'x' }));
  assert.doesNotThrow(() => assertAuthenticatedPrincipal(auth.value));
});

test('establishAuthenticatedPrincipal validates shape too (fail closed)', () => {
  assert.equal(establishAuthenticatedPrincipal({ kind: undefined, id: 'x' }).ok, false);
  assert.equal(establishAuthenticatedPrincipal({ kind: 'human', id: '' }).ok, false);
});

test('principalsEqual compares kind, id and orgId; a package/capability id is not a principal comparison', () => {
  const a = { kind: 'human', id: 'x' } as const;
  assert.equal(principalsEqual(a, { kind: 'human', id: 'x' }), true);
  assert.equal(principalsEqual(a, { kind: 'service', id: 'x' }), false);
  assert.equal(principalsEqual(a, { kind: 'human', id: 'x', orgId: 'o' }), false);
});
