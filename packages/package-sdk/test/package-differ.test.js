import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareComponents, compareManifests, comparePackages, generateUpgradePlan } from '../src/diff/package-differ.js';
import { ManifestBuilder } from '../src/manifest/manifest-builder.js';
import { buildSampleBundle, sampleCompatibility, sampleMetadata } from './fixtures.js';
test('compareManifests reports the version bump and identity changes', () => {
    const from = buildSampleBundle({ version: '1.0.0' }).manifest;
    const to = buildSampleBundle({ version: '1.1.0' }).manifest;
    const diff = compareManifests(from, to);
    assert.equal(diff.versionBump, 'minor');
    assert.equal(diff.nameChanged, false);
});
test('compareComponents classifies added, removed, modified, and unchanged components', () => {
    const from = ManifestBuilder.create()
        .setIdentity({ formatVersion: '1.0', name: 'x', version: '1.0.0', creatorDid: 'did:xo:a' })
        .setCompatibility(sampleCompatibility)
        .setMetadata(sampleMetadata)
        .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: new Uint8Array([1]), required: true })
        .addComponent({ kind: 'knowledge_graph', path: 'knowledge/graph.json', data: new Uint8Array([2]), required: false })
        .addComponent({ kind: 'benchmark_suite', path: 'evaluation/benchmark_suite.json', data: new Uint8Array([3]), required: true })
        .build();
    const to = ManifestBuilder.create()
        .setIdentity({ formatVersion: '1.0', name: 'x', version: '1.1.0', creatorDid: 'did:xo:a' })
        .setCompatibility(sampleCompatibility)
        .setMetadata(sampleMetadata)
        .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: new Uint8Array([1]), required: true }) // unchanged
        .addComponent({ kind: 'knowledge_graph', path: 'knowledge/graph.json', data: new Uint8Array([9]), required: false }) // modified
        .addComponent({ kind: 'reasoning_traces', path: 'reasoning/reasoning_traces.jsonl', data: new Uint8Array([4]), required: false }) // added
        .build(); // benchmark_suite: removed
    assert.ok(from.ok && to.ok);
    const diff = compareComponents(from.value.manifest, to.value.manifest);
    const byKind = Object.fromEntries(diff.map((d) => [d.kind, d.change]));
    assert.equal(byKind.safety_rules, 'unchanged');
    assert.equal(byKind.knowledge_graph, 'modified');
    assert.equal(byKind.reasoning_traces, 'added');
    assert.equal(byKind.benchmark_suite, 'removed');
});
test('comparePackages combines manifest and component diffs', () => {
    const from = buildSampleBundle({ version: '1.0.0' });
    const to = buildSampleBundle({ version: '2.0.0' });
    const diff = comparePackages(from, to);
    assert.equal(diff.manifest.versionBump, 'major');
    assert.ok(diff.components.every((c) => c.change === 'unchanged'));
});
test('generateUpgradePlan marks a downgrade as unsafe', () => {
    const from = buildSampleBundle({ version: '2.0.0' });
    const to = buildSampleBundle({ version: '1.0.0' });
    const plan = generateUpgradePlan(from, to);
    assert.equal(plan.safe, false);
    assert.ok(plan.reasons.length > 0);
});
test('generateUpgradePlan marks removing a required component as unsafe', () => {
    const from = buildSampleBundle({ version: '1.0.0' });
    const toBuilder = ManifestBuilder.create()
        .setIdentity({ formatVersion: '1.0', name: from.manifest.name, version: '1.1.0', creatorDid: from.manifest.creatorDid })
        .setCompatibility(sampleCompatibility)
        .setMetadata(sampleMetadata)
        .addComponent({ kind: 'benchmark_suite', path: 'evaluation/benchmark_suite.json', data: new TextEncoder().encode('{}'), required: true });
    const to = toBuilder.build();
    assert.ok(to.ok);
    const plan = generateUpgradePlan(from, to.value);
    assert.equal(plan.safe, false);
    assert.ok(plan.reasons.some((r) => r.includes('safety_rules')));
    assert.ok(plan.steps.some((s) => s.kind === 'remove_component' && s.componentKind === 'safety_rules'));
});
test('generateUpgradePlan is safe for a well-formed additive minor bump', () => {
    const from = buildSampleBundle({ version: '1.0.0' });
    const to = ManifestBuilder.create()
        .setIdentity({ formatVersion: '1.0', name: from.manifest.name, version: '1.1.0', creatorDid: from.manifest.creatorDid })
        .setCompatibility(sampleCompatibility)
        .setMetadata(sampleMetadata)
        .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: new TextEncoder().encode('{"rules":[]}'), required: true })
        .addComponent({ kind: 'benchmark_suite', path: 'evaluation/benchmark_suite.json', data: new TextEncoder().encode('{"categories":[]}'), required: true })
        .addComponent({ kind: 'knowledge_graph', path: 'knowledge/graph.json', data: new TextEncoder().encode('{"nodes":[1]}'), required: false })
        .build();
    assert.ok(to.ok);
    const plan = generateUpgradePlan(from, to.value);
    assert.equal(plan.safe, true);
});
//# sourceMappingURL=package-differ.test.js.map