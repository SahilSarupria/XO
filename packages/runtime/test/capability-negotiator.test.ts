import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HostProfile } from '@xo/package-sdk';
import { CapabilityNegotiator } from '../src/capability/capability-negotiator.js';
import { buildRuntimeContext } from '../src/runtime-context.js';
import { PackageRegistry, type MountedPackage } from '../src/registry/mounted-package.js';
import { MountId, RequestId, EnvironmentId } from '../src/ids.js';
import type { ExecutionRequest } from '../src/execution/execution-request.js';
import { contractAnalysisCapability, clauseLookupCapability, contractCompatibility, strictCompatibility } from './fixtures.js';
import type { CapabilityDeclaration, CompatibilityDeclaration } from '@xo/types';

function mount(name: string, version: string, compatibility: CompatibilityDeclaration, capabilities: readonly CapabilityDeclaration[]): MountedPackage {
  return Object.freeze({
    mountId: MountId(`${name}@${version}#0`),
    name,
    version,
    manifest: {
      formatVersion: '1.0',
      name,
      version,
      creatorDid: 'did:xo:test',
      compatibility,
      components: { knowledge_graph: { path: 'knowledge/graph.json', hash: 'sha256:' + 'a'.repeat(64), required: false }, decision_trees: { path: 'reasoning/decision_trees.json', hash: 'sha256:' + 'b'.repeat(64), required: false }, safety_rules: { path: 'safety/rules.json', hash: 'sha256:' + 'c'.repeat(64), required: true } },
      capabilities,
    },
    capabilities: capabilities.map((declaration) => ({ declaration, packageName: name, packageVersion: version })),
    mountedAt: '2026-01-01T00:00:00.000Z',
    manifestHash: 'sha256:fake',
  }) as unknown as MountedPackage;
}

function claudeHost(): HostProfile {
  return { family: 'claude', capabilities: ['chat', 'tool_use', 'long_context'] };
}

