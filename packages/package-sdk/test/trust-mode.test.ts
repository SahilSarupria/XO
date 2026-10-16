import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Signer } from '@xo/crypto';
import { ErrorCode } from '@xo/errors';
import { LocalFsBlobStore } from '@xo/storage';
import { PackageSigner } from '../src/signing/package-signer.js';
import { PackageInstaller } from '../src/install/package-installer.js';
import { PackageValidator } from '../src/validation/package-validator.js';
import {
  DEVELOPMENT_TRUST_WARNING,
  PackageTrustPolicy,
  TRUST_MODE_ENV,
  TRUST_POLICY_ENV,
  loadOperatorTrustPolicy,
  parseTrustPolicy,
} from '../src/trust/trust-policy.js';
import { evaluatePackageTrust } from '../src/trust/verify-trust.js';
import type { PackageBundle } from '../src/types.js';
import { buildSampleBundle } from './fixtures.js';

/**
 * P1.0 M5 — default-policy decision: trust is fail-closed. Production/enterprise operations require a configured policy; development
 * compatibility exists only when selected by name and is never reported as trusted.
 */

const ed = new Ed25519Signer();
const CREATOR = 'did:xo:test-creator';

function signedBundle(): { bundle: PackageBundle; publicKey: string } {
  const kp = ed.generateKeyPair();
  const base = buildSampleBundle();
  const entry = new PackageSigner(ed).sign(base.manifest, CREATOR, 'creator', kp.privateKey, kp.publicKey);
  const { publicKeyPem: _omit, ...manifestEntry } = entry;
  return { bundle: { ...base, manifest: { ...base.manifest, signatures: [manifestEntry] } }, publicKey: kp.publicKey };
}

function enforcingPolicy(publicKey: string): PackageTrustPolicy {
  const r = parseTrustPolicy({
    version: 1,
    keys: [{ signerDid: CREATOR, publicKeyPem: publicKey, algorithm: 'ed25519', status: 'active' }],
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'xo-m5-mode-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------- environment resolution (the single resolver every entry point uses) ----------

test('production / default mode: NO policy configured → error XO_PACKAGE_TRUST_NOT_CONFIGURED, never development mode', () => {
  for (const env of [{}, { NODE_ENV: 'production' }, { [TRUST_MODE_ENV]: 'enforce' }, { [TRUST_POLICY_ENV]: '   ' }]) {
    const r = loadOperatorTrustPolicy(env);
    assert.equal(r.ok, false, JSON.stringify(env));
    if (!r.ok) {
      assert.equal(r.error.code, ErrorCode.PACKAGE_TRUST_NOT_CONFIGURED);
      assert.match(r.error.message, /XO_PACKAGE_TRUST_POLICY/);
    }
  }
});

test('missing / unreadable / malformed / invalid policy file → error (never a downgrade), in every NODE_ENV', async () => {
  await withDir(async (dir) => {
    const notJson = join(dir, 'notjson.json');
    await writeFile(notJson, '{oops');
    const invalid = join(dir, 'invalid.json');
    await writeFile(invalid, JSON.stringify({ version: 1, keys: [], surprise: true }));
    const empty = join(dir, 'empty.json');
    await writeFile(empty, '');
    const wrongVersion = join(dir, 'v2.json');
    await writeFile(wrongVersion, JSON.stringify({ version: 2, keys: [] }));
    for (const NODE_ENV of [undefined, 'development', 'test', 'production']) {
      for (const path of [join(dir, 'missing.json'), dir, notJson, invalid, empty, wrongVersion]) {
        const r = loadOperatorTrustPolicy({ [TRUST_POLICY_ENV]: path, ...(NODE_ENV !== undefined ? { NODE_ENV } : {}) });
        assert.equal(r.ok, false, `${NODE_ENV}:${path}`);
        if (!r.ok) assert.equal(r.error.code, ErrorCode.PACKAGE_TRUST_NOT_CONFIGURED);
      }
    }
  });
});

test('a valid policy file → enforce, in any NODE_ENV', async () => {
  await withDir(async (dir) => {
    const { publicKey } = signedBundle();
    const file = join(dir, 'policy.json');
    await writeFile(
      file,
      JSON.stringify({ version: 1, keys: [{ signerDid: CREATOR, publicKeyPem: publicKey, algorithm: 'ed25519', status: 'active' }] }),
    );
    for (const NODE_ENV of [undefined, 'production']) {
      const r = loadOperatorTrustPolicy({ [TRUST_POLICY_ENV]: file, ...(NODE_ENV !== undefined ? { NODE_ENV } : {}) });
      assert.ok(r.ok);
      if (r.ok) assert.equal(r.value.mode, 'enforce');
    }
  });
});

test('explicit development mode: XO_TRUST_MODE=development (no policy file, not production) → development policy', () => {
  for (const env of [
    { [TRUST_MODE_ENV]: 'development' },
    { [TRUST_MODE_ENV]: ' development ' },
    { [TRUST_MODE_ENV]: 'development', NODE_ENV: 'development' },
    { [TRUST_MODE_ENV]: 'development', NODE_ENV: 'test' },
  ]) {
    const r = loadOperatorTrustPolicy(env);
    assert.ok(r.ok, JSON.stringify(env));
    if (r.ok) assert.equal(r.value.mode, 'development');
  }
});

test('development mode can NEVER be enabled in production, however it is spelled', () => {
  for (const NODE_ENV of ['production', 'PRODUCTION', ' production ']) {
    const r = loadOperatorTrustPolicy({ [TRUST_MODE_ENV]: 'development', NODE_ENV });
    assert.equal(r.ok, false, NODE_ENV);
    if (!r.ok) {
      assert.equal(r.error.code, ErrorCode.PACKAGE_TRUST_NOT_CONFIGURED);
      assert.match(r.error.message, /production/);
    }
  }
});

test('development mode combined with a configured policy file is refused as ambiguous (the policy is never silently ignored)', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'policy.json');
    await writeFile(file, JSON.stringify({ version: 1, keys: [] }));
    const r = loadOperatorTrustPolicy({ [TRUST_MODE_ENV]: 'development', [TRUST_POLICY_ENV]: file });
    assert.equal(r.ok, false);
    // ...even when that file is itself broken.
    assert.equal(loadOperatorTrustPolicy({ [TRUST_MODE_ENV]: 'development', [TRUST_POLICY_ENV]: join(dir, 'missing.json') }).ok, false);
  });
});

