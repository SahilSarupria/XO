import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packBundle, PackageSigner, PackageTrustPolicy, parseTrustPolicy, TRUST_POLICY_ENV, type PackageBundle } from '@xo/package-sdk';
import { installCommand } from '../src/commands/package/install.js';
import { verifyCommand } from '../src/commands/package/verify.js';
import { runCommand } from '../src/commands/runtime/run.js';
import { doctorCommand } from '../src/commands/system/doctor.js';
import { publishCommand } from '../src/commands/registry/publish.js';
import { withTempDir, buildTestBundle, buildDeterministicClaimBundle, withInstalledBundle, withTrustEnv } from './helpers.js';

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
    await withTrustEnv({ [TRUST_POLICY_ENV]: join(dir, 'missing.json') }, async () => {
      const r = await installCommand({ archivePath, storeDir: join(dir, 'store') });
      assert.equal(r.exitCode, 1);
      assert.match(r.lines.join('\n'), /XO_PACKAGE_TRUST_NOT_CONFIGURED/);
    });
  });
});

// ---------- P1.0 M5 default-policy decision: fail-closed trust mode, consistent across every entry point ----------

const runOptions = (storeDir: string) => ({ capabilityId: 'echo', input: 'hi', storeDir, providerLabel: 'anthropic', model: 'm' });
const NOT_CONFIGURED = /XO_PACKAGE_TRUST_NOT_CONFIGURED/;

test('NO trust configuration: install, verify, publish, run and doctor ALL fail closed, and install/publish write nothing', async () => {
  await withTempDir('xo-m5-cli-', async (dir) => {
    const archivePath = join(dir, 'p.xo');
    await writeFile(archivePath, await packBundle(buildTestBundle()));
    const storeDir = join(dir, 'store');
    const registryDir = join(dir, 'reg');
    await withTrustEnv({}, async () => {
      const install = await installCommand({ archivePath, storeDir });
      const verify = await verifyCommand({ archivePath });
      const publish = await publishCommand({ archivePath, registryDir });
      const run = await runCommand(runOptions(storeDir), () => ({ ok: false, error: 'no provider' }));
      for (const r of [install, verify, publish, run]) {
        assert.equal(r.exitCode, 1);
        assert.match(r.lines.join('\n'), NOT_CONFIGURED);
      }
      const doctor = doctorCommand({}).find((c) => c.name === 'package_trust');
      assert.equal(doctor?.ok, false);
      assert.match(doctor?.detail ?? '', NOT_CONFIGURED);
    });
    await assert.rejects(() => import('node:fs/promises').then((fs) => fs.stat(storeDir)), 'install wrote nothing');
    await assert.rejects(() => import('node:fs/promises').then((fs) => fs.stat(registryDir)), 'publish wrote nothing');
  });
});

test('INVALID / unreadable / malformed policy: every entry point fails closed identically', async () => {
  await withTempDir('xo-m5-cli-', async (dir) => {
    const archivePath = join(dir, 'p.xo');
    await writeFile(archivePath, await packBundle(buildTestBundle()));
    const malformed = join(dir, 'malformed.json');
    await writeFile(malformed, '{nope');
    const invalid = join(dir, 'invalid.json');
    await writeFile(invalid, JSON.stringify({ version: 1, keys: [], mode: 'development' })); // a file cannot select development mode
    for (const path of [join(dir, 'missing.json'), malformed, invalid]) {
      await withTrustEnv({ [TRUST_POLICY_ENV]: path }, async () => {
        const results = [
          await installCommand({ archivePath, storeDir: join(dir, 'store') }),
          await verifyCommand({ archivePath }),
          await publishCommand({ archivePath, registryDir: join(dir, 'reg') }),
          await runCommand(runOptions(join(dir, 'store')), () => ({ ok: false, error: 'no provider' })),
        ];
        for (const r of results) {
          assert.equal(r.exitCode, 1, path);
          assert.match(r.lines.join('\n'), NOT_CONFIGURED, path);
        }
      });
    }
  });
});

