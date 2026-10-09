import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { XoManifest } from '@xo/types';
import { buildDependencyGraph, type ManifestLookup } from '../src/resolver/dependency-graph.js';
import { solveDependencyGraph } from '../src/resolver/solver.js';
import { resolveDependencies } from '../src/resolver/resolver.js';
import { buildSampleManifest } from './fixtures.js';

/** Builds a `ManifestLookup` from a fixed in-memory registry — every resolver test uses this instead of a real network/registry client, per the resolver's injected-lookup design. */
function lookupFrom(registry: readonly XoManifest[]): ManifestLookup {
  return async (name: string) => registry.filter((m) => m.name === name);
}

test('resolveDependencies: a full multi-level chain (Finance XO -> Accounting Toolkit -> Core Math) resolves every level', async () => {
  const coreMath = buildSampleManifest({ name: 'xo_core_math', version: '1.4.0' });
  const accountingToolkit = buildSampleManifest({
    name: 'xo_accounting_toolkit',
    version: '2.0.0',
    dependencies: [{ name: 'xo_core_math', versionRange: '^1.0.0', kind: 'required' }],
  });
  const financeXo = buildSampleManifest({
    name: 'xo_finance',
    version: '1.0.0',
    dependencies: [{ name: 'xo_accounting_toolkit', versionRange: '^2.0.0', kind: 'required' }],
  });
  const lookup = lookupFrom([coreMath, accountingToolkit]);

  const result = await resolveDependencies(financeXo, lookup);
  assert.ok(result.ok);
  assert.equal(result.value.resolved.length, 2);
  const names = result.value.resolved.map((r) => r.name).sort();
  assert.deepEqual(names, ['xo_accounting_toolkit', 'xo_core_math']);
  const math = result.value.resolved.find((r) => r.name === 'xo_core_math');
  assert.equal(math?.version, '1.4.0');
  const toolkit = result.value.resolved.find((r) => r.name === 'xo_accounting_toolkit');
  assert.equal(toolkit?.version, '2.0.0');
  assert.deepEqual(result.value.skippedOptional, []);
});

test('resolveDependencies: picks the highest available version satisfying the range', async () => {
  const v1 = buildSampleManifest({ name: 'xo_dep', version: '1.0.0' });
  const v2 = buildSampleManifest({ name: 'xo_dep', version: '1.2.0' });
  const v3 = buildSampleManifest({ name: 'xo_dep', version: '2.0.0' }); // outside ^1.x range
  const root = buildSampleManifest({ name: 'xo_root', dependencies: [{ name: 'xo_dep', versionRange: '^1.0.0', kind: 'required' }] });

  const result = await resolveDependencies(root, lookupFrom([v1, v2, v3]));
  assert.ok(result.ok);
  assert.equal(result.value.resolved[0]?.version, '1.2.0');
});

test('buildDependencyGraph / resolveDependencies: a dependency cycle is caught and reported, not infinite-looped', async () => {
  const a = buildSampleManifest({ name: 'xo_a', version: '1.0.0', dependencies: [{ name: 'xo_b', versionRange: '^1.0.0', kind: 'required' }] });
  const b = buildSampleManifest({ name: 'xo_b', version: '1.0.0', dependencies: [{ name: 'xo_a', versionRange: '^1.0.0', kind: 'required' }] });
  const lookup = lookupFrom([a, b]);

  const graphResult = await buildDependencyGraph(a, lookup);
  assert.equal(graphResult.ok, false);
  if (!graphResult.ok) {
    assert.equal(graphResult.error.code, 'XO_PACKAGE_DEPENDENCY_CYCLE');
    assert.match(graphResult.error.message, /xo_a/);
    assert.match(graphResult.error.message, /xo_b/);
  }

  const resolveResult = await resolveDependencies(a, lookup);
  assert.equal(resolveResult.ok, false);
});

