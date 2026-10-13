import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { packBundle, PackageSigner, parseTrustPolicy, loadOperatorTrustPolicy, TRUST_POLICY_ENV } from '@xo/package-sdk';
import { TestServer } from './test-helpers.js';
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

test('server startup fails closed when XO_PACKAGE_TRUST_POLICY is set but unusable', () => {
  const prev = process.env[TRUST_POLICY_ENV];
  process.env[TRUST_POLICY_ENV] = '/nonexistent/policy.json';
  try {
    assert.equal(loadOperatorTrustPolicy().ok, false);
    assert.throws(() => buildRouter({}));
  } finally {
    if (prev === undefined) delete process.env[TRUST_POLICY_ENV];
    else process.env[TRUST_POLICY_ENV] = prev;
  }
});
