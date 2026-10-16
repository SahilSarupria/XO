import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { PackageInstaller, PackageSigner, PackageValidator, parseTrustPolicy } from '@xo/package-sdk';
import { PackageLoader } from '../src/loader/package-loader.js';
import { PackageRegistry } from '../src/registry/mounted-package.js';
import { buildContractLawyerBundle, buildFraudDetectorBundle, withTempInstaller, FixedClock } from './fixtures.js';

test('mount() succeeds for a valid, verified, installed package and exposes its declared capabilities', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const loader = new PackageLoader(installer, { now: () => new Date('2026-01-01T00:00:00.000Z') });

    const result = await loader.mount(bundle.manifest.name, bundle.manifest.version, PackageRegistry.empty());
    assert.ok(result.ok);
    if (!result.ok) return;

    const mounted = result.value.get(bundle.manifest.name, bundle.manifest.version);
    assert.ok(mounted);
    assert.equal(mounted?.capabilities.length, 2);
    assert.deepEqual(mounted?.capabilities.map((c) => c.declaration.id).sort(), ['clause_lookup', 'contract_analysis']);
    assert.equal(mounted?.mountedAt, '2026-01-01T00:00:00.000Z');
  });
});

test('mount() rejects a package whose on-disk component was corrupted after install (hash failure)', async () => {
  await withTempInstaller(async (installer, store) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);

    const safetyRulesPath = bundle.manifest.components.safety_rules!.path;
    await store.put(`${bundle.manifest.name}/${bundle.manifest.version}/${safetyRulesPath}`, 'corrupted-on-disk');

    const loader = new PackageLoader(installer);
    const result = await loader.mount(bundle.manifest.name, bundle.manifest.version, PackageRegistry.empty());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'XO_RUNTIME_MOUNT_FAILED');
  });
});

test('mount() rejects an invalid signature (signature failure) under an enforcing trust policy', async () => {
  await withTempInstaller(async (devInstaller, store) => {
    // The policy trusts `rightKeyPair` for the creator DID; the package is signed with `wrongKeyPair` — a forged signature.
    const policy = parseTrustPolicy({
      version: 1,
      keys: [{ signerDid: 'did:xo:test-creator', publicKeyPem: rightKeyPair.publicKey, algorithm: 'ed25519', status: 'active' }],
    });
    assert.ok(policy.ok);
    if (!policy.ok) return;
    const enforcingInstaller = new PackageInstaller(store, { validator: new PackageValidator({ trustPolicy: policy.value }) });

    const bundle = buildContractLawyerBundle();
    const entry = new PackageSigner().sign(
      bundle.manifest,
      'did:xo:test-creator',
      'creator',
      wrongKeyPair.privateKey,
      wrongKeyPair.publicKey,
    );
    const signedBundle = {
      ...bundle,
      manifest: { ...bundle.manifest, signatures: [{ signerDid: entry.signerDid, role: entry.role, signature: entry.signature }] },
    };

    // The enforcing installer refuses to ADMIT the forged package at all...
    const refused = await enforcingInstaller.install(signedBundle);
    assert.equal(refused.ok, false);

    // ...and even if it got onto disk some other way (admitted earlier under development mode), mount under the enforcing policy refuses it.
    assert.ok((await devInstaller.install(signedBundle)).ok);
    const loader = new PackageLoader(enforcingInstaller);
    const result = await loader.mount(bundle.manifest.name, bundle.manifest.version, PackageRegistry.empty());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'XO_RUNTIME_MOUNT_FAILED');
  });
});

const rightKeyPair = (() => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
})();
const wrongKeyPair = (() => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
})();

test('mount() rejects mounting the same name@version twice (RUNTIME_ALREADY_MOUNTED)', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const loader = new PackageLoader(installer);

    const first = await loader.mount(bundle.manifest.name, bundle.manifest.version, PackageRegistry.empty());
    assert.ok(first.ok);
    if (!first.ok) return;

    const second = await loader.mount(bundle.manifest.name, bundle.manifest.version, first.value);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error.code, 'XO_RUNTIME_ALREADY_MOUNTED');
  });
});

