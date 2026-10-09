import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManifestBuilder } from '../src/manifest/manifest-builder.js';
import { buildSampleBundle, sampleCompatibility, sampleMetadata } from './fixtures.js';

test('build() fails when required identity fields are missing', () => {
  const result = ManifestBuilder.create().setCompatibility(sampleCompatibility).setMetadata(sampleMetadata).build();
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /missing required field/);
});

test('build() fails with no components', () => {
  const result = ManifestBuilder.create()
    .setIdentity({ formatVersion: '1.0', name: 'x', version: '1.0.0', creatorDid: 'did:xo:a' })
    .setCompatibility(sampleCompatibility)
    .setMetadata(sampleMetadata)
    .build();
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /at least one component/);
});

test('build() rejects an invalid semver version', () => {
  const result = ManifestBuilder.create()
    .setIdentity({ formatVersion: '1.0', name: 'x', version: 'not-a-version', creatorDid: 'did:xo:a' })
    .setCompatibility(sampleCompatibility)
    .setMetadata(sampleMetadata)
    .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: new Uint8Array([1]), required: true })
    .build();
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /valid semantic version/);
});

test('build() produces a manifest whose merkleRoot is derived from component hashes, independent of insertion order', () => {
  const a = ManifestBuilder.create()
    .setIdentity({ formatVersion: '1.0', name: 'x', version: '1.0.0', creatorDid: 'did:xo:a' })
    .setCompatibility(sampleCompatibility)
    .setMetadata(sampleMetadata)
    .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: new Uint8Array([1]), required: true })
    .addComponent({ kind: 'knowledge_graph', path: 'knowledge/graph.json', data: new Uint8Array([2]), required: false })
    .build();
  const b = ManifestBuilder.create()
    .setIdentity({ formatVersion: '1.0', name: 'x', version: '1.0.0', creatorDid: 'did:xo:a' })
    .setCompatibility(sampleCompatibility)
    .setMetadata(sampleMetadata)
    .addComponent({ kind: 'knowledge_graph', path: 'knowledge/graph.json', data: new Uint8Array([2]), required: false })
    .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: new Uint8Array([1]), required: true })
    .build();
  assert.ok(a.ok && b.ok);
  assert.equal(a.value.manifest.merkleRoot, b.value.manifest.merkleRoot);
});

test('addComponent replaces a component of the same kind rather than duplicating it', () => {
  const result = ManifestBuilder.create()
    .setIdentity({ formatVersion: '1.0', name: 'x', version: '1.0.0', creatorDid: 'did:xo:a' })
    .setCompatibility(sampleCompatibility)
    .setMetadata(sampleMetadata)
    .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: new Uint8Array([1]), required: true })
    .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: new Uint8Array([9, 9]), required: true })
    .build();
  assert.ok(result.ok);
  assert.equal(result.value.components.length, 1);
  assert.deepEqual(result.value.components[0]?.data, new Uint8Array([9, 9]));
});

test('build() output is frozen (cannot be mutated after the fact)', () => {
  const bundle = buildSampleBundle();
  assert.throws(() => {
    (bundle as { manifest: unknown }).manifest = {};
  });
});

test('removeComponent drops a previously added component', () => {
  const result = ManifestBuilder.create()
    .setIdentity({ formatVersion: '1.0', name: 'x', version: '1.0.0', creatorDid: 'did:xo:a' })
    .setCompatibility(sampleCompatibility)
    .setMetadata(sampleMetadata)
    .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: new Uint8Array([1]), required: true })
    .addComponent({ kind: 'knowledge_graph', path: 'knowledge/graph.json', data: new Uint8Array([2]), required: false })
    .removeComponent('knowledge_graph')
    .build();
  assert.ok(result.ok);
  assert.equal(result.value.components.length, 1);
  assert.equal(result.value.components[0]?.kind, 'safety_rules');
});

test('a manifest with no setDependencies() call omits the dependencies field entirely (equivalent to zero dependencies, never inferred)', () => {
  const bundle = buildSampleBundle();
  assert.equal(bundle.manifest.dependencies, undefined);
});

test('setDependencies() records the declared dependency set on the built manifest', () => {
  const bundle = buildSampleBundle({
    dependencies: [
      { name: 'xo_core_math', versionRange: '^1.0.0', kind: 'required' },
      { name: 'xo_optional_extras', versionRange: '~2.1.0', kind: 'optional' },
      { name: 'xo_host_provided', versionRange: '>=1.0.0', kind: 'peer' },
    ],
  });
  assert.deepEqual(bundle.manifest.dependencies, [
    { name: 'xo_core_math', versionRange: '^1.0.0', kind: 'required' },
    { name: 'xo_optional_extras', versionRange: '~2.1.0', kind: 'optional' },
    { name: 'xo_host_provided', versionRange: '>=1.0.0', kind: 'peer' },
  ]);
});

test('setDependencies() replaces the entire set on each call rather than accumulating', () => {
  const result = ManifestBuilder.create()
    .setIdentity({ formatVersion: '1.0', name: 'x', version: '1.0.0', creatorDid: 'did:xo:a' })
    .setCompatibility(sampleCompatibility)
    .setMetadata(sampleMetadata)
    .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: new Uint8Array([1]), required: true })
    .setDependencies([{ name: 'xo_a', versionRange: '1.0.0', kind: 'required' }])
    .setDependencies([{ name: 'xo_b', versionRange: '2.0.0', kind: 'required' }])
    .build();
  assert.ok(result.ok);
  assert.deepEqual(result.value.manifest.dependencies, [{ name: 'xo_b', versionRange: '2.0.0', kind: 'required' }]);
});
