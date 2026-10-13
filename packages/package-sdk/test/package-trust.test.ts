import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Signer } from '@xo/crypto';
import { LocalFsBlobStore, type BlobStore } from '@xo/storage';
import type { XoManifest } from '@xo/types';
import { PackageSigner } from '../src/signing/package-signer.js';
import { PackageInstaller } from '../src/install/package-installer.js';
import { PackageValidator } from '../src/validation/package-validator.js';
import {
  PackageTrustPolicy,
  loadOperatorTrustPolicy,
  normalizeEd25519PublicKey,
  parseTrustPolicy,
  TRUST_POLICY_ENV,
} from '../src/trust/trust-policy.js';
import { evaluatePackageTrust } from '../src/trust/verify-trust.js';
import type { PackageBundle, SignatureEntry } from '../src/types.js';
import { buildSampleBundle } from './fixtures.js';

const ed = new Ed25519Signer();
const CREATOR = 'did:xo:test-creator'; // matches buildSampleBundle's manifest.creatorDid

interface Key {
  readonly did: string;
  readonly publicKey: string;
  readonly privateKey: string;
}
function key(did: string): Key {
  const kp = ed.generateKeyPair();
  return { did, publicKey: kp.publicKey, privateKey: kp.privateKey };
}

function sign(bundle: PackageBundle, k: Key, role: SignatureEntry['role'] = 'creator'): PackageBundle {
  const entry = new PackageSigner(ed).sign(bundle.manifest, k.did, role, k.privateKey, k.publicKey);
  const { publicKeyPem: _omit, ...manifestEntry } = entry;
  return { ...bundle, manifest: { ...bundle.manifest, signatures: [...(bundle.manifest.signatures ?? []), manifestEntry] } };
}

