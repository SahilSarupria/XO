import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packBundle, PackageSigner, parseTrustPolicy, TRUST_POLICY_ENV, type PackageBundle } from '@xo/package-sdk';
import { installCommand } from '../src/commands/package/install.js';
import { verifyCommand } from '../src/commands/package/verify.js';
import { publishCommand } from '../src/commands/registry/publish.js';
import { withTempDir, buildTestBundle } from './helpers.js';

const pair = generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function signedBundle(): PackageBundle {
  const b = buildTestBundle();
  const e = new PackageSigner().sign(b.manifest, b.manifest.creatorDid, 'creator', privateKey, publicKey);
  return { ...b, manifest: { ...b.manifest, signatures: [{ signerDid: e.signerDid, role: e.role, signature: e.signature }] } };
}
function policy() {
  const r = parseTrustPolicy({
    version: 1,
    keys: [{ signerDid: buildTestBundle().manifest.creatorDid, publicKeyPem: publicKey, algorithm: 'ed25519', status: 'active' }],
  });
  if (!r.ok) throw r.error;
  return r.value;
}

test('xo install (enforce): unsigned package refused with PACKAGE_UNTRUSTED, nothing written; trusted package installs', async () => {
  await withTempDir('xo-m5-cli-', async (dir) => {
    const unsigned = join(dir, 'unsigned.xo');
    const signed = join(dir, 'signed.xo');
    await writeFile(unsigned, await packBundle(buildTestBundle()));
    await writeFile(signed, await packBundle(signedBundle()));
    const storeDir = join(dir, 'store');

    const refused = await installCommand({ archivePath: unsigned, storeDir, trustPolicy: policy() });
    assert.equal(refused.exitCode, 1);
    assert.match(refused.lines.join('\n'), /XO_PACKAGE_UNTRUSTED/);

    const accepted = await installCommand({ archivePath: signed, storeDir, trustPolicy: policy() });
    assert.equal(accepted.exitCode, 0);
  });
});

test('xo verify prints the trust verdict; enforce policy makes an unsigned package INVALID', async () => {
  await withTempDir('xo-m5-cli-', async (dir) => {
    const unsigned = join(dir, 'unsigned.xo');
    const signed = join(dir, 'signed.xo');
    await writeFile(unsigned, await packBundle(buildTestBundle()));
    await writeFile(signed, await packBundle(signedBundle()));
    const bad = await verifyCommand({ archivePath: unsigned, trustPolicy: policy() });
    assert.equal(bad.exitCode, 1);
    assert.match(bad.lines.join('\n'), /TRUST: untrusted/);
    const good = await verifyCommand({ archivePath: signed, trustPolicy: policy() });
    assert.equal(good.exitCode, 0);
    assert.match(good.lines.join('\n'), /TRUST: trusted/);
  });
});

test('xo publish (enforce): untrusted package is not published', async () => {
  await withTempDir('xo-m5-cli-', async (dir) => {
    const unsigned = join(dir, 'unsigned.xo');
    await writeFile(unsigned, await packBundle(buildTestBundle()));
    const r = await publishCommand({ archivePath: unsigned, registryDir: join(dir, 'reg'), trustPolicy: policy() });
    assert.equal(r.exitCode, 1);
  });
});

test('a configured-but-unreadable XO_PACKAGE_TRUST_POLICY makes install fail closed (no silent downgrade)', async () => {
  await withTempDir('xo-m5-cli-', async (dir) => {
    const archivePath = join(dir, 'p.xo');
    await writeFile(archivePath, await packBundle(buildTestBundle()));
    const prev = process.env[TRUST_POLICY_ENV];
    process.env[TRUST_POLICY_ENV] = join(dir, 'missing.json');
    try {
      const r = await installCommand({ archivePath, storeDir: join(dir, 'store') });
      assert.equal(r.exitCode, 1);
      assert.match(r.lines.join('\n'), /XO_PACKAGE_UNTRUSTED/);
    } finally {
      if (prev === undefined) delete process.env[TRUST_POLICY_ENV];
      else process.env[TRUST_POLICY_ENV] = prev;
    }
  });
});
