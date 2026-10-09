import { ManifestBuilder } from '@xo/package-sdk';
const sampleCompatibility = {
    modelFamilies: [{ family: 'claude', minCapability: ['chat', 'tool_use'], consumes: ['knowledge_graph'] }],
    fallbackPolicy: 'degrade_gracefully',
};
const sampleMetadata = {
    domain: 'test-domain',
    description: 'A fixture XO used only by @xo/registry tests.',
    scope: ['unit testing'],
    limitations: ['not a real professional capability'],
};
/**
 * Builds a small, real, `merkleRoot`-bearing `PackageBundle` via
 * `@xo/package-sdk`'s own `ManifestBuilder` — mirroring
 * `package-sdk/test/fixtures.ts`'s `buildSampleBundle` (that file lives
 * under `package-sdk/test/`, so it isn't importable from another
 * package; this is the same construction, kept local to this package's
 * tests). Every registry test that needs "a real, verifiable manifest"
 * goes through this rather than hand-writing a manifest-shaped object
 * literal, so tests exercise the same content-addressing/hashing path
 * production code does.
 */
export function buildFixtureBundle(overrides = {}) {
    const result = ManifestBuilder.create()
        .setIdentity({
        formatVersion: '1.0',
        name: overrides.name ?? 'xo_registry_test_fixture',
        version: overrides.version ?? '1.0.0',
        creatorDid: overrides.creatorDid ?? 'did:xo:test-creator',
    })
        .setCompatibility(sampleCompatibility)
        .setMetadata(sampleMetadata)
        // Component bytes embed the name+version so distinct fixtures get
        // distinct component hashes and therefore distinct merkleRoots —
        // two same-content packages should genuinely collide (that's what
        // content-addressing means), but two *different* fixture packages in
        // the same test must not collide by fixture-construction accident.
        .addComponent({
        kind: 'safety_rules',
        path: 'safety/rules.json',
        data: new TextEncoder().encode(JSON.stringify({ rules: [], for: `${overrides.name ?? 'xo_registry_test_fixture'}@${overrides.version ?? '1.0.0'}` })),
        required: true,
    })
        .addComponent({ kind: 'benchmark_suite', path: 'evaluation/benchmark_suite.json', data: new TextEncoder().encode('{"categories":[]}'), required: true })
        .build();
    if (!result.ok)
        throw new Error(`Fixture bundle failed to build: ${result.error.message}`);
    return result.value;
}
export function buildFixtureManifest(overrides = {}) {
    return buildFixtureBundle(overrides).manifest;
}
//# sourceMappingURL=manifest-fixtures.js.map