test('buildDependencyGraph: a longer cycle (A -> B -> C -> A) is also caught', async () => {
  const a = buildSampleManifest({ name: 'xo_a', version: '1.0.0', dependencies: [{ name: 'xo_b', versionRange: '^1.0.0', kind: 'required' }] });
  const b = buildSampleManifest({ name: 'xo_b', version: '1.0.0', dependencies: [{ name: 'xo_c', versionRange: '^1.0.0', kind: 'required' }] });
  const c = buildSampleManifest({ name: 'xo_c', version: '1.0.0', dependencies: [{ name: 'xo_a', versionRange: '^1.0.0', kind: 'required' }] });
  const result = await buildDependencyGraph(a, lookupFrom([a, b, c]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'XO_PACKAGE_DEPENDENCY_CYCLE');
});

test('a self-dependency is caught as a cycle of length one', async () => {
  const a = buildSampleManifest({ name: 'xo_a', version: '1.0.0', dependencies: [{ name: 'xo_a', versionRange: '^1.0.0', kind: 'required' }] });
  const result = await buildDependencyGraph(a, lookupFrom([a]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'XO_PACKAGE_DEPENDENCY_CYCLE');
});

test('solveDependencyGraph: two requesters with unsatisfiable overlapping ranges produce a specific conflict error naming both', async () => {
  const shared1 = buildSampleManifest({ name: 'xo_shared', version: '1.0.0' });
  const shared2 = buildSampleManifest({ name: 'xo_shared', version: '2.0.0' });
  const left = buildSampleManifest({ name: 'xo_left', version: '1.0.0', dependencies: [{ name: 'xo_shared', versionRange: '^1.0.0', kind: 'required' }] });
  const right = buildSampleManifest({ name: 'xo_right', version: '1.0.0', dependencies: [{ name: 'xo_shared', versionRange: '^2.0.0', kind: 'required' }] });
  const root = buildSampleManifest({
    name: 'xo_root',
    dependencies: [
      { name: 'xo_left', versionRange: '^1.0.0', kind: 'required' },
      { name: 'xo_right', versionRange: '^1.0.0', kind: 'required' },
    ],
  });
  const lookup = lookupFrom([shared1, shared2, left, right]);

  const result = await resolveDependencies(root, lookup);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'XO_PACKAGE_DEPENDENCY_CONFLICT');
    assert.match(result.error.message, /xo_left/);
    assert.match(result.error.message, /xo_right/);
    assert.match(result.error.message, /\^1\.0\.0/);
    assert.match(result.error.message, /\^2\.0\.0/);
  }
});

test('a required dependency that names an unknown package is reported as unresolved, not a conflict', async () => {
  const root = buildSampleManifest({ name: 'xo_root', dependencies: [{ name: 'xo_does_not_exist', versionRange: '^1.0.0', kind: 'required' }] });
  const result = await resolveDependencies(root, lookupFrom([]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'XO_PACKAGE_DEPENDENCY_UNRESOLVED');
});

test('an optional dependency that cannot be resolved does not fail the whole resolve', async () => {
  const root = buildSampleManifest({
    name: 'xo_root',
    dependencies: [{ name: 'xo_missing_optional', versionRange: '^1.0.0', kind: 'optional' }],
  });
  const result = await resolveDependencies(root, lookupFrom([]));
  assert.ok(result.ok);
  assert.equal(result.value.resolved.length, 0);
  assert.equal(result.value.skippedOptional.length, 1);
  assert.equal(result.value.skippedOptional[0]?.name, 'xo_missing_optional');
});

test('an optional dependency that CAN be resolved is included in the resolved set, not skipped', async () => {
  const optionalDep = buildSampleManifest({ name: 'xo_nice_to_have', version: '1.0.0' });
  const root = buildSampleManifest({
    name: 'xo_root',
    dependencies: [{ name: 'xo_nice_to_have', versionRange: '^1.0.0', kind: 'optional' }],
  });
  const result = await resolveDependencies(root, lookupFrom([optionalDep]));
  assert.ok(result.ok);
  assert.equal(result.value.resolved.length, 1);
  assert.equal(result.value.skippedOptional.length, 0);
});

test('a peer dependency satisfied by something already resolved via a required edge succeeds', async () => {
  const peerTarget = buildSampleManifest({ name: 'xo_peer_target', version: '1.5.0' });
  const middle = buildSampleManifest({
    name: 'xo_middle',
    version: '1.0.0',
    dependencies: [{ name: 'xo_peer_target', versionRange: '>=1.0.0', kind: 'peer' }],
  });
  const root = buildSampleManifest({
    name: 'xo_root',
    dependencies: [
      { name: 'xo_middle', versionRange: '^1.0.0', kind: 'required' },
      { name: 'xo_peer_target', versionRange: '^1.0.0', kind: 'required' },
    ],
  });
  const result = await resolveDependencies(root, lookupFrom([peerTarget, middle]));
  assert.ok(result.ok);
  assert.ok(result.value.resolved.some((r) => r.name === 'xo_peer_target'));
});

test('a peer dependency is checked against, not independently resolved from, an existing resolution, and a mismatch is reported', async () => {
  const peerTargetOld = buildSampleManifest({ name: 'xo_peer_target', version: '1.0.0' });
  const middle = buildSampleManifest({
    name: 'xo_middle',
    version: '1.0.0',
    dependencies: [{ name: 'xo_peer_target', versionRange: '^2.0.0', kind: 'peer' }],
  });
  const root = buildSampleManifest({
    name: 'xo_root',
    dependencies: [
      { name: 'xo_middle', versionRange: '^1.0.0', kind: 'required' },
      { name: 'xo_peer_target', versionRange: '^1.0.0', kind: 'required' },
    ],
  });
  const result = await resolveDependencies(root, lookupFrom([peerTargetOld, middle]));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'XO_PACKAGE_DEPENDENCY_CONFLICT');
    assert.match(result.error.message, /peer/i);
  }
});

