import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { LocalFsBlobStore } from '@xo/storage';
import {
  PackageInstaller,
  PackageSigner,
  PackageTrustPolicy,
  PackageValidator,
  parseTrustPolicy,
  type PackageBundle,
  type PackageTrustPolicy,
} from '@xo/package-sdk';
import { PackageLoader } from '../src/loader/package-loader.js';
import { PackageRegistry } from '../src/registry/mounted-package.js';
import { buildContractLawyerBundle } from './fixtures.js';

const pair = generateKeyPairSync('ed25519');
const kp = {
  publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};
const DID = 'did:xo:test-creator';

function policy(status: 'active' | 'revoked' = 'active'): PackageTrustPolicy {
  const r = parseTrustPolicy({
    version: 1,
    keys: [
      {
        signerDid: DID,
        publicKeyPem: kp.publicKey,
        algorithm: 'ed25519',
        status,
        ...(status === 'revoked' ? { revokedAt: '2026-01-01T00:00:00Z' } : {}),
      },
    ],
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
function signed(): PackageBundle {
  const b = buildContractLawyerBundle();
  const e = new PackageSigner().sign(b.manifest, DID, 'creator', kp.privateKey, kp.publicKey);
  return { ...b, manifest: { ...b.manifest, signatures: [{ signerDid: e.signerDid, role: e.role, signature: e.signature }] } };
}
const installerFor = (store: LocalFsBlobStore, p: PackageTrustPolicy): PackageInstaller =>
  new PackageInstaller(store, { validator: new PackageValidator({ trustPolicy: p }) });

async function withDir<T>(fn: (dir: string, store: LocalFsBlobStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'xo-m5-rt-'));
  try {
    return await fn(dir, new LocalFsBlobStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('mount (enforce): a trusted, signed package mounts; the mounted manifest is the verified one', async () => {
  await withDir(async (_d, store) => {
    const b = signed();
    const inst = installerFor(store, policy());
    assert.equal((await inst.install(b)).ok, true);
    const r = await new PackageLoader(inst).mount(b.manifest.name, b.manifest.version, PackageRegistry.empty());
    assert.ok(r.ok);
  });
});

test('mount (enforce): a package placed in the store WITHOUT going through trusted install (unsigned, written by another installer) is refused', async () => {
  await withDir(async (_d, store) => {
    const b = buildContractLawyerBundle();
    assert.equal((await installerFor(store, PackageTrustPolicy.development()).install(b)).ok, true); // admitted earlier under explicit development mode
    const r = await new PackageLoader(installerFor(store, policy())).mount(b.manifest.name, b.manifest.version, PackageRegistry.empty());
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error.message, /unsigned|signature/i);
  });
});

test('mount (enforce): key revoked after install → refused on the next mount', async () => {
  await withDir(async (_d, store) => {
    const b = signed();
    assert.equal((await installerFor(store, policy()).install(b)).ok, true);
    const r = await new PackageLoader(installerFor(store, policy('revoked'))).mount(
      b.manifest.name,
      b.manifest.version,
      PackageRegistry.empty(),
    );
    assert.equal(r.ok, false);
  });
});

test('mount (enforce): signatures stripped, or manifest modified and left signed, after install → refused', async () => {
  await withDir(async (dir, store) => {
    const b = signed();
    const inst = installerFor(store, policy());
    assert.equal((await inst.install(b)).ok, true);
    const path = join(dir, b.manifest.name, b.manifest.version, 'manifest.json');
    const original = await readFile(path, 'utf8');

    await writeFile(path, JSON.stringify({ ...JSON.parse(original), signatures: [] }));
    assert.equal((await new PackageLoader(inst).mount(b.manifest.name, b.manifest.version, PackageRegistry.empty())).ok, false);

    const m = JSON.parse(original);
    m.capabilities = [...(m.capabilities ?? []), { ...m.capabilities[0], id: 'injected_capability' }];
    await writeFile(path, JSON.stringify(m));
    assert.equal((await new PackageLoader(inst).mount(b.manifest.name, b.manifest.version, PackageRegistry.empty())).ok, false);

    await writeFile(path, original);
    assert.equal((await new PackageLoader(inst).mount(b.manifest.name, b.manifest.version, PackageRegistry.empty())).ok, true);
  });
});

test('knowledge/component reads after mount re-verify the bytes (modified after mount → refused)', async () => {
  await withDir(async (dir, store) => {
    const b = signed();
    const inst = installerFor(store, policy());
    await inst.install(b);
    const kind = 'safety_rules' as const;
    assert.ok((await inst.getComponent(b.manifest.name, b.manifest.version, kind)).ok);
    await writeFile(join(dir, b.manifest.name, b.manifest.version, b.manifest.components[kind]!.path), 'tampered');
    assert.equal((await inst.getComponent(b.manifest.name, b.manifest.version, kind)).ok, false);
  });
});

test('mount with NO trust policy configured fails closed (RUNTIME_MOUNT_FAILED, TRUST_NOT_CONFIGURED) even for a package that was installed', async () => {
  await withDir(async (_d, store) => {
    const b = buildContractLawyerBundle();
    assert.equal((await installerFor(store, PackageTrustPolicy.development()).install(b)).ok, true);
    const unconfigured = new PackageInstaller(store); // no validator, no policy
    const r = await new PackageLoader(unconfigured).mount(b.manifest.name, b.manifest.version, PackageRegistry.empty());
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, 'XO_RUNTIME_MOUNT_FAILED');
      assert.match(r.error.message, /no package trust policy is configured/);
    }
  });
});

test('mount in explicit development mode: an unsigned local package mounts, but its install record and verdict say `unverified`, never trusted', async () => {
  await withDir(async (_d, store) => {
    const b = buildContractLawyerBundle();
    const dev = installerFor(store, PackageTrustPolicy.development());
    const installed = await dev.install(b);
    assert.ok(installed.ok);
    if (installed.ok) assert.equal(installed.value.trust?.status, 'unverified');
    const r = await new PackageLoader(dev).mount(b.manifest.name, b.manifest.version, PackageRegistry.empty());
    assert.ok(r.ok);
    const verdict = dev.loadVerified(b.manifest.name, b.manifest.version);
    const loaded = await verdict;
    assert.ok(loaded.ok);
    if (loaded.ok) assert.ok(loaded.value.report.issues.some((i) => i.code === 'TRUST_DEVELOPMENT_MODE'));
  });
});

test('trust-mode consistency: one package store, three policies — development admits, enforce refuses the same unsigned package, unconfigured refuses everything', async () => {
  await withDir(async (_d, store) => {
    const b = buildContractLawyerBundle();
    const dev = installerFor(store, PackageTrustPolicy.development());
    assert.ok((await dev.install(b)).ok);
    const mountWith = async (inst: PackageInstaller): Promise<boolean> =>
      (await new PackageLoader(inst).mount(b.manifest.name, b.manifest.version, PackageRegistry.empty())).ok;
    assert.equal(await mountWith(dev), true);
    assert.equal(await mountWith(installerFor(store, policy())), false);
    assert.equal(await mountWith(new PackageInstaller(store)), false);
  });
});
