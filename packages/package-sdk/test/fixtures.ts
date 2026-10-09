import type { CapabilityDeclaration, CompatibilityDeclaration, DependencyDeclaration, XoManifest, XoMetadata } from '@xo/types';
import { ManifestBuilder } from '../src/manifest/manifest-builder.js';
import type { PackageBundle } from '../src/types.js';

export const sampleCompatibility: CompatibilityDeclaration = {
  modelFamilies: [
    { family: 'claude', minCapability: ['chat', 'tool_use'], consumes: ['knowledge_graph', 'decision_trees', 'reasoning_traces'] },
    { family: 'generic', minCapability: ['chat'], consumes: ['knowledge_graph'] },
  ],
  fallbackPolicy: 'degrade_gracefully',
};

export const sampleMetadata: XoMetadata = {
  domain: 'test-domain',
  description: 'A fixture XO used only by package-sdk tests.',
  scope: ['unit testing'],
  limitations: ['not a real professional capability'],
};

export const sampleCapability: CapabilityDeclaration = {
  id: 'clause_lookup',
  name: 'Clause Lookup',
  description: 'Identifies and pairs contract clauses by type using the package knowledge graph.',
  providerCompatibility: ['claude', 'generic'],
  requiredComponents: ['knowledge_graph'],
  estimatedCost: { currency: 'USD', amount: 0.002 },
  estimatedLatencyMs: 800,
  confidence: { score: 0.7, basis: 'self_reported' },
};

export function buildSampleBundle(
  overrides: {
    readonly name?: string;
    readonly version?: string;
    readonly capabilities?: readonly CapabilityDeclaration[];
    readonly dependencies?: readonly DependencyDeclaration[];
  } = {},
): PackageBundle {
const result = ManifestBuilder.create()
    .setIdentity({ formatVersion: '1.0', name: overrides.name ?? 'xo_test_fixture', version: overrides.version ?? '1.0.0', creatorDid: 'did:xo:test-creator' })
    .setCompatibility(sampleCompatibility)
    .setMetadata(sampleMetadata)
    .setCapabilities(overrides.capabilities ?? [sampleCapability])
    .setDependencies(overrides.dependencies ?? [])
    .addComponent({ kind: 'knowledge_graph', path: 'knowledge/graph.json', data: new TextEncoder().encode('{"nodes":[]}'), required: false })
    .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: new TextEncoder().encode('{"rules":[]}'), required: true })
    .addComponent({ kind: 'benchmark_suite', path: 'evaluation/benchmark_suite.json', data: new TextEncoder().encode('{"categories":[]}'), required: true })
    .build();
  if (!result.ok) throw new Error(`Fixture bundle failed to build: ${result.error.message}`);
  return result.value;
}

/** Convenience wrapper over {@link buildSampleBundle} for resolver/lockfile tests, which only ever need the manifest, never the full bundle. */
export function buildSampleManifest(overrides: {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: readonly DependencyDeclaration[];
} = {}): XoManifest {
  return buildSampleBundle(overrides).manifest;
}