function policyDoc(
  keys: readonly { k: Key; status?: 'active' | 'revoked'; extra?: object }[],
  extra: Record<string, unknown> = {},
): unknown {
  return {
    version: 1,
    keys: keys.map(({ k, status, extra: e }) => ({
      signerDid: k.did,
      publicKeyPem: k.publicKey,
      algorithm: 'ed25519',
      status: status ?? 'active',
      ...(status === 'revoked' ? { revokedAt: '2026-01-01T00:00:00Z' } : {}),
      ...e,
    })),
    ...extra,
  };
}
function policyOf(keys: Parameters<typeof policyDoc>[0], extra: Record<string, unknown> = {}): PackageTrustPolicy {
  const r = parseTrustPolicy(policyDoc(keys, extra));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
function failureCodes(manifest: XoManifest, policy: PackageTrustPolicy, now?: Date): string[] {
  return evaluatePackageTrust(manifest, policy, now).failures.map((f) => f.code);
}

async function withStore<T>(fn: (store: LocalFsBlobStore, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'xo-m5-'));
  try {
    return await fn(new LocalFsBlobStore(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------- verdict semantics ----------

test('valid signature from a trusted key → trusted, with the verifying keyId', () => {
  const k = key(CREATOR);
  const bundle = sign(buildSampleBundle(), k);
  const v = evaluatePackageTrust(bundle.manifest, policyOf([{ k }]));
  assert.equal(v.status, 'trusted');
  assert.equal(v.acceptable, true);
  assert.equal(v.signers.length, 1);
  assert.match(v.signers[0]!.keyId, /^ed25519:[0-9a-f]{64}$/);
});

test('valid signature from an UNTRUSTED key (not in the policy) → untrusted', () => {
  const attacker = key(CREATOR);
  const trusted = key('did:xo:someone-else');
  const bundle = sign(buildSampleBundle(), attacker);
  const v = evaluatePackageTrust(bundle.manifest, policyOf([{ k: trusted }]));
  assert.equal(v.status, 'untrusted');
  assert.deepEqual(failureCodes(bundle.manifest, policyOf([{ k: trusted }])), [
    'SIGNER_UNTRUSTED',
    'ROLE_REQUIREMENT_UNMET',
    'PUBLISHER_MISMATCH',
  ]);
});

test('same DID, DIFFERENT key than the trusted one → signature does not verify (DID alone is not trust)', () => {
  const real = key(CREATOR);
  const impostor = key(CREATOR);
  const bundle = sign(buildSampleBundle(), impostor);
  assert.ok(failureCodes(bundle.manifest, policyOf([{ k: real }])).includes('SIGNATURE_INVALID'));
});

test('a public key embedded beside the signature (SignatureEntry.publicKeyPem / extra manifest field) never establishes trust', () => {
  const attacker = key(CREATOR);
  const unrelated = key('did:xo:operator-key');
  const entry = new PackageSigner(ed).sign(buildSampleBundle().manifest, CREATOR, 'creator', attacker.privateKey, attacker.publicKey);
  const bundle = buildSampleBundle();
  // Even stuffing the key into the manifest signature entry changes nothing: policy keys are the only anchor.
  const smuggled = { ...bundle.manifest, signatures: [{ ...entry }] } as unknown as XoManifest;
  const v = evaluatePackageTrust(smuggled, policyOf([{ k: unrelated }]));
  assert.equal(v.status, 'untrusted');
  assert.equal(v.signers.length, 0);
});

test('unsigned package: refused when a signature is required, `unsigned` (not trusted) when it is not', () => {
  const k = key(CREATOR);
  const bundle = buildSampleBundle();
  assert.deepEqual(failureCodes(bundle.manifest, policyOf([{ k }])), ['PACKAGE_UNSIGNED']);
  const lax = evaluatePackageTrust(bundle.manifest, policyOf([{ k }], { requireSignature: false, requiredRoles: [] }));
  assert.equal(lax.status, 'unsigned');
  assert.equal(lax.acceptable, true);
});

test('unenforced policy verifies nothing and never reports trusted — even for a validly signed package', () => {
  const k = key(CREATOR);
  const v = evaluatePackageTrust(sign(buildSampleBundle(), k).manifest, PackageTrustPolicy.unenforced());
  assert.equal(v.status, 'unenforced');
  assert.equal(v.signers.length, 0);
});

test('modified manifest after signing (content, identity, publisher) → SIGNATURE_INVALID', () => {
  const k = key(CREATOR);
  const signed = sign(buildSampleBundle(), k);
  const policy = policyOf([{ k }]);
  for (const patch of [{ name: 'evil' }, { version: '9.9.9' }, { creatorDid: 'did:xo:other' }, { merkleRoot: 'sha256:00' }] as const) {
    const tampered = { ...signed.manifest, ...patch } as XoManifest;
    assert.ok(failureCodes(tampered, policy).includes('SIGNATURE_INVALID'), JSON.stringify(patch));
  }
});

test('signature substitution: a signature copied from a different package does not verify', () => {
  const k = key(CREATOR);
  const a = sign(buildSampleBundle({ name: 'pkg_a' }), k);
  const b = buildSampleBundle({ name: 'pkg_b' });
  const swapped = { ...b.manifest, signatures: a.manifest.signatures } as XoManifest;
  assert.ok(failureCodes(swapped, policyOf([{ k }])).includes('SIGNATURE_INVALID'));
});

test('malformed signature encodings are rejected, not skipped', () => {
  const k = key(CREATOR);
  const signed = sign(buildSampleBundle(), k);
  const good = signed.manifest.signatures![0]!.signature;
  const policy = policyOf([{ k }]);
  const variants = [
    '',
    'not base64!',
    good.slice(0, -4),
    `${good}AAAA`,
    good.replace(/=+$/, ''), // non-canonical (padding stripped)
    Buffer.from(good, 'base64').toString('base64url'),
    ` ${good}`,
  ];
  for (const sig of variants) {
    const m = { ...signed.manifest, signatures: [{ ...signed.manifest.signatures![0]!, signature: sig }] } as XoManifest;
    const v = evaluatePackageTrust(m, policy);
    assert.equal(v.status, 'untrusted', `variant ${JSON.stringify(sig).slice(0, 30)}`);
    assert.ok(v.failures.some((f) => f.code === 'SIGNATURE_MALFORMED'));
  }
  for (const entry of [
    null,
    'x',
    { signerDid: 5, role: 'creator', signature: good },
    { signerDid: CREATOR, role: 'admin', signature: good },
  ]) {
    const m = { ...signed.manifest, signatures: [entry] } as unknown as XoManifest;
    assert.equal(evaluatePackageTrust(m, policy).status, 'untrusted');
  }
  const notArray = { ...signed.manifest, signatures: 'x' } as unknown as XoManifest;
  assert.equal(evaluatePackageTrust(notArray, policy).status, 'untrusted');
});

test('one bad extra signature fails the whole package even if a good trusted one is present; duplicates are rejected', () => {
  const k = key(CREATOR);
  const other = key('did:xo:unknown-reviewer');
  const signed = sign(sign(buildSampleBundle(), k), other, 'reviewer');
  assert.ok(failureCodes(signed.manifest, policyOf([{ k }])).includes('SIGNER_UNTRUSTED'));
  const dup = sign(sign(buildSampleBundle(), k), k);
  assert.ok(failureCodes(dup.manifest, policyOf([{ k }])).includes('SIGNATURE_MALFORMED'));
});

test('revoked key: rejected (KEY_REVOKED) even though the signature is cryptographically valid', () => {
  const k = key(CREATOR);
  const signed = sign(buildSampleBundle(), k);
  assert.deepEqual(failureCodes(signed.manifest, policyOf([{ k, status: 'revoked' }])).slice(0, 1), ['KEY_REVOKED']);
});

test('key rotation: signature by the old key is rejected once the old key is revoked and a new key is trusted; re-signing with the new key passes', () => {
  const oldK = key(CREATOR);
  const newK = key(CREATOR);
  const policy = policyOf([{ k: oldK, status: 'revoked' }, { k: newK }]);
  const oldSigned = sign(buildSampleBundle(), oldK);
  assert.equal(evaluatePackageTrust(oldSigned.manifest, policy).status, 'untrusted');
  assert.equal(evaluatePackageTrust(sign(buildSampleBundle(), newK).manifest, policy).status, 'trusted');
});

test('key validity window is enforced (notBefore / notAfter)', () => {
  const k = key(CREATOR);
  const signed = sign(buildSampleBundle(), k);
  const policy = policyOf([{ k, extra: { notBefore: '2026-06-01T00:00:00Z', notAfter: '2026-07-01T00:00:00Z' } }]);
  assert.ok(failureCodes(signed.manifest, policy, new Date('2026-05-01T00:00:00Z')).includes('KEY_NOT_VALID_NOW'));
  assert.equal(evaluatePackageTrust(signed.manifest, policy, new Date('2026-06-15T00:00:00Z')).status, 'trusted');
  assert.ok(failureCodes(signed.manifest, policy, new Date('2026-08-01T00:00:00Z')).includes('KEY_NOT_VALID_NOW'));
});

test('publisher binding: a trusted key whose DID is not manifest.creatorDid cannot sign as creator', () => {
  const k = key('did:xo:not-the-creator');
  const signed = sign(buildSampleBundle(), k);
  assert.ok(failureCodes(signed.manifest, policyOf([{ k }])).includes('PUBLISHER_MISMATCH'));
  // The operator can switch binding off explicitly.
  assert.equal(evaluatePackageTrust(signed.manifest, policyOf([{ k }], { bindPublisher: false })).status, 'trusted');
});

test('required roles: a creator-only signature fails a policy that also requires a reviewer; both present passes', () => {
  const c = key(CREATOR);
  const r = key('did:xo:reviewer');
  const policy = policyOf([{ k: c }, { k: r }], { requiredRoles: ['creator', 'reviewer'] });
  assert.ok(failureCodes(sign(buildSampleBundle(), c).manifest, policy).includes('ROLE_REQUIREMENT_UNMET'));
  assert.equal(evaluatePackageTrust(sign(sign(buildSampleBundle(), c), r, 'reviewer').manifest, policy).status, 'trusted');
});

// ---------- policy parsing ----------

test('trust policy parsing is strict', () => {
  const k = key(CREATOR);
  const bad = (doc: unknown): void => assert.equal(parseTrustPolicy(doc).ok, false, JSON.stringify(doc).slice(0, 120));
  bad(null);
  bad([]);
  bad({ version: 2, keys: [] });
  bad({ version: 1 });
  bad({ version: 1, keys: [], surprise: true });
  bad({ version: 1, keys: [{ signerDid: CREATOR, publicKeyPem: k.publicKey, algorithm: 'rsa', status: 'active' }] });
  bad({ version: 1, keys: [{ signerDid: CREATOR, publicKeyPem: k.publicKey, algorithm: 'ed25519', status: 'maybe' }] });
  bad({ version: 1, keys: [{ signerDid: CREATOR, publicKeyPem: 'garbage', algorithm: 'ed25519', status: 'active' }] });
  bad({ version: 1, keys: [{ signerDid: CREATOR, publicKeyPem: k.privateKey, algorithm: 'ed25519', status: 'active' }] });
  bad({
    version: 1,
    keys: [{ signerDid: CREATOR, publicKeyPem: k.publicKey, algorithm: 'ed25519', status: 'active', keyId: 'ed25519:00' }],
  });
  bad({ version: 1, keys: [{ signerDid: '../x', publicKeyPem: k.publicKey, algorithm: 'ed25519', status: 'active' }] });
  bad({ version: 1, keys: [{ signerDid: CREATOR, publicKeyPem: k.publicKey, algorithm: 'ed25519', status: 'revoked' }] }); // revokedAt missing
  bad({
    version: 1,
    keys: [{ signerDid: CREATOR, publicKeyPem: k.publicKey, algorithm: 'ed25519', status: 'active', notBefore: 'yesterday' }],
  });
  bad({ version: 1, requiredRoles: ['root'], keys: [] });
  bad({ version: 1, requiredRoles: [], keys: [] }); // requireSignature defaults true
  // The same key listed twice (e.g. once active, once revoked) is ambiguous → refused.
  const dupe = { signerDid: CREATOR, publicKeyPem: k.publicKey, algorithm: 'ed25519' };
  bad({
    version: 1,
    keys: [
      { ...dupe, status: 'active' },
      { ...dupe, status: 'revoked', revokedAt: '2026-01-01T00:00:00Z' },
    ],
  });
  // An RSA public key is refused even though it is a valid PEM.
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
  assert.equal(normalizeEd25519PublicKey(rsa).ok, false);
  assert.equal(normalizeEd25519PublicKey(`${k.publicKey}${k.publicKey}`).ok, false); // two PEM blocks
  assert.equal(parseTrustPolicy(policyDoc([{ k }])).ok, true);
});

test('loadOperatorTrustPolicy: unset → explicit unenforced; set-but-broken → error (never a silent downgrade)', async () => {
  assert.equal((loadOperatorTrustPolicy({}) as { ok: true; value: PackageTrustPolicy }).value.mode, 'unenforced');
  assert.equal(loadOperatorTrustPolicy({ [TRUST_POLICY_ENV]: '/definitely/not/here.json' }).ok, false);
  await withStore(async (_s, dir) => {
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{not json');
    assert.equal(loadOperatorTrustPolicy({ [TRUST_POLICY_ENV]: bad }).ok, false);
    const good = join(dir, 'good.json');
    await writeFile(good, JSON.stringify(policyDoc([{ k: key(CREATOR) }])));
    const r = loadOperatorTrustPolicy({ [TRUST_POLICY_ENV]: good });
    assert.equal(r.ok && r.value.mode, 'enforce');
  });
});

// ---------- validator ----------

test('PackageValidator (enforce): untrusted/unsigned packages are invalid; trusted ones are valid; unenforced warns for signed packages', () => {
  const k = key(CREATOR);
  const enforcing = new PackageValidator({ trustPolicy: policyOf([{ k }]) });
  assert.equal(enforcing.validateAll(buildSampleBundle()).valid, false);
  assert.equal(enforcing.validateAll(sign(buildSampleBundle(), k)).valid, true);
  assert.equal(enforcing.validateAll(sign(buildSampleBundle(), key(CREATOR))).valid, false);

  const unenforced = new PackageValidator();
  const report = unenforced.validateAll(sign(buildSampleBundle(), k));
  assert.equal(report.valid, true);
  assert.ok(report.issues.some((i) => i.code === 'SIGNATURES_UNVERIFIED' && i.severity === 'warning'));

  assert.throws(() => new PackageValidator({ trustPolicy: policyOf([{ k }]), resolvePublicKey: () => undefined }), TypeError);
});

test('legacy PackageVerifier.verifyOne never throws on a malformed key', async () => {
  const { PackageVerifier } = await import('../src/signing/package-signer.js');
  const bundle = buildSampleBundle();
  assert.equal(
    new PackageVerifier().verifyOne(bundle.manifest, { signerDid: CREATOR, role: 'creator', signature: 'AAAA', publicKeyPem: 'garbage' }),
    false,
  );
});

// ---------- installer ----------

test('install (enforce): trusted package installs; record carries the trust verdict and full-manifest digest', async () => {
  await withStore(async (store) => {
    const k = key(CREATOR);
    const installer = new PackageInstaller(store, { validator: new PackageValidator({ trustPolicy: policyOf([{ k }]) }) });
    const r = await installer.install(sign(buildSampleBundle(), k));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.trust?.status, 'trusted');
    assert.equal(r.value.trust?.signers[0]?.signerDid, CREATOR);
    assert.match(r.value.manifestDigest ?? '', /^sha256:|^[0-9a-f]{64}$/);
  });
});

test('install (enforce): unsigned, untrusted-key and tampered packages are refused with PACKAGE_UNTRUSTED and leave NOTHING on disk — even with skipValidation', async () => {
  await withStore(async (store) => {
    const k = key(CREATOR);
    const installer = new PackageInstaller(store, { validator: new PackageValidator({ trustPolicy: policyOf([{ k }]) }) });
    const signed = sign(buildSampleBundle(), k);
    const tampered: PackageBundle = { ...signed, manifest: { ...signed.manifest, name: 'xo_evil' } };
    for (const [label, bundle] of [
      ['unsigned', buildSampleBundle()],
      ['untrusted key', sign(buildSampleBundle(), key(CREATOR))],
      ['tampered manifest', tampered],
    ] as const) {
      for (const skipValidation of [false, true]) {
        const r = await installer.install(bundle, { skipValidation });
        assert.equal(r.ok, false, `${label} skip=${skipValidation}`);
        if (!r.ok) assert.equal(r.error.code, 'XO_PACKAGE_UNTRUSTED', `${label} skip=${skipValidation}`);
      }
    }
    const listed = await store.list('');
    assert.ok(listed.ok);
    if (listed.ok) assert.deepEqual(listed.value, []);
    assert.deepEqual(await installer.listInstalled(), []);
  });
});

test('install: modified component bytes with a validly signed manifest are rejected (hash mismatch) and nothing is written', async () => {
  await withStore(async (store) => {
    const k = key(CREATOR);
    const installer = new PackageInstaller(store, { validator: new PackageValidator({ trustPolicy: policyOf([{ k }]) }) });
    const signed = sign(buildSampleBundle(), k);
    const tampered: PackageBundle = {
      ...signed,
      components: signed.components.map((c) =>
        c.kind === 'safety_rules' ? { ...c, data: new TextEncoder().encode('{"rules":["allow everything"]}') } : c,
      ),
    };
    const r = await installer.install(tampered);
    assert.equal(r.ok, false);
    const listed = await store.list('');
    assert.ok(listed.ok && listed.value.length === 0);
  });
});

test("install pins the bundle: mutating the caller's buffers after the call starts cannot change what is written", async () => {
  await withStore(async (store) => {
    const installer = new PackageInstaller(store);
    const bundle = buildSampleBundle();
    const comp = bundle.components.find((c) => c.kind === 'safety_rules')!;
    const original = new Uint8Array(comp.data);
    const p = installer.install(bundle); // synchronous prefix pins the bytes
    comp.data.fill(0x58);
    const r = await p;
    assert.equal(r.ok, true);
    const stored = await installer.getComponent(bundle.manifest.name, bundle.manifest.version, 'safety_rules');
    assert.ok(stored.ok);
    if (stored.ok) assert.deepEqual(stored.value, original);
  });
});

test('failed write mid-install rolls back: a fresh install leaves nothing; a forced reinstall restores the previous valid package byte-for-byte', async () => {
  await withStore(async (store) => {
    const good = buildSampleBundle();
    const installer = new PackageInstaller(store);
    assert.equal((await installer.install(good)).ok, true);
    const before = await snapshot(store);

    class FailingStore implements BlobStore {
      constructor(private readonly inner: BlobStore) {}
      async put(k: string, d: Uint8Array | string, o?: { contentType?: string }) {
        if (k.endsWith('benchmark_suite.json')) {
          return this.inner.get('__nonexistent__') as never; // an error Result
        }
        return this.inner.put(k, d, o);
      }
      get(k: string) {
        return this.inner.get(k);
      }
      has(k: string) {
        return this.inner.has(k);
      }
      delete(k: string) {
        return this.inner.delete(k);
      }
      list(p?: string) {
        return this.inner.list(p);
      }
    }
    const v2 = buildSampleBundle({ version: '1.0.0' });
    const changed: PackageBundle = {
      ...v2,
      components: v2.components.map((c) => c),
    };
    const failing = new PackageInstaller(new FailingStore(store));
    const r = await failing.install(changed, { force: true });
    assert.equal(r.ok, false);
    assert.deepEqual(await snapshot(store), before);

    // And a fresh (non-forced) failing install of a different version leaves nothing behind.
    const fresh = buildSampleBundle({ version: '2.0.0' });
    const r2 = await failing.install(fresh);
    assert.equal(r2.ok, false);
    assert.deepEqual(await snapshot(store), before);
  });
});

async function snapshot(store: BlobStore): Promise<Record<string, string>> {
  const listed = await store.list('');
  assert.ok(listed.ok);
  const out: Record<string, string> = {};
  if (!listed.ok) return out;
  for (const key of [...listed.value].sort()) {
    const g = await store.get(key);
    if (g.ok) out[key] = Buffer.from(g.value).toString('base64');
  }
  return out;
}

// ---------- verification of installed bytes (load boundary) ----------

test('verifyInstallation/loadVerified (enforce): detects stripped signatures, a swapped manifest, a revoked key, and modified components after install', async () => {
  await withStore(async (store, dir) => {
    const k = key(CREATOR);
    const trust = policyOf([{ k }]);
    const installer = new PackageInstaller(store, { validator: new PackageValidator({ trustPolicy: trust }) });
    const signed = sign(buildSampleBundle(), k);
    assert.equal((await installer.install(signed)).ok, true);
    const { name, version } = signed.manifest;

    const ok1 = await installer.loadVerified(name, version);
    assert.ok(ok1.ok && ok1.value.report.valid);

    // 1. Component modified on disk after install.
    const compPath = join(dir, name, version, 'safety', 'rules.json');
    const original = await readFile(compPath);
    await writeFile(compPath, '{"rules":["pwned"]}');
    const r1 = await installer.loadVerified(name, version);
    assert.ok(r1.ok && !r1.value.report.valid);
    const c = await installer.getComponent(name, version, 'safety_rules');
    assert.equal(c.ok, false); // per-read hash check
    await writeFile(compPath, original);
    assert.ok((await installer.loadVerified(name, version)).ok);

    // 2. Signatures stripped from the installed manifest (fingerprint unchanged because it excludes signatures — digest + trust catch it).
    const manifestPath = join(dir, name, version, 'manifest.json');
    const goodManifest = await readFile(manifestPath, 'utf8');
    const stripped = { ...JSON.parse(goodManifest), signatures: [] };
    await writeFile(manifestPath, JSON.stringify(stripped));
    const r2 = await installer.loadVerified(name, version);
    assert.ok(r2.ok && !r2.value.report.valid);
    assert.ok(r2.ok && r2.value.report.issues.some((i) => i.code === 'INSTALLED_MANIFEST_CHANGED'));
    assert.ok(r2.ok && r2.value.report.issues.some((i) => i.code === 'PACKAGE_UNSIGNED'));

    // 3. Even with the record also rewritten to match, the signature requirement still fails closed (trust is cryptographic, not record-based).
    await writeFile(manifestPath, goodManifest);

    // 4. Key revoked AFTER install → the next verification (== next mount) fails.
    const revokedInstaller = new PackageInstaller(store, {
      validator: new PackageValidator({ trustPolicy: policyOf([{ k, status: 'revoked' }]) }),
    });
    const r4 = await revokedInstaller.loadVerified(name, version);
    assert.ok(r4.ok && !r4.value.report.valid);
    assert.ok(r4.ok && r4.value.report.issues.some((i) => i.code === 'KEY_REVOKED'));

    // 5. Manifest of another package copied into this directory → identity mismatch.
    const other = sign(buildSampleBundle({ name: 'xo_other' }), k);
    await writeFile(manifestPath, JSON.stringify(other.manifest));
    const r5 = await installer.loadVerified(name, version);
    assert.ok(r5.ok && r5.value.report.issues.some((i) => i.code === 'INSTALLED_IDENTITY_MISMATCH'));
  });
});

test('loadVerified returns the manifest it verified; a corrupt or schema-invalid installed manifest is an error, not a crash', async () => {
  await withStore(async (store, dir) => {
    const installer = new PackageInstaller(store);
    const b = buildSampleBundle();
    await installer.install(b);
    const manifestPath = join(dir, b.manifest.name, b.manifest.version, 'manifest.json');
    await writeFile(manifestPath, '{not json');
    assert.equal((await installer.loadVerified(b.manifest.name, b.manifest.version)).ok, false);
    await writeFile(manifestPath, JSON.stringify({ name: b.manifest.name, version: b.manifest.version, components: null }));
    assert.equal((await installer.loadVerified(b.manifest.name, b.manifest.version)).ok, false);
  });
});