test('unknown / near-miss trust modes are refused, not guessed (no permissive spelling)', () => {
  for (const mode of ['dev', 'Development', 'DEVELOPMENT', 'true', '1', 'off', 'none', 'unenforced', 'permissive', 'enforced']) {
    const r = loadOperatorTrustPolicy({ [TRUST_MODE_ENV]: mode });
    assert.equal(r.ok, false, mode);
    if (!r.ok) assert.equal(r.error.code, ErrorCode.PACKAGE_TRUST_NOT_CONFIGURED);
  }
});

test('a policy FILE cannot select development mode or disable verification', () => {
  for (const mode of ['development', 'unenforced', 'off', 'enforce ']) {
    const r = parseTrustPolicy({ version: 1, mode, keys: [] });
    assert.equal(r.ok, false, mode);
  }
  assert.equal(parseTrustPolicy({ version: 1, mode: 'enforce', keys: [] }).ok, true);
  // A policy that would not require a signature cannot be built through the data constructor as development either.
  assert.equal(
    PackageTrustPolicy.create({ mode: 'development' as never, requireSignature: false, requiredRoles: [], bindPublisher: false, keys: [] })
      .ok,
    false,
  );
});

// ---------- verdicts ----------

test('development mode: unsigned AND signed packages are admitted as `unverified`, never `trusted`, with the mode surfaced', () => {
  const dev = PackageTrustPolicy.development();
  const unsigned = evaluatePackageTrust(buildSampleBundle().manifest, dev);
  const { bundle } = signedBundle();
  const signed = evaluatePackageTrust(bundle.manifest, dev);
  for (const v of [unsigned, signed]) {
    assert.equal(v.status, 'unverified');
    assert.equal(v.mode, 'development');
    assert.equal(v.acceptable, true);
    assert.deepEqual(v.signers, []);
    assert.notEqual(v.status, 'trusted');
  }
});

test('no policy at all (undefined) → never acceptable: TRUST_NOT_CONFIGURED', () => {
  const v = evaluatePackageTrust(buildSampleBundle().manifest, undefined);
  assert.equal(v.acceptable, false);
  assert.equal(v.status, 'untrusted');
  assert.equal(v.mode, 'unconfigured');
  assert.deepEqual(
    v.failures.map((f) => f.code),
    ['TRUST_NOT_CONFIGURED'],
  );
});

test('enforce mode: unsigned packages are refused; untrusted-key signatures are refused; trusted signatures are `trusted`', () => {
  const { bundle, publicKey } = signedBundle();
  const policy = enforcingPolicy(publicKey);
  const unsigned = evaluatePackageTrust(buildSampleBundle().manifest, policy);
  assert.equal(unsigned.acceptable, false);
  assert.deepEqual(
    unsigned.failures.map((f) => f.code),
    ['PACKAGE_UNSIGNED'],
  );

  const other = signedBundle(); // validly signed, but by a key this policy does not trust
  const untrusted = evaluatePackageTrust(other.bundle.manifest, policy);
  assert.equal(untrusted.acceptable, false);
  assert.equal(untrusted.status, 'untrusted');

  const trusted = evaluatePackageTrust(bundle.manifest, policy);
  assert.equal(trusted.status, 'trusted');
  assert.equal(trusted.mode, 'enforce');
});

// ---------- validator ----------

