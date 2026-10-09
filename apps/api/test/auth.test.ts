import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalFsBlobStore } from '@xo/storage';
import { ErrorCode } from '@xo/errors';
import { TestServer, withTempDir } from './test-helpers.js';
import { FsApiKeyStore } from '../src/auth/fs-api-key-store.js';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';

// ---------------------------------------------------------------------
// Middleware, end-to-end (real loopback HTTP, real FsApiKeyStore) — the
// exact test matrix the brief calls for: valid key, missing key,
// malformed header, revoked key, unknown key, plus a full
// issue -> use -> revoke -> fails round trip.
// ---------------------------------------------------------------------

test('a valid API key authenticates successfully against a real, non-exempt route', async () => {
  const server = await TestServer.start();
  try {
    // /registry/search is a real route (400s on a missing query param,
    // not 401) — reaching that 400 instead of a 401 is what proves the
    // default key TestServer provisions actually authenticated.
    const res = await server.request('GET', '/registry/search');
    assert.equal(res.status, 400);
    assert.equal(res.json<{ error: { code: string } }>().error.code, ErrorCode.INVALID_ARGUMENT);
  } finally {
    await server.stop();
  }
});

test('missing Authorization header is rejected with 401 XO_AUTH_KEY_MISSING', async () => {
  const server = await TestServer.start();
  try {
    const res = await server.request('GET', '/registry/search', undefined, {}, { skipAuth: true });
    assert.equal(res.status, 401);
    assert.equal(res.json<{ error: { code: string } }>().error.code, ErrorCode.AUTH_KEY_MISSING);
  } finally {
    await server.stop();
  }
});

test('a malformed Authorization header (no Bearer scheme) is rejected with 401 XO_AUTH_KEY_MISSING', async () => {
  const server = await TestServer.start();
  try {
    const res = await server.request('GET', '/registry/search', undefined, { authorization: 'Basic dXNlcjpwYXNz' });
    assert.equal(res.status, 401);
    assert.equal(res.json<{ error: { code: string } }>().error.code, ErrorCode.AUTH_KEY_MISSING);
  } finally {
    await server.stop();
  }
});

test('a malformed Authorization header (Bearer with no token) is rejected with 401 XO_AUTH_KEY_MISSING', async () => {
  const server = await TestServer.start();
  try {
    const res = await server.request('GET', '/registry/search', undefined, { authorization: 'Bearer' });
    assert.equal(res.status, 401);
    assert.equal(res.json<{ error: { code: string } }>().error.code, ErrorCode.AUTH_KEY_MISSING);
  } finally {
    await server.stop();
  }
});

test('an unrecognized (well-formed but unissued) key is rejected with 401 XO_AUTH_KEY_INVALID', async () => {
  const server = await TestServer.start();
  try {
    const res = await server.request('GET', '/registry/search', undefined, { authorization: `Bearer ${generateApiKey()}` });
    assert.equal(res.status, 401);
    assert.equal(res.json<{ error: { code: string } }>().error.code, ErrorCode.AUTH_KEY_INVALID);
  } finally {
    await server.stop();
  }
});

test('a revoked key is rejected with 401 XO_AUTH_KEY_REVOKED, even though it was valid a moment before', async () => {
  const server = await TestServer.start();
  try {
    const before = await server.request('GET', '/registry/search');
    assert.equal(before.status, 400); // authenticated fine, failed on the route's own validation

    const revoked = await server.apiKeyStore.revokeByIdentity(server.identityId);
    assert.equal(revoked.ok, true);

    const after = await server.request('GET', '/registry/search');
    assert.equal(after.status, 401);
    assert.equal(after.json<{ error: { code: string } }>().error.code, ErrorCode.AUTH_KEY_REVOKED);
  } finally {
    await server.stop();
  }
});

test('/health and /openapi.json are exempt from auth entirely', async () => {
  const server = await TestServer.start();
  try {
    const health = await server.request('GET', '/health', undefined, {}, { skipAuth: true });
    assert.equal(health.status, 200);
    assert.deepEqual(health.json(), { status: 'ok' });

    const openapi = await server.request('GET', '/openapi.json', undefined, {}, { skipAuth: true });
    assert.equal(openapi.status, 200);
  } finally {
    await server.stop();
  }
});

