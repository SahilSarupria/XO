import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId } from '@xo/xoir';
import { PackageValidator } from '@xo/package-sdk';
import { StructuredComparisonBindingResolver } from '@xo/capability-contract';
import { packageXoirGraph } from '../../src/pipeline/packager.js';

const now = () => '2026-01-01T00:00:00.000Z';

function metadata() {
  return {
    domain: 'test.fixture',
    description: 'A packager unit test fixture.',
    scope: ['unit test'],
    limitations: ['not a real document'],
  };
}

function buildGraph(): XoirGraph {
  const graph = XoirGraph.create(XoirGraphId('g1'));
  graph.createAndAddNode({
    id: 'concept:a' as never,
    kind: 'concept',
    properties: { definition: 'A test concept.' },
    confidence: 0.8,
    now,
  });
  graph.createAndAddNode({
    id: 'constraint:a' as never,
    kind: 'constraint',
    properties: { rule: 'Must not do X.', severity: 'blocking' },
    confidence: 0.9,
    now,
  });
  return graph;
}

test('packageXoirGraph produces a manifest that PackageValidator accepts (structure/hash/merkle-root)', () => {
  const graph = buildGraph();
  const result = packageXoirGraph(graph, {
    identity: { name: 'xo_test_pkg', version: '0.1.0', creatorDid: 'did:xo:test' },
    metadata: metadata(),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  const validator = new PackageValidator();
  const report = validator.validateAll({ manifest: result.value.manifest, components: result.value.bundle.components, ancillary: result.value.bundle.ancillary });
  assert.deepEqual(report.issues.filter((i) => i.severity === 'error'), []);
});

test('safety_rules and benchmark_suite are always present (required components), even when a graph has neither constraints nor evaluation artifacts', () => {
  const empty = XoirGraph.create(XoirGraphId('empty'));
  const result = packageXoirGraph(empty, {
    identity: { name: 'xo_empty', version: '0.1.0', creatorDid: 'did:xo:test' },
    metadata: metadata(),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  assert.ok('safety_rules' in result.value.manifest.components);
  assert.ok('benchmark_suite' in result.value.manifest.components);
  assert.equal(result.value.manifest.components.safety_rules.required, true);
  assert.equal(result.value.manifest.components.benchmark_suite.required, true);
});

test('optional components with no backing XOIR content are omitted from the manifest entirely, not shipped empty', () => {
  const empty = XoirGraph.create(XoirGraphId('empty'));
  const result = packageXoirGraph(empty, {
    identity: { name: 'xo_empty', version: '0.1.0', creatorDid: 'did:xo:test' },
    metadata: metadata(),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  assert.equal('knowledge_graph' in result.value.manifest.components, false);
  assert.equal('decision_trees' in result.value.manifest.components, false);
  assert.equal('case_library' in result.value.manifest.components, false);
});

test('prompt_strategies, lora, and finetune are never included — no producer exists for any of them', () => {
  const graph = buildGraph();
  const result = packageXoirGraph(graph, {
    identity: { name: 'xo_test_pkg', version: '0.1.0', creatorDid: 'did:xo:test' },
    metadata: metadata(),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  assert.equal('prompt_strategies' in result.value.manifest.components, false);
  assert.equal('lora' in result.value.manifest.components, false);
  assert.equal('finetune' in result.value.manifest.components, false);

  const summaries = result.value.components.filter((c) => ['prompt_strategies', 'lora', 'finetune'].includes(c.kind));
  assert.equal(summaries.length, 3);
  for (const s of summaries) assert.equal(s.included, false);
});

// ---------------------------------------------------------------------------
// Capability lowering: XOIR capability node -> SemanticCapabilityContract ->
// resolved BindingOutcome -> manifest.capabilities[]. See
// src/pipeline/capability-lowering.ts.
// ---------------------------------------------------------------------------

/** A capability + one linked `decision_node` whose condition parses under `StructuredComparisonBindingResolver`'s closed grammar — resolves to `'resolved'`. */
function addResolvableCapability(graph: XoirGraph, suffix: string): { readonly capabilityId: string; readonly decisionId: string } {
  const capabilityId = `capability:draft-response-${suffix}`;
  const decisionId = `decision:deny-large-claim-${suffix}`;
  graph.createAndAddNode({
    id: XoirNodeId(capabilityId),
    kind: 'capability',
    properties: { name: 'Evaluate Claim', description: 'Evaluates a submitted claim against policy rules.', determinism: 'deterministic' },
    confidence: 0.7,
    now,
  });
  graph.createAndAddNode({
    id: XoirNodeId(decisionId),
    kind: 'decision_node',
    properties: { question: 'the claimed loss amount exceeds 10000', outcome: 'deny the claim' },
    confidence: 0.9,
    now,
  });
  graph.createAndAddEdge({ id: XoirEdgeId(`req-${suffix}`), kind: 'REQUIRES', fromId: XoirNodeId(decisionId), toId: XoirNodeId(capabilityId), now });
  return { capabilityId, decisionId };
}

/** A bare capability node with no linked rule structure at all — `StructuredComparisonBindingResolver` reports `'unresolved'` ("nothing for a deterministic evaluator to check"). */
function addUnresolvedCapability(graph: XoirGraph, suffix: string): string {
  const capabilityId = `capability:bare-${suffix}`;
  graph.createAndAddNode({
    id: XoirNodeId(capabilityId),
    kind: 'capability',
    properties: { name: 'Bare Capability', description: 'No linked rules exist for this capability.' },
    confidence: 0.6,
    now,
  });
  return capabilityId;
}

/** A capability explicitly marked `non_deterministic` — the resolver treats this as `'denied'`, never silently overridden into a deterministic evaluator. */
function addDeniedCapability(graph: XoirGraph, suffix: string): { readonly capabilityId: string; readonly decisionId: string } {
  const capabilityId = `capability:non-deterministic-${suffix}`;
  const decisionId = `decision:non-deterministic-${suffix}`;
  graph.createAndAddNode({
    id: XoirNodeId(capabilityId),
    kind: 'capability',
    properties: { name: 'Draft Freeform Reply', description: 'Drafts a freeform reply — inherently non-deterministic.', determinism: 'non_deterministic' },
    confidence: 0.7,
    now,
  });
  graph.createAndAddNode({
    id: XoirNodeId(decisionId),
    kind: 'decision_node',
    properties: { question: 'the claimed loss amount exceeds 10000', outcome: 'draft a reply' },
    confidence: 0.9,
    now,
  });
  graph.createAndAddEdge({ id: XoirEdgeId(`req-nd-${suffix}`), kind: 'REQUIRES', fromId: XoirNodeId(decisionId), toId: XoirNodeId(capabilityId), now });
  return { capabilityId, decisionId };
}

test('a resolved capability is lowered into manifest.capabilities with its important fields intact', () => {
  const graph = buildGraph();
  const { capabilityId } = addResolvableCapability(graph, 'a');
  const result = packageXoirGraph(graph, {
    identity: { name: 'xo_test_pkg', version: '0.1.0', creatorDid: 'did:xo:test' },
    metadata: metadata(),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  assert.ok(result.value.manifest.capabilities);
  assert.equal(result.value.manifest.capabilities!.length, 1);
  const declaration = result.value.manifest.capabilities![0]!;
  assert.equal(declaration.id, capabilityId);
  assert.equal(declaration.name, 'Evaluate Claim');
  assert.equal(declaration.description, 'Evaluates a submitted claim against policy rules.');
  assert.deepEqual(declaration.requiredComponents, ['knowledge_graph']);
  assert.equal(declaration.confidence.score, 0.7);
  assert.equal(declaration.confidence.basis, 'self_reported');
  assert.ok(declaration.providerCompatibility.length > 0);

  assert.equal(result.value.capabilities.discoveredCount, 1);
  assert.equal(result.value.capabilities.resolvedCount, 1);

  // ...and the data is still not lost — it's also in knowledge_graph.json as typed XOIR data (semantic discovery is preserved, not deleted, once lowered).
  const kgComponent = result.value.bundle.components.find((c) => c.kind === 'knowledge_graph');
  assert.ok(kgComponent);
  const parsed = JSON.parse(new TextDecoder().decode(kgComponent!.data));
  assert.ok(parsed.nodes.some((n: { id: string; kind: string }) => n.id === capabilityId && n.kind === 'capability'));
});

test('an unresolved capability stays discovered in XOIR but is not added to manifest.capabilities', () => {
  const graph = buildGraph();
  const capabilityId = addUnresolvedCapability(graph, 'a');
  const result = packageXoirGraph(graph, {
    identity: { name: 'xo_test_pkg', version: '0.1.0', creatorDid: 'did:xo:test' },
    metadata: metadata(),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  assert.equal(result.value.manifest.capabilities, undefined);
  assert.equal(result.value.capabilities.discoveredCount, 1);
  assert.equal(result.value.capabilities.resolvedCount, 0);
  const outcome = result.value.capabilities.outcomes.find((o) => o.contractId === capabilityId);
  assert.ok(outcome);
  assert.equal(outcome!.status, 'unresolved');
  assert.equal(outcome!.declaration, undefined);

  const kgComponent = result.value.bundle.components.find((c) => c.kind === 'knowledge_graph');
  const parsed = JSON.parse(new TextDecoder().decode(kgComponent!.data));
  assert.ok(parsed.nodes.some((n: { id: string; kind: string }) => n.id === capabilityId && n.kind === 'capability'));
});

test('a denied capability (explicitly non_deterministic) stays discovered but is not executable', () => {
  const graph = buildGraph();
  const { capabilityId } = addDeniedCapability(graph, 'a');
  const result = packageXoirGraph(graph, {
    identity: { name: 'xo_test_pkg', version: '0.1.0', creatorDid: 'did:xo:test' },
    metadata: metadata(),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  assert.equal(result.value.manifest.capabilities, undefined);
  const outcome = result.value.capabilities.outcomes.find((o) => o.contractId === capabilityId);
  assert.ok(outcome);
  assert.equal(outcome!.status, 'denied');
});

test('an ambiguous binding (multiple resolvers agreeing) is not promoted to manifest.capabilities', () => {
  const graph = buildGraph();
  const { capabilityId } = addResolvableCapability(graph, 'amb');
  // A second resolver that always claims the same contract, to force `resolveCapabilityBinding`'s own "N resolvers -> ambiguous" outcome — exercising this module's promotion rule, not inventing a new ambiguity concept.
  const secondResolver = {
    name: 'always-agrees',
    resolve: (contract: { readonly id: string }) => ({
      status: 'resolved' as const,
      binding: { id: `binding_${contract.id}_second`, contractId: contract.id, implementationClass: 'deterministic_rule' as const, resolverName: 'always-agrees', description: 'test double', derivation: {} },
    }),
  };
  const result = packageXoirGraph(graph, {
    identity: { name: 'xo_test_pkg', version: '0.1.0', creatorDid: 'did:xo:test' },
    metadata: metadata(),
    capabilityLowering: { resolvers: [new StructuredComparisonBindingResolver(), secondResolver] },
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  assert.equal(result.value.manifest.capabilities, undefined);
  const outcome = result.value.capabilities.outcomes.find((o) => o.contractId === capabilityId);
  assert.ok(outcome);
  assert.equal(outcome!.status, 'ambiguous');
});

test('only eligible capabilities are lowered when multiple are discovered (resolved + unresolved + denied)', () => {
  const graph = buildGraph();
  addResolvableCapability(graph, 'a');
  addResolvableCapability(graph, 'b');
  addResolvableCapability(graph, 'c');
  addUnresolvedCapability(graph, 'a');
  addUnresolvedCapability(graph, 'b');
  addDeniedCapability(graph, 'a');
  addDeniedCapability(graph, 'b');
  addDeniedCapability(graph, 'c');

  const result = packageXoirGraph(graph, {
    identity: { name: 'xo_test_pkg', version: '0.1.0', creatorDid: 'did:xo:test' },
    metadata: metadata(),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  assert.equal(result.value.capabilities.discoveredCount, 8);
  assert.equal(result.value.capabilities.resolvedCount, 3);
  assert.equal(result.value.manifest.capabilities!.length, 3);
});

test('capability lowering is deterministic: compiling the same graph twice produces identical manifest.capabilities and merkleRoot', () => {
  const graph = buildGraph();
  addResolvableCapability(graph, 'a');
  addUnresolvedCapability(graph, 'a');
  const opts = { identity: { name: 'xo_test_pkg', version: '0.1.0', creatorDid: 'did:xo:test' }, metadata: metadata() };
  const first = packageXoirGraph(graph, opts);
  const second = packageXoirGraph(graph, opts);
  assert.ok(first.ok && second.ok);
  if (!first.ok || !second.ok) return;
  assert.deepEqual(first.value.manifest.capabilities, second.value.manifest.capabilities);
  assert.equal(first.value.manifest.merkleRoot, second.value.manifest.merkleRoot);
});

test('a lowered declaration is traceable back to its source XOIR capability node id (provenance)', () => {
  const graph = buildGraph();
  const { capabilityId } = addResolvableCapability(graph, 'a');
  const result = packageXoirGraph(graph, {
    identity: { name: 'xo_test_pkg', version: '0.1.0', creatorDid: 'did:xo:test' },
    metadata: metadata(),
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  // @xo/types' CapabilityDeclaration has no dedicated provenance field, so
  // the declaration's own `id` — reused verbatim from the source XOIR node
  // id, per SemanticCapabilityContract's own doc comment ("never a freshly
  // minted id") — IS the provenance linkage back to knowledge_graph.json's
  // capability node of the same id (asserted above in the "resolved" test).
  assert.equal(result.value.manifest.capabilities![0]!.id, capabilityId);
});

// ---------------------------------------------------------------------------
// R1 compiler-side closure: manifest.capabilities[].execution AND the
// packaged knowledge_graph.json's capability node must both come from the
// SAME resolved SemanticCapabilityContract — see capability-lowering.ts's
// call to embedResolvedContractInCapabilityNode, and packager.ts's ordering
// comment on why buildKnowledgeGraphComponent runs after lowering.
// ---------------------------------------------------------------------------

test('R1 closure (1+2): a resolved deterministic capability gets its contract embedded in the KG node, and execution.contractId matches the embedded contract id', () => {
  const graph = buildGraph();
  const { capabilityId } = addResolvableCapability(graph, 'a');
  const result = packageXoirGraph(graph, {
    identity: { name: 'xo_test_pkg', version: '0.1.0', creatorDid: 'did:xo:test' },
    metadata: metadata(),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  const declaration = result.value.manifest.capabilities![0]!;
  assert.ok(declaration.execution, 'manifest declaration must carry an authoritative execution field');
  assert.equal(declaration.execution!.mode, 'deterministic_rule');
  assert.equal(declaration.execution!.contractId, capabilityId);
  assert.ok(declaration.execution!.bindingId, 'execution.bindingId must be present');

  const kgComponent = result.value.bundle.components.find((c) => c.kind === 'knowledge_graph');
  assert.ok(kgComponent);
  const parsed = JSON.parse(new TextDecoder().decode(kgComponent!.data)) as { readonly nodes: readonly { readonly id: string; readonly kind: string; readonly properties?: { readonly semanticCapabilityContract?: { readonly id: string } } }[] };
  const capabilityNode = parsed.nodes.find((n) => n.id === capabilityId && n.kind === 'capability');
  assert.ok(capabilityNode, 'the capability node must still exist in the packaged knowledge graph');
  assert.equal(capabilityNode!.properties?.semanticCapabilityContract?.id, declaration.execution!.contractId, 'the SAME resolved contract must be represented consistently between the manifest declaration and the packaged knowledge graph');
});

test('R1 closure (3): an existing REQUIRES edge touching the capability node survives packaging', () => {
  const graph = buildGraph();
  const { capabilityId, decisionId } = addResolvableCapability(graph, 'a');
  const result = packageXoirGraph(graph, {
    identity: { name: 'xo_test_pkg', version: '0.1.0', creatorDid: 'did:xo:test' },
    metadata: metadata(),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  const kgComponent = result.value.bundle.components.find((c) => c.kind === 'knowledge_graph');
  const parsed = JSON.parse(new TextDecoder().decode(kgComponent!.data)) as { readonly edges: readonly { readonly kind: string; readonly from: string; readonly to: string }[] };
  const edge = parsed.edges.find((e) => e.from === decisionId && e.to === capabilityId);
  assert.ok(edge, 'the REQUIRES edge from the decision node to the capability node must survive embedding + packaging');
  assert.equal(edge!.kind, 'REQUIRES');
});

test('R1 closure (4): unrelated node metadata (confidence, tags) survives packaging alongside an embedded capability', () => {
  const graph = buildGraph();
  addResolvableCapability(graph, 'a');
  const result = packageXoirGraph(graph, {
    identity: { name: 'xo_test_pkg', version: '0.1.0', creatorDid: 'did:xo:test' },
    metadata: metadata(),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  const kgComponent = result.value.bundle.components.find((c) => c.kind === 'knowledge_graph');
  const parsed = JSON.parse(new TextDecoder().decode(kgComponent!.data)) as { readonly nodes: readonly { readonly id: string; readonly confidence?: number }[] };
  // "concept:a" (from buildGraph(), confidence 0.8) is untouched by embedding — a different node entirely — so its metadata must be exactly what buildGraph() set, proving embedding doesn't disturb unrelated nodes.
  const unrelatedNode = parsed.nodes.find((n) => n.id === 'concept:a');
  assert.ok(unrelatedNode);
  assert.equal(unrelatedNode!.confidence, 0.8);
});

test('R1 closure (5): an unresolved capability does not receive a false executable contract (no execution field, no embedded contract)', () => {
  const graph = buildGraph();
  const capabilityId = addUnresolvedCapability(graph, 'a');
  const result = packageXoirGraph(graph, {
    identity: { name: 'xo_test_pkg', version: '0.1.0', creatorDid: 'did:xo:test' },
    metadata: metadata(),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  assert.equal(result.value.manifest.capabilities, undefined, 'an unresolved capability must not produce any manifest.capabilities entry at all');

  const kgComponent = result.value.bundle.components.find((c) => c.kind === 'knowledge_graph');
  const parsed = JSON.parse(new TextDecoder().decode(kgComponent!.data)) as { readonly nodes: readonly { readonly id: string; readonly properties?: { readonly semanticCapabilityContract?: unknown } }[] };
  const node = parsed.nodes.find((n) => n.id === capabilityId);
  assert.ok(node, 'the bare capability node must still be discoverable in the packaged knowledge graph');
  assert.equal(node!.properties?.semanticCapabilityContract, undefined, 'an unresolved capability must NOT have a contract embedded — it was never promoted to executable');
});

test('R1 closure (5b): a denied (non_deterministic) capability also does not receive a false executable contract', () => {
  const graph = buildGraph();
  const { capabilityId } = addDeniedCapability(graph, 'a');
  const result = packageXoirGraph(graph, {
    identity: { name: 'xo_test_pkg', version: '0.1.0', creatorDid: 'did:xo:test' },
    metadata: metadata(),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  const kgComponent = result.value.bundle.components.find((c) => c.kind === 'knowledge_graph');
  const parsed = JSON.parse(new TextDecoder().decode(kgComponent!.data)) as { readonly nodes: readonly { readonly id: string; readonly properties?: { readonly semanticCapabilityContract?: unknown } }[] };
  const node = parsed.nodes.find((n) => n.id === capabilityId);
  assert.ok(node);
  assert.equal(node!.properties?.semanticCapabilityContract, undefined, 'a denied capability (explicitly non_deterministic) must never receive an embedded contract, even though it was discovered');
});

test('R1 closure (6): package validation still passes with an embedded contract present', () => {
  const graph = buildGraph();
  addResolvableCapability(graph, 'a');
  const result = packageXoirGraph(graph, {
    identity: { name: 'xo_test_pkg', version: '0.1.0', creatorDid: 'did:xo:test' },
    metadata: metadata(),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  const validator = new PackageValidator();
  const report = validator.validateAll({ manifest: result.value.manifest, components: result.value.bundle.components, ancillary: result.value.bundle.ancillary });
  assert.deepEqual(report.issues.filter((i) => i.severity === 'error'), []);
});

test('package round trip: a built .xo package validates and its manifest.capabilities.length > 0', () => {
  const graph = buildGraph();
  addResolvableCapability(graph, 'a');
  const result = packageXoirGraph(graph, {
    identity: { name: 'xo_test_pkg', version: '0.1.0', creatorDid: 'did:xo:test' },
    metadata: metadata(),
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  const validator = new PackageValidator();
  const report = validator.validateAll({ manifest: result.value.manifest, components: result.value.bundle.components, ancillary: result.value.bundle.ancillary });
  assert.deepEqual(report.issues.filter((i) => i.severity === 'error'), []);
  assert.ok(result.value.manifest.capabilities!.length > 0);
});

test('upstreamDiagnostics pass through unchanged onto PackagerResult.diagnostics', () => {
  const graph = buildGraph();
  const diagnostics = [{ severity: 'warning' as const, message: 'test diagnostic', passName: 'xoir-validation' }];
  const result = packageXoirGraph(graph, {
    identity: { name: 'xo_test_pkg', version: '0.1.0', creatorDid: 'did:xo:test' },
    metadata: metadata(),
    upstreamDiagnostics: diagnostics,
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value.diagnostics, diagnostics);
});

test('packaging the same graph twice produces byte-identical component data and an identical merkleRoot', () => {
  const graph = buildGraph();
  const opts = { identity: { name: 'xo_test_pkg', version: '0.1.0', creatorDid: 'did:xo:test' }, metadata: metadata() };
  const first = packageXoirGraph(graph, opts);
  const second = packageXoirGraph(graph, opts);
  assert.ok(first.ok && second.ok);
  if (!first.ok || !second.ok) return;
  assert.equal(first.value.manifest.merkleRoot, second.value.manifest.merkleRoot);
  for (const kind of Object.keys(first.value.manifest.components)) {
    assert.equal(first.value.manifest.components[kind as keyof typeof first.value.manifest.components].hash, second.value.manifest.components[kind as keyof typeof second.value.manifest.components].hash);
  }
});

test('a compatibilityOverride is honored verbatim instead of the data-driven default', () => {
  const graph = buildGraph();
  const override = { modelFamilies: [{ family: 'gemini' as const, minCapability: ['chat' as const], consumes: ['knowledge_graph' as const] }], fallbackPolicy: 'reject' as const };
  const result = packageXoirGraph(graph, {
    identity: { name: 'xo_test_pkg', version: '0.1.0', creatorDid: 'did:xo:test' },
    metadata: metadata(),
    compatibilityOverride: override,
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value.manifest.compatibility, override);
});