test('PackageValidator with NO policy fails closed: validateAll invalid with TRUST_NOT_CONFIGURED; evaluateTrust never acceptable', () => {
  const v = new PackageValidator();
  const report = v.validateAll(buildSampleBundle());
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((i) => i.code === 'TRUST_NOT_CONFIGURED' && i.severity === 'error'));
  assert.equal(v.evaluateTrust(buildSampleBundle().manifest).acceptable, false);
});

test('PackageValidator in development mode is valid but always carries a visible TRUST_DEVELOPMENT_MODE warning', () => {
  const v = new PackageValidator({ trustPolicy: PackageTrustPolicy.development() });
  const report = v.validateAll(buildSampleBundle());
  assert.equal(report.valid, true);
  assert.ok(report.issues.some((i) => i.code === 'TRUST_DEVELOPMENT_MODE' && i.severity === 'warning'));
});

test('the legacy resolvePublicKey escape hatch exists only under explicit development mode', () => {
  const { publicKey } = signedBundle();
  const resolver = (): string => publicKey;
  assert.throws(() => new PackageValidator({ resolvePublicKey: resolver }), TypeError); // no policy
  assert.throws(() => new PackageValidator({ trustPolicy: enforcingPolicy(publicKey), resolvePublicKey: resolver }), TypeError);
  assert.doesNotThrow(() => new PackageValidator({ trustPolicy: PackageTrustPolicy.development(), resolvePublicKey: resolver }));
});

// ---------- installer ----------

test('install with NO trust policy is refused with PACKAGE_TRUST_NOT_CONFIGURED and writes NOTHING — also with skipValidation', async () => {
  await withDir(async (dir) => {
    const store = new LocalFsBlobStore(dir);
    const installer = new PackageInstaller(store); // no validator, no policy
    for (const options of [{}, { skipValidation: true }, { force: true, skipValidation: true }]) {
      const r = await installer.install(buildSampleBundle(), options);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error.code, ErrorCode.PACKAGE_TRUST_NOT_CONFIGURED);
    }
    const listed = await store.list('');
    assert.ok(listed.ok && listed.value.length === 0, 'nothing written');
  });
});

test('install in development mode admits an unsigned local package, records it as `unverified`/`development`, never `trusted`', async () => {
  await withDir(async (dir) => {
    const store = new LocalFsBlobStore(dir);
    const installer = new PackageInstaller(store, { validator: new PackageValidator({ trustPolicy: PackageTrustPolicy.development() }) });
    const r = await installer.install(buildSampleBundle());
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.value.trust?.status, 'unverified');
      assert.equal(r.value.trust?.mode, 'development');
      assert.deepEqual(r.value.trust?.signers, []);
    }
    const listed = await installer.listInstalled();
    assert.equal(listed[0]?.trust?.status, 'unverified');
  });
});

test('install under an enforcing policy refuses an unsigned local package (no development fallback), leaving nothing on disk', async () => {
  await withDir(async (dir) => {
    const { publicKey } = signedBundle();
    const store = new LocalFsBlobStore(dir);
    const installer = new PackageInstaller(store, { validator: new PackageValidator({ trustPolicy: enforcingPolicy(publicKey) }) });
    const r = await installer.install(buildSampleBundle(), { skipValidation: true });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, ErrorCode.PACKAGE_UNTRUSTED);
    const listed = await store.list('');
    assert.ok(listed.ok && listed.value.length === 0);
  });
});

test('a package admitted in development mode is refused at mount once an enforcing policy is in force (migration is not silent)', async () => {
  await withDir(async (dir) => {
    const { publicKey } = signedBundle();
    const store = new LocalFsBlobStore(dir);
    const dev = new PackageInstaller(store, { validator: new PackageValidator({ trustPolicy: PackageTrustPolicy.development() }) });
    const bundle = buildSampleBundle();
    assert.ok((await dev.install(bundle)).ok);

    const enforcing = new PackageInstaller(store, { validator: new PackageValidator({ trustPolicy: enforcingPolicy(publicKey) }) });
    const loaded = await enforcing.loadVerified(bundle.manifest.name, bundle.manifest.version);
    assert.ok(loaded.ok);
    if (loaded.ok) {
      assert.equal(loaded.value.report.valid, false);
      assert.ok(loaded.value.report.issues.some((i) => i.code === 'PACKAGE_UNSIGNED'));
    }
    // And with no policy at all, mount-time verification fails closed too.
    const none = await new PackageInstaller(store).loadVerified(bundle.manifest.name, bundle.manifest.version);
    assert.ok(none.ok);
    if (none.ok) assert.ok(none.value.report.issues.some((i) => i.code === 'TRUST_NOT_CONFIGURED'));
  });
});

test('DEVELOPMENT_TRUST_WARNING names the variable and states that nothing is verified or trusted', () => {
  assert.match(DEVELOPMENT_TRUST_WARNING, /XO_TRUST_MODE=development/);
  assert.match(DEVELOPMENT_TRUST_WARNING, /NOT verified/);
  assert.match(DEVELOPMENT_TRUST_WARNING, /no package is reported trusted/);
});