test('explicit development mode: unsigned local package installs, and every surface says `unverified`/development — never trusted', async () => {
  await withTempDir('xo-m5-cli-', async (dir) => {
    const archivePath = join(dir, 'p.xo');
    await writeFile(archivePath, await packBundle(buildTestBundle()));
    await withTrustEnv({ XO_TRUST_MODE: 'development' }, async () => {
      const install = await installCommand({ archivePath, storeDir: join(dir, 'store') });
      assert.equal(install.exitCode, 0);
      const text = install.lines.join('\n');
      assert.match(text, /PACKAGE TRUST IS DISABLED/);
      assert.match(text, /trust:\s+unverified \[mode=development\]/);
      assert.doesNotMatch(text, /trusted \[/);

      const verify = await verifyCommand({ archivePath });
      assert.equal(verify.exitCode, 0);
      assert.match(verify.lines.join('\n'), /TRUST: unverified \[mode=development\]/);
      assert.match(verify.lines.join('\n'), /PACKAGE TRUST IS DISABLED/);

      const publish = await publishCommand({ archivePath, registryDir: join(dir, 'reg') });
      assert.equal(publish.exitCode, 0);
      assert.match(publish.lines.join('\n'), /trust:\s+unverified \[mode=development\]/);

      const doctor = doctorCommand({ XO_TRUST_MODE: 'development' }).find((c) => c.name === 'package_trust');
      assert.equal(doctor?.ok, true);
      assert.match(doctor?.detail ?? '', /mode=development/);
      assert.match(doctor?.detail ?? '', /PACKAGE TRUST IS DISABLED/);
    });
  });
});

test('explicit development mode: run announces it in text and in the --json warnings array', async () => {
  await withInstalledBundle(buildDeterministicClaimBundle(), async (storeDir) => {
    await withTrustEnv({ XO_TRUST_MODE: 'development' }, async () => {
      const input = JSON.stringify({ claim_amount: 15000 });
      const base = { capabilityId: 'claim_approval', input, storeDir, providerLabel: 'anthropic' };
      const never = () => {
        throw new Error('no provider expected');
      };
      const text = await runCommand(base, never);
      assert.equal(text.exitCode, 0);
      assert.match(text.lines.join('\n'), /PACKAGE TRUST IS DISABLED/);
      const json = await runCommand({ ...base, json: true }, never);
      assert.equal(json.exitCode, 0);
      const parsed = JSON.parse(json.lines[0]!) as { warnings: string[] };
      assert.ok(parsed.warnings.some((w) => /PACKAGE TRUST IS DISABLED/.test(w)));
    });
  });
});

test('development mode is refused in production for every entry point — from the environment AND when injected', async () => {
  await withTempDir('xo-m5-cli-', async (dir) => {
    const archivePath = join(dir, 'p.xo');
    await writeFile(archivePath, await packBundle(buildTestBundle()));
    await withTrustEnv({ XO_TRUST_MODE: 'development', NODE_ENV: 'production' }, async () => {
      for (const r of [
        await installCommand({ archivePath, storeDir: join(dir, 'store') }),
        await verifyCommand({ archivePath }),
        await publishCommand({ archivePath, registryDir: join(dir, 'reg') }),
      ]) {
        assert.equal(r.exitCode, 1);
        assert.match(r.lines.join('\n'), /refused when NODE_ENV=production/);
      }
    });
    await withTrustEnv({ NODE_ENV: 'production' }, async () => {
      const r = await installCommand({ archivePath, storeDir: join(dir, 'store'), trustPolicy: PackageTrustPolicy.development() });
      assert.equal(r.exitCode, 1);
      assert.match(r.lines.join('\n'), /refused when NODE_ENV=production/);
    });
    await assert.rejects(() => import('node:fs/promises').then((fs) => fs.stat(join(dir, 'store'))));
  });
});

test('development mode combined with a policy file is refused (the policy is never silently ignored)', async () => {
  await withTempDir('xo-m5-cli-', async (dir) => {
    const archivePath = join(dir, 'p.xo');
    await writeFile(archivePath, await packBundle(buildTestBundle()));
    const file = join(dir, 'policy.json');
    await writeFile(file, JSON.stringify({ version: 1, keys: [] }));
    await withTrustEnv({ XO_TRUST_MODE: 'development', [TRUST_POLICY_ENV]: file }, async () => {
      const r = await installCommand({ archivePath, storeDir: join(dir, 'store') });
      assert.equal(r.exitCode, 1);
      assert.match(r.lines.join('\n'), /cannot be combined/);
    });
  });
});

test('enforce: unsigned local package is refused with NO development fallback; --pubkey cannot bypass an enforcing policy', async () => {
  await withTempDir('xo-m5-cli-', async (dir) => {
    const archivePath = join(dir, 'unsigned.xo');
    await writeFile(archivePath, await packBundle(buildTestBundle()));
    const keyFile = join(dir, 'k.pem');
    await writeFile(keyFile, publicKey);
    const refused = await installCommand({ archivePath, storeDir: join(dir, 'store'), trustPolicy: policy() });
    assert.equal(refused.exitCode, 1);
    const pub = await verifyCommand({
      archivePath,
      trustPolicy: policy(),
      pubkeySpecs: [`${buildTestBundle().manifest.creatorDid}=${keyFile}`],
    });
    assert.equal(pub.exitCode, 1);
    assert.match(pub.lines.join('\n'), /--pubkey is only available in explicit development mode/);
  });
});

test('enforce: a policy from the environment is honoured by install exactly as an injected one (trusted installs, untrusted refused)', async () => {
  await withTempDir('xo-m5-cli-', async (dir) => {
    const file = join(dir, 'policy.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        keys: [{ signerDid: buildTestBundle().manifest.creatorDid, publicKeyPem: publicKey, algorithm: 'ed25519', status: 'active' }],
      }),
    );
    const signed = join(dir, 'signed.xo');
    const unsigned = join(dir, 'unsigned.xo');
    await writeFile(signed, await packBundle(signedBundle()));
    await writeFile(unsigned, await packBundle(buildTestBundle()));
    await withTrustEnv({ [TRUST_POLICY_ENV]: file, NODE_ENV: 'production' }, async () => {
      assert.equal((await installCommand({ archivePath: signed, storeDir: join(dir, 'store') })).exitCode, 0);
      assert.equal((await installCommand({ archivePath: unsigned, storeDir: join(dir, 'store2') })).exitCode, 1);
      const verify = await verifyCommand({ archivePath: signed });
      assert.match(verify.lines.join('\n'), /TRUST: trusted \[mode=enforce\]/);
      assert.equal(doctorCommand({ [TRUST_POLICY_ENV]: file, NODE_ENV: 'production' }).find((c) => c.name === 'package_trust')?.ok, true);
    });
  });
});