test('a peer dependency that nothing else resolves is reported as a conflict rather than silently ignored', async () => {
  const middle = buildSampleManifest({
    name: 'xo_middle',
    version: '1.0.0',
    dependencies: [{ name: 'xo_unresolved_peer', versionRange: '^1.0.0', kind: 'peer' }],
  });
  const root = buildSampleManifest({ name: 'xo_root', dependencies: [{ name: 'xo_middle', versionRange: '^1.0.0', kind: 'required' }] });
  const result = await resolveDependencies(root, lookupFrom([middle]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'XO_PACKAGE_DEPENDENCY_CONFLICT');
});

test('a diamond dependency (root -> A, B; A -> shared, B -> shared) resolves the shared package once, at a version satisfying both', async () => {
  const shared = buildSampleManifest({ name: 'xo_shared', version: '1.3.0' });
  const a = buildSampleManifest({ name: 'xo_a', version: '1.0.0', dependencies: [{ name: 'xo_shared', versionRange: '^1.0.0', kind: 'required' }] });
  const b = buildSampleManifest({ name: 'xo_b', version: '1.0.0', dependencies: [{ name: 'xo_shared', versionRange: '>=1.2.0', kind: 'required' }] });
  const root = buildSampleManifest({
    name: 'xo_root',
    dependencies: [
      { name: 'xo_a', versionRange: '^1.0.0', kind: 'required' },
      { name: 'xo_b', versionRange: '^1.0.0', kind: 'required' },
    ],
  });
  const result = await resolveDependencies(root, lookupFrom([shared, a, b]));
  assert.ok(result.ok);
  const sharedResolutions = result.value.resolved.filter((r) => r.name === 'xo_shared');
  assert.equal(sharedResolutions.length, 1);
  assert.equal(sharedResolutions[0]?.version, '1.3.0');
});

test('solveDependencyGraph can be called directly against a pre-built graph (the two-phase seam is real, not just an implementation detail)', async () => {
  const dep = buildSampleManifest({ name: 'xo_dep', version: '1.0.0' });
  const root = buildSampleManifest({ name: 'xo_root', dependencies: [{ name: 'xo_dep', versionRange: '^1.0.0', kind: 'required' }] });
  const graphResult = await buildDependencyGraph(root, lookupFrom([dep]));
  assert.ok(graphResult.ok);
  const solveResult = solveDependencyGraph(graphResult.value);
  assert.ok(solveResult.ok);
  assert.equal(solveResult.value.resolved[0]?.name, 'xo_dep');
});

test('a root manifest with no dependencies resolves to an empty set without calling lookup', async () => {
  const root = buildSampleManifest({ name: 'xo_lonely' });
  let called = false;
  const lookup: ManifestLookup = async () => {
    called = true;
    return [];
  };
  const result = await resolveDependencies(root, lookup);
  assert.ok(result.ok);
  assert.deepEqual(result.value.resolved, []);
  assert.equal(called, false);
});
