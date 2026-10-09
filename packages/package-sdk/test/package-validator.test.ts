import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PackageValidator } from '../src/validation/package-validator.js';
import { isXoManifest } from '../src/validation/schema.js';
import { buildSampleBundle } from './fixtures.js';

test('validateAll passes on a freshly-built, unmodified bundle', () => {
  const bundle = buildSampleBundle();
  const report = new PackageValidator().validateAll(bundle);
  assert.equal(report.valid, true);
  assert.deepEqual(
    report.issues.filter((i) => i.severity === 'error'),
    [],
  );
});

test('validateHashes catches a component whose bytes were tampered after hashing', () => {
  const bundle = buildSampleBundle();
  const tampered = { ...bundle, components: bundle.components.map((c) => (c.kind === 'knowledge_graph' ? { ...c, data: new TextEncoder().encode('tampered!') } : c)) };
  const issues = new PackageValidator().validateHashes(tampered);
  assert.ok(issues.some((i) => i.code === 'HASH_MISMATCH'));
});

test('validateMerkleRoot catches a manifest whose merkleRoot does not match its component hashes', () => {
  const bundle = buildSampleBundle();
  const brokenManifest = { ...bundle.manifest, merkleRoot: 'sha256:' + '0'.repeat(64) as typeof bundle.manifest.merkleRoot };
  const issues = new PackageValidator().validateMerkleRoot({ ...bundle, manifest: brokenManifest });
  assert.ok(issues.some((i) => i.code === 'MERKLE_ROOT_MISMATCH'));
});

test('validateRequiredComponents flags a missing required component', () => {
  const bundle = buildSampleBundle();
  const withoutSafetyRules = { ...bundle, components: bundle.components.filter((c) => c.kind !== 'safety_rules') };
  const issues = new PackageValidator().validateRequiredComponents(withoutSafetyRules);
  assert.ok(issues.some((i) => i.code === 'REQUIRED_COMPONENT_MISSING'));
});

test('validateRequiredComponents flags a package missing the marketplace-mandatory components', () => {
  const bundle = buildSampleBundle();
  const { benchmark_suite: _bs, ...rest } = bundle.manifest.components;
  const withoutBenchmark = { ...bundle, manifest: { ...bundle.manifest, components: rest as typeof bundle.manifest.components } };
  const issues = new PackageValidator().validateRequiredComponents(withoutBenchmark);
  assert.ok(issues.some((i) => i.code === 'MANDATORY_COMPONENT_ABSENT'));
});

test('validateNoDuplicatePaths flags two components declaring the same archive path', () => {
  const bundle = buildSampleBundle();
  const manifest = {
    ...bundle.manifest,
    components: { ...bundle.manifest.components, knowledge_graph: { ...bundle.manifest.components.knowledge_graph!, path: bundle.manifest.components.safety_rules!.path } },
  };
  const issues = new PackageValidator().validateNoDuplicatePaths(manifest);
  assert.ok(issues.some((i) => i.code === 'COMPONENT_DUPLICATE_PATH'));
});

test('validateVersion flags an invalid semver string', () => {
  const bundle = buildSampleBundle();
  const manifest = { ...bundle.manifest, version: 'not-a-version' };
  const issues = new PackageValidator().validateVersion(manifest);
  assert.ok(issues.some((i) => i.code === 'VERSION_INVALID'));
});

test('validateSchema rejects a value missing required manifest fields', () => {
  const issues = new PackageValidator().validateSchema({ name: 'incomplete' });
  assert.ok(issues.some((i) => i.code === 'SCHEMA_INVALID_MANIFEST'));
});

test('isXoManifest rejects a manifest with an unknown component kind', () => {
  const bundle = buildSampleBundle();
  const bad = { ...bundle.manifest, components: { ...bundle.manifest.components, not_a_real_kind: bundle.manifest.components.safety_rules } };
  assert.equal(isXoManifest(bad), false);
});

test('validateAll collects multiple issues in one pass rather than stopping at the first', () => {
  const bundle = buildSampleBundle();
  const broken = {
    ...bundle,
    manifest: { ...bundle.manifest, version: 'bad-version', merkleRoot: ('sha256:' + '0'.repeat(64)) as typeof bundle.manifest.merkleRoot },
  };
  const report = new PackageValidator().validateAll(broken);
  assert.equal(report.valid, false);
  const codes = report.issues.map((i) => i.code);
  assert.ok(codes.includes('VERSION_INVALID'));
  assert.ok(codes.includes('MERKLE_ROOT_MISMATCH'));
});

test('isXoManifest accepts a manifest with a well-formed dependencies array', () => {
  const bundle = buildSampleBundle({ dependencies: [{ name: 'xo_core_math', versionRange: '^1.0.0', kind: 'required' }] });
  assert.equal(isXoManifest(bundle.manifest), true);
});

test('isXoManifest rejects a dependency with an unknown kind', () => {
  const bundle = buildSampleBundle();
  const bad = { ...bundle.manifest, dependencies: [{ name: 'xo_core_math', versionRange: '^1.0.0', kind: 'not_a_real_kind' }] };
  assert.equal(isXoManifest(bad), false);
});

test('isXoManifest rejects a dependency missing versionRange', () => {
  const bundle = buildSampleBundle();
  const bad = { ...bundle.manifest, dependencies: [{ name: 'xo_core_math', kind: 'required' }] };
  assert.equal(isXoManifest(bad), false);
});

test('validateDependencies flags a duplicate dependency name', () => {
  const bundle = buildSampleBundle({
   dependencies: [
      { name: 'xo_core_math', versionRange: '^1.0.0', kind: 'required' },
      { name: 'xo_core_math', versionRange: '^2.0.0', kind: 'optional' },
    ],
  });
  const issues = new PackageValidator().validateDependencies(bundle.manifest);
  assert.ok(issues.some((i) => i.code === 'DEPENDENCY_DUPLICATE_NAME'));
});

test('validateDependencies flags a package that declares itself as a dependency', () => {
  const bundle = buildSampleBundle({ name: 'xo_self_referential' });
  const withSelfDep = { ...bundle.manifest, dependencies: [{ name: 'xo_self_referential', versionRange: '^1.0.0', kind: 'required' as const }] };
  const issues = new PackageValidator().validateDependencies(withSelfDep);
  assert.ok(issues.some((i) => i.code === 'DEPENDENCY_SELF_REFERENCE'));
});

test('validateDependencies flags an invalid semver range', () => {
  const bundle = buildSampleBundle({ dependencies: [{ name: 'xo_core_math', versionRange: 'not-a-range', kind: 'required' }] });
  const issues = new PackageValidator().validateDependencies(bundle.manifest);
  assert.ok(issues.some((i) => i.code === 'DEPENDENCY_RANGE_INVALID'));
});

test('validateDependencies passes on a well-formed dependency set', () => {
  const bundle = buildSampleBundle({
    dependencies: [
      { name: 'xo_core_math', versionRange: '^1.0.0', kind: 'required' },
      { name: 'xo_optional_extras', versionRange: '~2.1.0', kind: 'optional' },
    ],
  });
  const issues = new PackageValidator().validateDependencies(bundle.manifest);
  assert.deepEqual(issues, []);
});

test('validateAll includes dependency issues in the full report', () => {
  const bundle = buildSampleBundle({ dependencies: [{ name: 'xo_core_math', versionRange: 'garbage', kind: 'required' }] });
  const report = new PackageValidator().validateAll(bundle);
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((i) => i.code === 'DEPENDENCY_RANGE_INVALID'));
});