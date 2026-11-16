// UW-1: API keys expire (explicitly, or by the server's maximum key age for keys issued before expiry existed) and can be rotated
// without a lock-out window. An expired key is refused with its own code so a client knows the remedy is rotation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '@xo/errors';
import { LocalFsBlobStore } from '@xo/storage';
import { TestServer, withTempDir } from './test-helpers.js';
import { apiKeyExpired, DEFAULT_API_KEY_MAX_AGE_DAYS } from '../src/http/auth.js';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';
import { FsApiKeyStore } from '../src/auth/fs-api-key-store.js';
import { DEFAULT_KEY_LIFETIME_DAYS, issueApiKey, rotateApiKeys } from '../src/auth/key-lifecycle.js';
import { parseApiKeyMaxAgeDays } from '../src/config.js';

const NOW = Date.parse('2026-11-13T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const base = { keyHash: 'h', identityId: 'alice', principalKind: 'human' as const };

test('apiKeyExpired: explicit expiry, legacy max age, and unparseable timestamps fail closed', () => {
  assert.equal(apiKeyExpired({ ...base, createdAt: '2026-11-01T00:00:00Z', expiresAt: '2026-11-12T23:59:59Z' }, NOW), true);
  assert.equal(
    apiKeyExpired({ ...base, createdAt: '2026-11-01T00:00:00Z', expiresAt: '2026-11-13T00:00:00Z' }, NOW),
    true,
    'expiry instant is expired',
  );
  assert.equal(apiKeyExpired({ ...base, createdAt: '2026-11-01T00:00:00Z', expiresAt: '2026-11-14T00:00:00Z' }, NOW), false);
  const legacyOld = { ...base, createdAt: new Date(NOW - (DEFAULT_API_KEY_MAX_AGE_DAYS + 1) * DAY).toISOString() };
  const legacyFresh = { ...base, createdAt: new Date(NOW - 10 * DAY).toISOString() };
  assert.equal(apiKeyExpired(legacyOld, NOW), true, 'a key issued before expiry existed is bounded by the max age');
  assert.equal(apiKeyExpired(legacyFresh, NOW), false);
  assert.equal(apiKeyExpired(legacyOld, NOW, DEFAULT_API_KEY_MAX_AGE_DAYS + 2), false, 'the max age is configurable');
  assert.equal(apiKeyExpired({ ...base, createdAt: 'not a date' }, NOW), true);
  assert.equal(apiKeyExpired({ ...base, createdAt: '2026-11-01T00:00:00Z', expiresAt: 'garbage' }, NOW), true);
});

test('XO_API_KEY_MAX_AGE_DAYS: default 365; a bad value aborts startup', () => {
  assert.equal(parseApiKeyMaxAgeDays(undefined), 365);
  assert.equal(parseApiKeyMaxAgeDays(' 30 '), 30);
  for (const bad of ['0', '-1', '1.5', 'ten', '3651']) assert.throws(() => parseApiKeyMaxAgeDays(bad), /XO_API_KEY_MAX_AGE_DAYS/);
});

async function keyWith(server: TestServer, extra: { createdAt: string; expiresAt?: string }): Promise<string> {
  const raw = generateApiKey();
  const created = await server.apiKeyStore.create({ keyHash: hashApiKey(raw), identityId: 'k-user', principalKind: 'human', ...extra });
  assert.ok(created.ok);
  return raw;
}

test('an expired key is refused with 401 XO_AUTH_KEY_EXPIRED; a valid one works', async () => {
  const server = await TestServer.start();
  try {
    const expired = await keyWith(server, {
      createdAt: new Date(Date.now() - 10 * DAY).toISOString(),
      expiresAt: new Date(Date.now() - DAY).toISOString(),
    });
    const r = await server.request('GET', '/workspaces', undefined, TestServer.authHeader(expired));
    assert.equal(r.status, 401, r.bodyText);
    assert.equal(r.json<{ error: { code: string } }>().error.code, ErrorCode.AUTH_KEY_EXPIRED);

    const valid = await keyWith(server, { createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + DAY).toISOString() });
    assert.equal((await server.request('GET', '/workspaces', undefined, TestServer.authHeader(valid))).status, 200);
  } finally {
    await server.stop();
  }
});

test('a pre-expiry key older than the server maximum age is refused; raising the configured maximum admits it', async () => {
  const old = new Date(Date.now() - 400 * DAY).toISOString();
  const strict = await TestServer.start();
  try {
    const raw = await keyWith(strict, { createdAt: old });
    const r = await strict.request('GET', '/workspaces', undefined, TestServer.authHeader(raw));
    assert.equal(r.status, 401);
    assert.equal(r.json<{ error: { code: string } }>().error.code, ErrorCode.AUTH_KEY_EXPIRED);
  } finally {
    await strict.stop();
  }
  const lenient = await TestServer.start({ apiKeyMaxAgeDays: 500 });
  try {
    const raw = await keyWith(lenient, { createdAt: old });
    assert.equal((await lenient.request('GET', '/workspaces', undefined, TestServer.authHeader(raw))).status, 200);
  } finally {
    await lenient.stop();
  }
});

test('issueApiKey: every key gets an expiry (default 90 days); out-of-range lifetimes and a missing kind are refused', async () => {
  await withTempDir('xo-keys-', async (dir) => {
    const store = new FsApiKeyStore(new LocalFsBlobStore(dir));
    const now = () => new Date(NOW);
    const issued = await issueApiKey(store, { identityId: 'alice', kind: 'human', now });
    assert.ok(issued.ok);
    assert.equal(issued.value.record.expiresAt, new Date(NOW + DEFAULT_KEY_LIFETIME_DAYS * DAY).toISOString());
    assert.equal(issued.value.record.keyHash, hashApiKey(issued.value.rawKey));
    assert.ok(!JSON.stringify(issued.value.record).includes(issued.value.rawKey), 'the raw key is never part of the stored record');
    for (const expiresInDays of [0, 3651, 1.5]) {
      const r = await issueApiKey(store, { identityId: 'alice', kind: 'human', expiresInDays, now });
      assert.equal(r.ok, false, `lifetime ${expiresInDays}`);
    }
    assert.equal((await issueApiKey(store, { identityId: 'alice', kind: undefined, now })).ok, false, 'no default principal kind');
  });
});

test('rotateApiKeys: the new key works, every previous key of that identity is revoked, other identities are untouched', async () => {
  const server = await TestServer.start();
  try {
    const first = await issueApiKey(server.apiKeyStore, { identityId: 'rot-user', kind: 'human' });
    const second = await issueApiKey(server.apiKeyStore, { identityId: 'rot-user', kind: 'human' });
    assert.ok(first.ok && second.ok);
    const rotated = await rotateApiKeys(server.apiKeyStore, { identityId: 'rot-user', kind: 'human', expiresInDays: 30 });
    assert.ok(rotated.ok);
    assert.deepEqual([...rotated.value.revokedKeyHashes].sort(), [first.value.record.keyHash, second.value.record.keyHash].sort());

    const status = async (raw: string) => (await server.request('GET', '/workspaces', undefined, TestServer.authHeader(raw))).status;
    assert.equal(await status(rotated.value.rawKey), 200);
    assert.equal(await status(first.value.rawKey), 401);
    assert.equal(await status(second.value.rawKey), 401);
    assert.equal((await server.request('GET', '/workspaces')).status, 200, "the server's own identity is untouched");
  } finally {
    await server.stop();
  }
});
