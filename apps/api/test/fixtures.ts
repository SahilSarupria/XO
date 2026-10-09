import type { CompatibilityDeclaration, XoManifest, XoMetadata } from '@xo/types';
import { ManifestBuilder, type PackageBundle } from '@xo/package-sdk';

/**
 * Local copy of the same construction `packages/registry/test/manifest-fixtures.ts#buildFixtureBundle`
 * uses — that file's own doc comment explains why it isn't imported
 * across a package boundary (test files aren't part of a package's
 * public surface), so `apps/api`'s tests get their own copy rather than
 * a `../../packages/registry/test/...` relative import reaching into
 * another package's private test directory.
 */
const sampleCompatibility: CompatibilityDeclaration = {
  modelFamilies: [{ family: 'claude', minCapability: ['chat', 'tool_use'], consumes: ['knowledge_graph'] }],
  fallbackPolicy: 'degrade_gracefully',
};

const sampleMetadata: XoMetadata = {
  domain: 'test-domain',
  description: 'A fixture XO used only by @xo/api tests.',
  scope: ['unit testing'],
  limitations: ['not a real professional capability'],
};

export function buildFixtureBundle(overrides: { readonly name?: string; readonly version?: string; readonly creatorDid?: string } = {}): PackageBundle {
  const name = overrides.name ?? 'xo_api_test_fixture';
  const version = overrides.version ?? '1.0.0';
  const result = ManifestBuilder.create()
    .setIdentity({ formatVersion: '1.0', name, version, creatorDid: overrides.creatorDid ?? 'did:xo:test-creator' })
    .setCompatibility(sampleCompatibility)
    .setMetadata(sampleMetadata)
    .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: new TextEncoder().encode(JSON.stringify({ rules: [], for: `${name}@${version}` })), required: true })
    .addComponent({ kind: 'benchmark_suite', path: 'evaluation/benchmark_suite.json', data: new TextEncoder().encode('{"categories":[]}'), required: true })
    .build();
  if (!result.ok) throw new Error(`Fixture bundle failed to build: ${result.error.message}`);
  return result.value;
}

export function buildFixtureManifest(overrides: { readonly name?: string; readonly version?: string; readonly creatorDid?: string } = {}): XoManifest {
  return buildFixtureBundle(overrides).manifest;
}
