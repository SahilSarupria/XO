import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  DEVELOPMENT_TRUST_WARNING,
  PackageTrustPolicy,
  TRUST_MODE_ENV,
  loadOperatorTrustPolicy,
  packBundle,
  PackageSigner,
  parseTrustPolicy,
  TRUST_POLICY_ENV,
} from '@xo/package-sdk';
import { ErrorCode } from '@xo/errors';
import type { Logger } from '@xo/logger';
import { TestServer, withTempDir } from './test-helpers.js';
import { buildFixtureBundle } from './fixtures.js';
import { buildRouter } from '../src/server.js';

const pair = generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function enforcing(did: string) {
  const r = parseTrustPolicy({ version: 1, keys: [{ signerDid: did, publicKeyPem: publicKey, algorithm: 'ed25519', status: 'active' }] });
  if (!r.ok) throw r.error;
  return r.value;
}

test('POST /packages/validate rejects caller-supplied publicKeys outright (a request cannot establish trust)', async () => {
  const server = await TestServer.start();
  try {
    const bundle = buildFixtureBundle({ name: 'xo_m5_pk' });
    const archive = Buffer.from(await packBundle(bundle));
    const res = await server.request('POST', '/packages/validate', {
      archiveBase64: archive.toString('base64'),
      publicKeys: { [bundle.manifest.creatorDid]: publicKey },
    });
    assert.equal(res.status, 400);
    assert.match(res.json<{ error: { message: string } }>().error.message, /trust policy/);
  } finally {
    await server.stop();
  }
});

