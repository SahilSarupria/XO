import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Ed25519Signer } from '@xo/crypto';
import { ManifestBuilder, PackageSigner, parseTrustPolicy, type PackageBundle } from '@xo/package-sdk';
import { BundleIntegrityError, createCapabilityLayer } from '../src/index.js';

const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));
const host = { family: 'claude', capabilities: ['chat', 'tool_use'] } as const;

function sealed(): PackageBundle {
  const r = ManifestBuilder.create()
    .setIdentity({ formatVersion: '1.0', name: 'demo', version: '1.0.0', creatorDid: 'did:xo:creator' })
    .setCompatibility({
      modelFamilies: [{ family: 'claude', minCapability: ['chat'], consumes: ['knowledge_graph', 'safety_rules'] as never }],
      fallbackPolicy: 'degrade_gracefully',
    })
    .setMetadata({ domain: 'd', description: 'd', scope: [], limitations: [] })
    .addComponent({
      kind: 'knowledge_graph',
      path: 'knowledge/graph.json',
      required: false,
      data: enc({ nodes: [{ id: 'k1', kind: 'rule', properties: { text: 'approve nothing above 100' } }] }),
    })
    .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', required: true, data: enc({ rules: [] }) })
    .addComponent({ kind: 'benchmark_suite', path: 'evaluation/benchmark_suite.json', required: true, data: enc({ items: [] }) })
    .build();
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
const rejects = (b: PackageBundle, re: RegExp, opts: Parameters<typeof createCapabilityLayer>[1] = { host }): void =>
  assert.throws(
    () => createCapabilityLayer(b, opts),
    (e: unknown) => e instanceof BundleIntegrityError && re.test(e.message),
  );

describe('a layer refuses a bundle that is not what its manifest says', () => {
  it('loads an intact, sealed bundle', () => {
    assert.ok(createCapabilityLayer(sealed(), { host }));
  });
  it('rejects a component whose bytes were altered after sealing', () => {
    const b = sealed();
    const comps = b.components.map((c) =>
      c.kind === 'knowledge_graph'
        ? { ...c, data: enc({ nodes: [{ id: 'k1', kind: 'rule', properties: { text: 'approve everything' } }] }) }
        : c,
    );
    rejects({ ...b, components: comps }, /knowledge_graph.*declared hash/);
  });
  it('rejects a smuggled component the manifest never declared', () => {
    const b = sealed();
    const extra = { kind: 'decision_trees', path: 'reasoning/decision_trees.json', required: false, data: enc({ trees: [] }) } as never;
    rejects({ ...b, components: [...b.components, extra] }, /decision_trees.*not declared/);
  });
  it('rejects a manifest whose declared hashes were rewritten to match tampered bytes (Merkle root no longer matches)', () => {
    const b = sealed();
    const data = enc({ nodes: [] });
    const hash = 'sha256:' + 'a'.repeat(64);
    const manifest = {
      ...b.manifest,
      components: { ...b.manifest.components, knowledge_graph: { ...b.manifest.components.knowledge_graph!, hash } },
    };
    rejects(
      { manifest, components: b.components.map((c) => (c.kind === 'knowledge_graph' ? { ...c, data } : c)), ancillary: b.ancillary },
      /merkleRoot|declared hash/,
    );
  });
  it('rejects an unsealed manifest (no merkleRoot) by default, but allows it when explicitly opted in', () => {
    const b = sealed();
    const { merkleRoot: _m, ...rest } = b.manifest;
    const unsealed = { ...b, manifest: rest as typeof b.manifest };
    rejects(unsealed, /no merkleRoot/);
    assert.ok(createCapabilityLayer(unsealed, { host, integrity: 'allow-unsealed' }));
  });
  it('allow-unsealed still checks declared hashes', () => {
    const b = sealed();
    const { merkleRoot: _m, ...rest } = b.manifest;
    const comps = b.components.map((c) => (c.kind === 'safety_rules' ? { ...c, data: enc({ rules: [{ id: 'x' }] }) } : c));
    rejects({ manifest: rest as typeof b.manifest, components: comps, ancillary: b.ancillary }, /safety_rules.*declared hash/, {
      host,
      integrity: 'allow-unsealed',
    });
  });
});

describe('signature verification against an operator trust policy', () => {
  const ed = new Ed25519Signer();
  const kp = ed.generateKeyPair();
  const other = ed.generateKeyPair();
  const policy = (publicKeyPem: string) => {
    const r = parseTrustPolicy({
      version: 1,
      keys: [{ signerDid: 'did:xo:creator', publicKeyPem, algorithm: 'ed25519', status: 'active' }],
    });
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  };
  const signWith = (b: PackageBundle, privateKey: string, publicKey: string): PackageBundle => {
    const e = new PackageSigner(ed).sign(b.manifest, 'did:xo:creator', 'creator', privateKey, publicKey);
    const { publicKeyPem: _p, ...entry } = e;
    return { ...b, manifest: { ...b.manifest, signatures: [entry] } };
  };
  it('accepts a package signed by a trusted key', () => {
    const b = signWith(sealed(), kp.privateKey, kp.publicKey);
    assert.ok(createCapabilityLayer(b, { host, trust: policy(kp.publicKey) }));
  });
  it('rejects an unsigned package when a signature is required', () => {
    rejects(sealed(), /trust/, { host, trust: policy(kp.publicKey) });
  });
  it('rejects a package signed by a key the operator does not trust', () => {
    rejects(signWith(sealed(), other.privateKey, other.publicKey), /trust/, { host, trust: policy(kp.publicKey) });
  });
  it('rejects a validly signed package whose manifest was altered afterwards', () => {
    const b = signWith(sealed(), kp.privateKey, kp.publicKey);
    const tampered = { ...b, manifest: { ...b.manifest, version: '9.9.9' } };
    rejects(tampered, /trust/, { host, trust: policy(kp.publicKey) });
  });
});
