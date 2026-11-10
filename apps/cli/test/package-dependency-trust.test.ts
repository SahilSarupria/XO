import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packBundle, PackageSigner, parseTrustPolicy, type PackageBundle } from '@xo/package-sdk';
import { installCommand } from '../src/commands/package/install.js';
import { withTempDir, buildTestBundle, withTrustEnv } from './helpers.js';
const pair = generateKeyPairSync('ed25519');
const pub = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const priv = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const signed = (o: object): PackageBundle => {
  const b = buildTestBundle(o);
  const e = new PackageSigner().sign(b.manifest, b.manifest.creatorDid, 'creator', priv, pub);
  return { ...b, manifest: { ...b.manifest, signatures: [{ signerDid: e.signerDid, role: e.role, signature: e.signature }] } };
};
test('enforce: a signed root is refused when a resolved dependency was admitted without verification; once the dependency is installed under the policy, it installs', async () => {
  await withTempDir('probe-', async (dir) => {
    const store = join(dir, 'store');
    const dep = join(dir, 'dep.xo');
    await writeFile(dep, await packBundle(buildTestBundle({ name: 'xo_core_math', version: '1.0.0' }))); // UNSIGNED
    const r1 = await withTrustEnv({ XO_TRUST_MODE: 'development' }, () => installCommand({ archivePath: dep, storeDir: store })); // default policy: env => fails closed unless dev mode
    const root = join(dir, 'root.xo');
    await writeFile(
      root,
      await packBundle(signed({ name: 'xo_cli_root', dependencies: [{ name: 'xo_core_math', versionRange: '^1.0.0', kind: 'required' }] })),
    );
    const pol = parseTrustPolicy({
      version: 1,
      keys: [{ signerDid: 'did:xo:cli-test', publicKeyPem: pub, algorithm: 'ed25519', status: 'active' }],
    });
    if (!pol.ok) throw pol.error;
    const r2 = await installCommand({ archivePath: root, storeDir: store, trustPolicy: pol.value });
    assert.equal(r2.exitCode, 1);
    assert.match(r2.lines.join('\n'), /PACKAGE_DEPENDENCY_UNTRUSTED.*xo_core_math@1\.0\.0/);
    assert.match(r2.lines.join('\n'), /Nothing was installed/);
    const signedDep = join(dir, 'dep-signed.xo');
    await writeFile(signedDep, await packBundle(signed({ name: 'xo_core_math', version: '1.0.1' })));
    assert.equal((await installCommand({ archivePath: signedDep, storeDir: store, trustPolicy: pol.value })).exitCode, 0);
    const r3 = await installCommand({ archivePath: root, storeDir: store, trustPolicy: pol.value });
    assert.equal(r3.exitCode, 0, r3.lines.join('\n'));
    assert.equal(r1.exitCode, 0);
  });
});

test('xo list shows how each package was admitted and exits 1 while any was not admitted as trusted', async () => {
  await withTempDir('list-', async (dir) => {
    const store = join(dir, 'store');
    const a = join(dir, 'a.xo');
    await writeFile(a, await packBundle(buildTestBundle({ name: 'xo_dev_pkg' })));
    await withTrustEnv({ XO_TRUST_MODE: 'development' }, () => installCommand({ archivePath: a, storeDir: store }));
    const pol = parseTrustPolicy({
      version: 1,
      keys: [{ signerDid: 'did:xo:cli-test', publicKeyPem: pub, algorithm: 'ed25519', status: 'active' }],
    });
    if (!pol.ok) throw pol.error;
    const b = join(dir, 'b.xo');
    await writeFile(b, await packBundle(signed({ name: 'xo_signed_pkg' })));
    assert.equal((await installCommand({ archivePath: b, storeDir: store, trustPolicy: pol.value })).exitCode, 0);
    const { listCommand } = await import('../src/commands/package/list.js');
    const r = await listCommand({ storeDir: store });
    assert.equal(r.exitCode, 1);
    const text = r.lines.join('\n');
    assert.match(text, /2 package\(s\) installed.*1 not admitted as trusted/);
    assert.match(text, /xo_dev_pkg@1\.0\.0\s+unverified \[mode=development\]\s+<-- NOT trusted/);
    assert.match(text, /xo_signed_pkg@1\.0\.0\s+trusted \[mode=enforce\]/);
    assert.doesNotMatch(text, /xo_signed_pkg.*NOT trusted/);
    const j = JSON.parse((await listCommand({ storeDir: store, json: true })).lines.join('')) as { notAdmittedAsTrusted: number };
    assert.equal(j.notAdmittedAsTrusted, 1);
    assert.equal((await listCommand({ storeDir: join(dir, 'empty') })).exitCode, 0);
  });
});