test('mount() supports multiple simultaneously mounted versions of the same package', async () => {
  await withTempInstaller(async (installer) => {
    const v1 = buildContractLawyerBundle({ version: '1.0.0' });
    const v2 = buildContractLawyerBundle({ version: '1.1.0' });
    await installer.install(v1);
    await installer.upgrade(v2); // v1's files remain on disk; only the "active" pointer moves

    const loader = new PackageLoader(installer);
    const afterV1 = await loader.mount(v1.manifest.name, '1.0.0', PackageRegistry.empty());
    assert.ok(afterV1.ok);
    if (!afterV1.ok) return;
    const afterV2 = await loader.mount(v2.manifest.name, '1.1.0', afterV1.value);
    assert.ok(afterV2.ok);
    if (!afterV2.ok) return;

    assert.equal(afterV2.value.versionsOf(v1.manifest.name).length, 2);
    assert.ok(afterV2.value.has(v1.manifest.name, '1.0.0'));
    assert.ok(afterV2.value.has(v1.manifest.name, '1.1.0'));
  });
});

test('unmount() removes a mounted package; unmounting something not mounted fails with RUNTIME_NOT_MOUNTED', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const loader = new PackageLoader(installer);

    const mounted = await loader.mount(bundle.manifest.name, bundle.manifest.version, PackageRegistry.empty());
    assert.ok(mounted.ok);
    if (!mounted.ok) return;

    const unmounted = loader.unmount(bundle.manifest.name, bundle.manifest.version, mounted.value);
    assert.ok(unmounted.ok);
    if (unmounted.ok) assert.equal(unmounted.value.has(bundle.manifest.name, bundle.manifest.version), false);

    const again = loader.unmount(bundle.manifest.name, bundle.manifest.version, PackageRegistry.empty());
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.error.code, 'XO_RUNTIME_NOT_MOUNTED');
  });
});

test('reload() re-verifies and produces a fresh mount with a new mountId', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const clock = new FixedClock();
    const loader = new PackageLoader(installer, { now: () => clock.now() });

    const first = await loader.mount(bundle.manifest.name, bundle.manifest.version, PackageRegistry.empty());
    assert.ok(first.ok);
    if (!first.ok) return;
    const firstMountId = first.value.get(bundle.manifest.name, bundle.manifest.version)?.mountId;

    clock.advance(1000);
    const reloaded = await loader.reload(bundle.manifest.name, bundle.manifest.version, first.value);
    assert.ok(reloaded.ok);
    if (!reloaded.ok) return;
    const secondMountId = reloaded.value.get(bundle.manifest.name, bundle.manifest.version)?.mountId;

    assert.notEqual(firstMountId, secondMountId);
  });
});

test('reload() on a never-mounted package behaves like mount()', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const loader = new PackageLoader(installer);
    const result = await loader.reload(bundle.manifest.name, bundle.manifest.version, PackageRegistry.empty());
    assert.ok(result.ok);
    if (result.ok) assert.ok(result.value.has(bundle.manifest.name, bundle.manifest.version));
  });
});

test('discover() lists every installed version via PackageInstaller.listAllInstalledRecords (integration with Package SDK)', async () => {
  await withTempInstaller(async (installer) => {
    const v1 = buildContractLawyerBundle({ version: '1.0.0' });
    const v2 = buildContractLawyerBundle({ version: '1.1.0' });
    const fraud = buildFraudDetectorBundle();
    await installer.install(v1);
    await installer.upgrade(v2);
    await installer.install(fraud);

    const loader = new PackageLoader(installer);
    const discovered = await loader.discover();
    assert.equal(discovered.length, 3);
  });
});

test('mountAllDiscovered() mounts every installed package and collects failures without aborting the whole pass', async () => {
  await withTempInstaller(async (installer, store) => {
    const good = buildContractLawyerBundle({ name: 'xo_good' });
    const bad = buildContractLawyerBundle({ name: 'xo_bad' });
    await installer.install(good);
    await installer.install(bad);

    // Corrupt "xo_bad" on disk after installing it.
    const badSafetyPath = bad.manifest.components.safety_rules!.path;
    await store.put(`${bad.manifest.name}/${bad.manifest.version}/${badSafetyPath}`, 'corrupted');

    const loader = new PackageLoader(installer);
    const result = await loader.mountAllDiscovered(PackageRegistry.empty());

    assert.ok(result.registry.has('xo_good', good.manifest.version));
    assert.equal(result.registry.has('xo_bad', bad.manifest.version), false);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]?.name, 'xo_bad');
  });
});