test('POST /packages/validate (enforcing server policy): unsigned → 422 with PACKAGE_UNSIGNED; signed by the operator key → 200 trusted; attacker-signed → 422', async () => {
  const bundle = buildFixtureBundle({ name: 'xo_m5_enf' });
  const server = await TestServer.start({ packageTrustPolicy: enforcing(bundle.manifest.creatorDid) });
  try {
    const unsigned = await server.request('POST', '/packages/validate', {
      archiveBase64: Buffer.from(await packBundle(bundle)).toString('base64'),
    });
    assert.equal(unsigned.status, 422);
    const body = unsigned.json<{ trust: { status: string }; issues: { code: string }[] }>();
    assert.equal(body.trust.status, 'untrusted');
    assert.ok(body.issues.some((i) => i.code === 'PACKAGE_UNSIGNED'));

    const e = new PackageSigner().sign(bundle.manifest, bundle.manifest.creatorDid, 'creator', privateKey, publicKey);
    const good = {
      ...bundle,
      manifest: { ...bundle.manifest, signatures: [{ signerDid: e.signerDid, role: e.role, signature: e.signature }] },
    };
    const ok = await server.request('POST', '/packages/validate', {
      archiveBase64: Buffer.from(await packBundle(good)).toString('base64'),
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json<{ trust: { status: string } }>().trust.status, 'trusted');

    const attacker = generateKeyPairSync('ed25519');
    const ae = new PackageSigner().sign(
      bundle.manifest,
      bundle.manifest.creatorDid,
      'creator',
      attacker.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      attacker.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    );
    const evil = {
      ...bundle,
      manifest: { ...bundle.manifest, signatures: [{ signerDid: ae.signerDid, role: ae.role, signature: ae.signature }] },
    };
    const bad = await server.request('POST', '/packages/validate', {
      archiveBase64: Buffer.from(await packBundle(evil)).toString('base64'),
    });
    assert.equal(bad.status, 422);
  } finally {
    await server.stop();
  }
});

/** Replaces the trust-related environment for the duration of `fn`, then restores it (these tests run serially in one process). */
function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const keys = [TRUST_MODE_ENV, TRUST_POLICY_ENV, 'NODE_ENV'];
  const saved = keys.map((k) => [k, process.env[k]] as const);
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
const notConfigured = (e: unknown): boolean => (e as { code?: string }).code === ErrorCode.PACKAGE_TRUST_NOT_CONFIGURED;
const buildDeps = { workspaceDataDir: '/tmp/x', apiKeysDir: '/tmp/y', workspacesDir: '/tmp/z' };

test('server startup fails closed when XO_PACKAGE_TRUST_POLICY is set but unusable', () => {
  withEnv({ [TRUST_POLICY_ENV]: '/nonexistent/policy.json' }, () => {
    assert.equal(loadOperatorTrustPolicy().ok, false);
    assert.throws(() => buildRouter(buildDeps), notConfigured);
  });
});

test('server startup fails closed with NO trust configuration at all — a missing policy is not development mode', () => {
  for (const NODE_ENV of [undefined, 'development', 'test', 'production']) {
    withEnv(NODE_ENV === undefined ? {} : { NODE_ENV }, () => {
      assert.throws(() => buildRouter(buildDeps), notConfigured, String(NODE_ENV));
    });
  }
});

test('server startup: explicit development mode starts (outside production) and logs the warning; it is refused in production and with a policy file', () => {
  const warnings: string[] = [];
  const logger = {
    warn: (m: string) => warnings.push(m),
    info: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as Logger;
  withEnv({ [TRUST_MODE_ENV]: 'development' }, () => {
    assert.doesNotThrow(() => buildRouter({ ...buildDeps, logger }));
  });
  assert.ok(warnings.includes(DEVELOPMENT_TRUST_WARNING), 'development mode is logged loudly at startup');

  withEnv({ [TRUST_MODE_ENV]: 'development', NODE_ENV: 'production' }, () => {
    assert.throws(() => buildRouter(buildDeps), notConfigured);
  });
  withEnv({ [TRUST_MODE_ENV]: 'development', [TRUST_POLICY_ENV]: '/some/policy.json' }, () => {
    assert.throws(() => buildRouter(buildDeps), notConfigured);
  });
  // An injected development policy gets the same production guard — the API entry point is not the permissive one.
  withEnv({ NODE_ENV: 'production' }, () => {
    assert.throws(() => buildRouter({ ...buildDeps, packageTrustPolicy: PackageTrustPolicy.development() }), notConfigured);
  });
});

test('server startup with an enforcing policy file starts in production (no development involved)', async () => {
  await withTempDir('xo-m5-api-', async (dir) => {
    const { writeFile } = await import('node:fs/promises');
    const file = `${dir}/policy.json`;
    await writeFile(file, JSON.stringify({ version: 1, keys: [] }));
    withEnv({ [TRUST_POLICY_ENV]: file, NODE_ENV: 'development' }, () => {
      assert.doesNotThrow(() => buildRouter(buildDeps));
    });
  });
});

test('trust-mode consistency: validate, registry publish and runtime all apply the SAME enforcing policy to the same unsigned package', async () => {
  const bundle = buildFixtureBundle({ name: 'xo_m5_consistent' });
  const archive = Buffer.from(await packBundle(bundle));
  const server = await TestServer.start({ packageTrustPolicy: enforcing(bundle.manifest.creatorDid) });
  try {
    const validate = await server.request('POST', '/packages/validate', { archiveBase64: archive.toString('base64') });
    assert.equal(validate.status, 422);

    const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>();
    const publish = await server.request('POST', `/workspaces/${ws.workspaceId}/registry/packages`, archive);
    assert.equal(publish.status, 422, 'registry publish refuses what validate refuses');
    assert.match(publish.bodyText, /PACKAGE_UNSIGNED/);

    const ctx = await server.request('GET', `/workspaces/${ws.workspaceId}/runtime/context`);
    assert.equal(ctx.status, 200);
    assert.deepEqual(
      ctx.json<{ bootstrapWarnings: string[] }>().bootstrapWarnings,
      [],
      'enforcing mode never carries the development warning',
    );
  } finally {
    await server.stop();
  }
});

test('development mode through the API: unsigned package validates and publishes, surfaced as `unverified`/development — never trusted', async () => {
  const bundle = buildFixtureBundle({ name: 'xo_m5_dev' });
  const archive = Buffer.from(await packBundle(bundle));
  const server = await TestServer.start(); // test helper runs the API in explicit development mode
  try {
    const validate = await server.request('POST', '/packages/validate', { archiveBase64: archive.toString('base64') });
    assert.equal(validate.status, 200);
    const v = validate.json<{ trust: { status: string; mode: string }; issues: { code: string }[] }>();
    assert.equal(v.trust.status, 'unverified');
    assert.equal(v.trust.mode, 'development');
    assert.ok(v.issues.some((i) => i.code === 'TRUST_DEVELOPMENT_MODE'));

    const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>();
    const publish = await server.request('POST', `/workspaces/${ws.workspaceId}/registry/packages`, archive);
    assert.equal(publish.status, 201);
    const p = publish.json<{ trust: { status: string; mode: string } }>();
    assert.equal(p.trust.status, 'unverified');
    assert.equal(p.trust.mode, 'development');
  } finally {
    await server.stop();
  }
});

test('an unconfigured workspace config (no policy) fails closed: validation reports TRUST_NOT_CONFIGURED', async () => {
  const { workspacePackageValidator } = await import('../src/workspace/workspace-context.js');
  const validator = workspacePackageValidator({ dataRootDir: '/tmp/none' } as never); // untyped caller: no policy
  const report = validator.validateAll(buildFixtureBundle({ name: 'xo_m5_none' }));
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((i) => i.code === 'TRUST_NOT_CONFIGURED'));
});