test('a fresh key issued to a different identity after a revocation authenticates independently', async () => {
  const server = await TestServer.start();
  try {
    const revoked = await server.apiKeyStore.revokeByIdentity(server.identityId);
    assert.equal(revoked.ok, true);

    const newKey = generateApiKey();
    const created = await server.apiKeyStore.create({ keyHash: hashApiKey(newKey), identityId: 'second-identity', createdAt: new Date().toISOString() });
    assert.equal(created.ok, true);

    const res = await server.request('GET', '/registry/search', undefined, { authorization: `Bearer ${newKey}` });
    assert.equal(res.status, 400); // reached route validation, not 401 — the new key authenticated
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------
// FsApiKeyStore, directly — hashing at rest, duplicate/unknown lookups,
// idempotent revocation, concurrent issuance.
// ---------------------------------------------------------------------

test('FsApiKeyStore never persists the raw key — only its hash is ever written to storage', async () => {
  await withTempDir('xo-api-keys-', async (dir) => {
    const blobStore = new LocalFsBlobStore(dir);
    const store = new FsApiKeyStore(blobStore);
    const rawKey = generateApiKey();
    const created = await store.create({ keyHash: hashApiKey(rawKey), identityId: 'id-1', createdAt: new Date().toISOString() });
    assert.equal(created.ok, true);

    const listed = await blobStore.list('api-keys/');
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    for (const key of listed.value) {
      const raw = await blobStore.get(key);
      assert.equal(raw.ok, true);
      if (!raw.ok) continue;
      const text = new TextDecoder().decode(raw.value);
      assert.ok(!text.includes(rawKey), `stored record must not contain the raw key verbatim: ${text}`);
    }
  });
});

test('FsApiKeyStore.create() rejects a second record with the same key hash', async () => {
  await withTempDir('xo-api-keys-', async (dir) => {
    const store = new FsApiKeyStore(new LocalFsBlobStore(dir));
    const record = { keyHash: hashApiKey(generateApiKey()), identityId: 'id-1', createdAt: new Date().toISOString() };
    assert.equal((await store.create(record)).ok, true);
    const second = await store.create(record);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error.code, ErrorCode.ALREADY_EXISTS);
  });
});

test('FsApiKeyStore.findByHash() returns NotFoundError for an unissued hash', async () => {
  await withTempDir('xo-api-keys-', async (dir) => {
    const store = new FsApiKeyStore(new LocalFsBlobStore(dir));
    const result = await store.findByHash(hashApiKey(generateApiKey()));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, ErrorCode.NOT_FOUND);
  });
});

test('FsApiKeyStore.revokeByIdentity() is idempotent — revoking twice succeeds with revokedCount 0 the second time', async () => {
  await withTempDir('xo-api-keys-', async (dir) => {
    const store = new FsApiKeyStore(new LocalFsBlobStore(dir));
    const rawKey = generateApiKey();
    await store.create({ keyHash: hashApiKey(rawKey), identityId: 'id-1', createdAt: new Date().toISOString() });

    const first = await store.revokeByIdentity('id-1');
    assert.equal(first.ok, true);
    if (first.ok) assert.equal(first.value.revokedCount, 1);

    const second = await store.revokeByIdentity('id-1');
    assert.equal(second.ok, true);
    if (second.ok) assert.equal(second.value.revokedCount, 0);

    const found = await store.findByHash(hashApiKey(rawKey));
    assert.equal(found.ok, true);
    if (found.ok) assert.ok(found.value.revokedAt !== undefined);
  });
});

test('FsApiKeyStore.revokeByIdentity() returns NotFoundError for an identity with no key at all', async () => {
  await withTempDir('xo-api-keys-', async (dir) => {
    const store = new FsApiKeyStore(new LocalFsBlobStore(dir));
    const result = await store.revokeByIdentity('never-issued');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, ErrorCode.NOT_FOUND);
  });
});

test('FsApiKeyStore.revokeByIdentity() only revokes keys for the matching identity, not others', async () => {
  await withTempDir('xo-api-keys-', async (dir) => {
    const store = new FsApiKeyStore(new LocalFsBlobStore(dir));
    const keyA = generateApiKey();
    const keyB = generateApiKey();
    await store.create({ keyHash: hashApiKey(keyA), identityId: 'identity-a', createdAt: new Date().toISOString() });
    await store.create({ keyHash: hashApiKey(keyB), identityId: 'identity-b', createdAt: new Date().toISOString() });

    const revoked = await store.revokeByIdentity('identity-a');
    assert.equal(revoked.ok, true);
    if (revoked.ok) assert.equal(revoked.value.revokedCount, 1);

    const foundA = await store.findByHash(hashApiKey(keyA));
    const foundB = await store.findByHash(hashApiKey(keyB));
    assert.equal(foundA.ok, true);
    assert.equal(foundB.ok, true);
    if (foundA.ok) assert.ok(foundA.value.revokedAt !== undefined);
    if (foundB.ok) assert.equal(foundB.value.revokedAt, undefined);
  });
});

test('concurrent key creation for distinct identities all succeed without clobbering each other', async () => {
  await withTempDir('xo-api-keys-', async (dir) => {
    const store = new FsApiKeyStore(new LocalFsBlobStore(dir));
    const rawKeys = Array.from({ length: 10 }, () => generateApiKey());

    const results = await Promise.all(
      rawKeys.map((rawKey, i) => store.create({ keyHash: hashApiKey(rawKey), identityId: `concurrent-${i}`, createdAt: new Date().toISOString() })),
    );
    assert.ok(results.every((r) => r.ok));

    const lookups = await Promise.all(rawKeys.map((rawKey) => store.findByHash(hashApiKey(rawKey))));
    assert.ok(lookups.every((r) => r.ok));
    lookups.forEach((r, i) => {
      if (r.ok) assert.equal(r.value.identityId, `concurrent-${i}`);
    });
  });
});

// ---------------------------------------------------------------------
// generateApiKey()/hashApiKey() — basic sanity, not exhaustive crypto
// testing (that's @xo/crypto's own test surface for Sha256Hasher itself).
// ---------------------------------------------------------------------

test('generateApiKey() produces distinct, prefixed keys', () => {
  const a = generateApiKey();
  const b = generateApiKey();
  assert.notEqual(a, b);
  assert.ok(a.startsWith('xoak_'));
  assert.ok(b.startsWith('xoak_'));
});

test('hashApiKey() is deterministic and produces the sha256:<hex> shape', () => {
  const key = generateApiKey();
  const h1 = hashApiKey(key);
  const h2 = hashApiKey(key);
  assert.equal(h1, h2);
  assert.match(h1, /^sha256:[0-9a-f]{64}$/);
});