function request(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    requestId: RequestId('req_1'),
    environment: { environmentId: EnvironmentId('env_1'), hostProfile: claudeHost(), createdAt: '2026-01-01T00:00:00.000Z' },
    requestedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('discoverCandidates() finds by exact capability id', () => {
  const registry = PackageRegistry.empty().withMounted(mount('xo_lawyer', '1.0.0', contractCompatibility, [contractAnalysisCapability]));
  const context = buildRuntimeContext(registry);
  const negotiator = new CapabilityNegotiator();
  const candidates = negotiator.discoverCandidates(request({ capabilityId: 'contract_analysis' }), context);
  assert.equal(candidates.length, 1);
});

test('discoverCandidates() falls back to free-text query search when no capabilityId is given', () => {
  const registry = PackageRegistry.empty().withMounted(mount('xo_lawyer', '1.0.0', contractCompatibility, [contractAnalysisCapability]));
  const context = buildRuntimeContext(registry);
  const negotiator = new CapabilityNegotiator();
  const candidates = negotiator.discoverCandidates(request({ query: 'contract' }), context);
  assert.equal(candidates.length, 1);
});

test('plan() reaches status "no_candidates" when nothing declares the requested capability', () => {
  const context = buildRuntimeContext(PackageRegistry.empty());
  const plan = new CapabilityNegotiator().plan(request({ capabilityId: 'contract_analysis' }), context);
  assert.equal(plan.status, 'no_candidates');
  assert.equal(plan.selected, undefined);
});

test('plan() excludes an L0 candidate whose package declares fallbackPolicy "reject"', () => {
  // strictCompatibility only declares 'claude' with long_context required in fixtures,
  // but here we use a host missing 'tool_use' relative to strictCompatibility's actual requirement to force L0.
  const registry = PackageRegistry.empty().withMounted(mount('xo_strict', '1.0.0', strictCompatibility, [contractAnalysisCapability]));
  const context = buildRuntimeContext(registry);
  const host: HostProfile = { family: 'claude', capabilities: ['chat'] }; // missing tool_use + long_context
  const plan = new CapabilityNegotiator().plan(request({ capabilityId: 'contract_analysis', environment: { environmentId: EnvironmentId('env_1'), hostProfile: host, createdAt: '2026-01-01T00:00:00.000Z' } }), context);
  assert.equal(plan.status, 'no_compatible_candidate');
});

test('plan() keeps an L0 candidate whose package declares fallbackPolicy "degrade_gracefully"', () => {
  const registry = PackageRegistry.empty().withMounted(mount('xo_lawyer', '1.0.0', contractCompatibility, [contractAnalysisCapability]));
  const context = buildRuntimeContext(registry);
  const host: HostProfile = { family: 'gemini', capabilities: [] }; // not declared at all -> L0, but contractCompatibility degrades gracefully
  const plan = new CapabilityNegotiator().plan(request({ capabilityId: 'contract_analysis', environment: { environmentId: EnvironmentId('env_1'), hostProfile: host, createdAt: '2026-01-01T00:00:00.000Z' } }), context);
  assert.equal(plan.status, 'planned');
  assert.equal(plan.selected?.compatibility.reachedLevel, 'L0');
});

test('resolveDuplicates() collapses multiple mounted versions of the same package offering the same capability, keeping only the highest version', () => {
  const registry = PackageRegistry.empty()
    .withMounted(mount('xo_lawyer', '1.0.0', contractCompatibility, [contractAnalysisCapability]))
    .withMounted(mount('xo_lawyer', '2.0.0', contractCompatibility, [contractAnalysisCapability]));
  const context = buildRuntimeContext(registry);
  const plan = new CapabilityNegotiator().plan(request({ capabilityId: 'contract_analysis' }), context);
  assert.equal(plan.candidates.length, 1, 'only one candidate should survive deduplication');
  assert.equal(plan.candidates[0]?.capability.packageVersion, '2.0.0');
});

test('plan() does NOT deduplicate two different packages that happen to declare the same capability id', () => {
  const registry = PackageRegistry.empty()
    .withMounted(mount('xo_lawyer_a', '1.0.0', contractCompatibility, [contractAnalysisCapability]))
    .withMounted(mount('xo_lawyer_b', '1.0.0', contractCompatibility, [contractAnalysisCapability]));
  const context = buildRuntimeContext(registry);
  const plan = new CapabilityNegotiator().plan(request({ capabilityId: 'contract_analysis' }), context);
  assert.equal(plan.candidates.length, 2);
});

test('rank() orders by reached compatibility level first, then confidence, latency, and cost', () => {
  const highConfidence: typeof contractAnalysisCapability = { ...contractAnalysisCapability, confidence: { score: 0.95, basis: 'expert_review' } };
  const lowConfidence: typeof contractAnalysisCapability = { ...contractAnalysisCapability, confidence: { score: 0.4, basis: 'self_reported' } };
  const registry = PackageRegistry.empty()
    .withMounted(mount('xo_low_conf', '1.0.0', contractCompatibility, [lowConfidence]))
    .withMounted(mount('xo_high_conf', '1.0.0', contractCompatibility, [highConfidence]));
  const context = buildRuntimeContext(registry);
  const plan = new CapabilityNegotiator().plan(request({ capabilityId: 'contract_analysis' }), context);

  assert.equal(plan.candidates[0]?.capability.packageName, 'xo_high_conf');
  assert.equal(plan.candidates[0]?.rank, 0);
  assert.equal(plan.candidates[1]?.capability.packageName, 'xo_low_conf');
  assert.equal(plan.candidates[1]?.rank, 1);
});

test('planning is fully deterministic: the same context and request always produce the same plan shape', () => {
  const registry = PackageRegistry.empty()
    .withMounted(mount('xo_lawyer', '1.0.0', contractCompatibility, [contractAnalysisCapability]))
    .withMounted(mount('xo_lawyer_2', '1.0.0', contractCompatibility, [clauseLookupCapability]));
  const context = buildRuntimeContext(registry);
  const negotiator = new CapabilityNegotiator();
  const req = request({ query: 'contract' });

  const first = negotiator.plan(req, context);
  const second = negotiator.plan(req, context);

  assert.deepEqual(
    first.candidates.map((c) => c.capability.packageName),
    second.candidates.map((c) => c.capability.packageName),
  );
  assert.equal(first.status, second.status);
});

test('an ExecutionPlan is frozen (immutable)', () => {
  const registry = PackageRegistry.empty().withMounted(mount('xo_lawyer', '1.0.0', contractCompatibility, [contractAnalysisCapability]));
  const context = buildRuntimeContext(registry);
  const plan = new CapabilityNegotiator().plan(request({ capabilityId: 'contract_analysis' }), context);
  assert.ok(Object.isFrozen(plan));
});
