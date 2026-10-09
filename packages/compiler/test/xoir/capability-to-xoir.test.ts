import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGraph, XoirNodeId } from '@xo/xoir';
import { computeCapabilityId, computeCapabilityRelationshipId } from '../../src/capabilities/capability-id.js';
import { computeKnowledgeNodeId } from '../../src/knowledge/node-id.js';
import type { Capability, CapabilityGraph, CapabilityRelationship, CapabilitySignature } from '../../src/capabilities/types.js';
import { UNKNOWN_SIGNATURE } from '../../src/capabilities/types.js';
import type { KnowledgeGraph, KnowledgeNode, KnowledgeProvenance } from '../../src/knowledge/types.js';
import { capabilityGraphToXoir } from '../../src/xoir/capability-to-xoir.js';
import { knowledgeGraphToXoir } from '../../src/xoir/knowledge-to-xoir.js';

function provenance(overrides: Partial<KnowledgeProvenance> = {}): KnowledgeProvenance {
  return {
    experienceUnitId: 'unit-1',
    documentPath: 'contracts/nda.pdf',
    pages: [1],
    sectionPath: ['Obligations'],
    charOffsetRange: [0, 10],
    confidence: 0.9,
    ...overrides,
  };
}

function capability(overrides: Partial<Capability> & { canonicalName: string; category: Capability['category'] }): Capability {
  return {
    id: overrides.id ?? computeCapabilityId(overrides.category, overrides.canonicalName),
    canonicalName: overrides.canonicalName,
    aliases: overrides.aliases ?? [],
    description: overrides.description ?? `Capability: ${overrides.canonicalName}`,
    category: overrides.category,
    confidence: overrides.confidence ?? 0.8,
    provenance: overrides.provenance ?? [provenance()],
    inputs: overrides.inputs ?? [],
    outputs: overrides.outputs ?? [],
    dependencies: overrides.dependencies ?? [],
    requiredKnowledgeNodeIds: overrides.requiredKnowledgeNodeIds ?? [],
    relatedConcepts: overrides.relatedConcepts ?? [],
    requiredPermissions: overrides.requiredPermissions ?? [],
    invocationHints: overrides.invocationHints ?? [],
    examples: overrides.examples ?? [],
    signature: overrides.signature ?? UNKNOWN_SIGNATURE,
    metadata: overrides.metadata ?? {},
  };
}

test('Send Email / Email Sending / Mail Sender converge at Stage 5 (computeCapabilityId) and the adapter preserves that single node — this is the required worked example', () => {
  // Stage 5's own merge (../capabilities/merge.ts) is what actually folds three raw extractions
  // into one Capability with three aliases; we construct that already-merged Capability directly
  // here, since capability-id.test.ts already proves the id-convergence step in isolation.
  const merged = capability({
    canonicalName: 'Send Email',
    category: 'communication',
    aliases: ['Email Sending', 'Mail Sender'],
  });
  const graph: CapabilityGraph = { capabilities: [merged], relationships: [] };

  const result = capabilityGraphToXoir(graph);
  assert.ok(result.ok);
  if (!result.ok) return;

  assert.equal(result.value.allNodes().length, 1);
  const xoirNode = result.value.getNode(XoirNodeId(merged.id as unknown as string));
  assert.ok(xoirNode.ok);
  if (!xoirNode.ok) return;
  assert.equal(xoirNode.value.kind, 'capability');
  assert.deepEqual((xoirNode.value.properties as { aliases: readonly string[] }).aliases, ['Email Sending', 'Mail Sender']);
  assert.equal((xoirNode.value.properties as { name: string }).name, 'Send Email');
});

test('the full CapabilitySignature is absorbed verbatim, including honest "unknown" values', () => {
  const signature: CapabilitySignature = {
    inputs: [{ name: 'recipient', description: 'Email address to send to' }],
    outputs: [{ name: 'messageId', description: 'The sent message id' }],
    sideEffects: ['sends an email'],
    requiredResources: ['smtp-credentials'],
    determinism: 'non_deterministic',
    idempotent: 'unknown',
    executionMode: 'async',
    estimatedCost: 'low',
  };
  const cap = capability({ canonicalName: 'Send Email', category: 'communication', signature });
  const graph: CapabilityGraph = { capabilities: [cap], relationships: [] };
  const result = capabilityGraphToXoir(graph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const xoirNode = result.value.getNode(XoirNodeId(cap.id as unknown as string));
  assert.ok(xoirNode.ok);
  if (!xoirNode.ok) return;
  const props = xoirNode.value.properties as Record<string, unknown>;
  assert.equal(props.determinism, 'non_deterministic');
  assert.equal(props.idempotent, 'unknown');
  assert.equal(props.executionMode, 'async');
  assert.equal(props.estimatedCost, 'low');
  assert.deepEqual(props.sideEffects, ['sends an email']);
  assert.deepEqual(props.requiredResources, ['smtp-credentials']);
  assert.deepEqual(props.inputs, ['recipient: Email address to send to']);
  assert.deepEqual(props.outputs, ['messageId: The sent message id']);
});

test('a capability with no signature (UNKNOWN_SIGNATURE) converts with every field literally "unknown" — never a fabricated guess', () => {
  const cap = capability({ canonicalName: 'Mystery Capability', category: 'action' });
  const graph: CapabilityGraph = { capabilities: [cap], relationships: [] };
  const result = capabilityGraphToXoir(graph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const xoirNode = result.value.getNode(XoirNodeId(cap.id as unknown as string));
  assert.ok(xoirNode.ok);
  if (!xoirNode.ok) return;
  const props = xoirNode.value.properties as Record<string, unknown>;
  assert.equal(props.determinism, 'unknown');
  assert.equal(props.idempotent, 'unknown');
  assert.equal(props.executionMode, 'unknown');
  assert.equal(props.estimatedCost, 'unknown');
});

test('Capability.dependencies produces both a properties mirror and real REQUIRES edges when the dependency is present', () => {
  const base = capability({ canonicalName: 'Draft Contract', category: 'generation' });
  const dependent = capability({ canonicalName: 'Review Contract', category: 'analysis', dependencies: [base.id] });
  const graph: CapabilityGraph = { capabilities: [base, dependent], relationships: [] };
  const result = capabilityGraphToXoir(graph);
  assert.ok(result.ok);
  if (!result.ok) return;

  const dependentNode = result.value.getNode(XoirNodeId(dependent.id as unknown as string));
  assert.ok(dependentNode.ok);
  if (dependentNode.ok) assert.deepEqual((dependentNode.value.properties as { dependencies: readonly string[] }).dependencies, [base.id]);

  const requiresEdges = result.value.allEdges().filter((e) => e.kind === 'REQUIRES');
  assert.equal(requiresEdges.length, 1);
  assert.equal(requiresEdges[0]!.fromId, XoirNodeId(dependent.id as unknown as string));
  assert.equal(requiresEdges[0]!.toId, XoirNodeId(base.id as unknown as string));
});

test('a dependency id that is not present in this CapabilityGraph is skipped for edges but still recorded in the properties mirror', () => {
  const cap = capability({ canonicalName: 'Review Contract', category: 'analysis', dependencies: ['cap_does_not_exist' as Capability['id']] });
  const graph: CapabilityGraph = { capabilities: [cap], relationships: [] };
  const result = capabilityGraphToXoir(graph);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.allEdges().length, 0);
  const node = result.value.getNode(XoirNodeId(cap.id as unknown as string));
  assert.ok(node.ok);
  if (node.ok) assert.deepEqual((node.value.properties as { dependencies: readonly string[] }).dependencies, ['cap_does_not_exist']);
});

test('CapabilityRelationship converts via the total Stage 5 relation-type -> XOIR edge kind mapping, including the deliberately-distinct CONFLICTS_WITH', () => {
  const a = capability({ canonicalName: 'Approve Invoice', category: 'workflow' });
  const b = capability({ canonicalName: 'Reject Invoice', category: 'workflow' });
  const rel: CapabilityRelationship = {
    id: computeCapabilityRelationshipId('conflicts_with', a.id, b.id),
    type: 'conflicts_with',
    fromCapabilityId: a.id,
    toCapabilityId: b.id,
    confidence: 0.6,
    provenance: [provenance()],
  };
  const graph: CapabilityGraph = { capabilities: [a, b], relationships: [rel] };
  const result = capabilityGraphToXoir(graph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const xoirEdge = result.value.getEdge(rel.id);
  assert.ok(xoirEdge.ok);
  if (!xoirEdge.ok) return;
  assert.equal(xoirEdge.value.kind, 'CONFLICTS_WITH');
  assert.notEqual(xoirEdge.value.kind, 'CONTRADICTS'); // deliberately not folded into the logical-contradiction edge kind
});

test('combining Stage 4 and Stage 5 output via `into`: requiredKnowledgeNodeIds resolves to real REQUIRES edges against the already-converted knowledge graph', () => {
  const knowledgeNode: KnowledgeNode = {
    id: computeKnowledgeNodeId('obligation', 'Must maintain confidentiality'),
    semanticType: 'obligation',
    canonicalLabel: 'Must maintain confidentiality',
    aliases: [],
    confidence: 0.9,
    provenance: [provenance()],
    metadata: {},
  };
  const kGraph: KnowledgeGraph = { nodes: [knowledgeNode], edges: [] };
  const combinedResult = knowledgeGraphToXoir(kGraph, { graphId: 'combined' });
  assert.ok(combinedResult.ok);
  if (!combinedResult.ok) return;
  const combined = combinedResult.value;

  const cap = capability({ canonicalName: 'Draft NDA', category: 'generation', requiredKnowledgeNodeIds: [knowledgeNode.id] });
  const cGraph: CapabilityGraph = { capabilities: [cap], relationships: [] };
  const finalResult = capabilityGraphToXoir(cGraph, { into: combined });
  assert.ok(finalResult.ok);
  if (!finalResult.ok) return;

  const requiresEdges = finalResult.value.allEdges().filter((e) => e.kind === 'REQUIRES');
  assert.equal(requiresEdges.length, 1);
  assert.equal(requiresEdges[0]!.fromId, XoirNodeId(cap.id as unknown as string));
  assert.equal(requiresEdges[0]!.toId, XoirNodeId(knowledgeNode.id as unknown as string));

  const report = validateGraph(finalResult.value);
  assert.equal(report.valid, true, JSON.stringify(report.issues));
});

test('requiredKnowledgeNodeIds is silently skipped (not an error) when converting a CapabilityGraph standalone, without `into`', () => {
  const cap = capability({ canonicalName: 'Draft NDA', category: 'generation', requiredKnowledgeNodeIds: [computeKnowledgeNodeId('obligation', 'Must maintain confidentiality')] });
  const graph: CapabilityGraph = { capabilities: [cap], relationships: [] };
  const result = capabilityGraphToXoir(graph);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.allEdges().length, 0);
});

test('provenance and confidence convert the same way as the knowledge adapter (shared helper)', () => {
  const cap = capability({
    canonicalName: 'Draft NDA',
    category: 'generation',
    confidence: 0.55,
    provenance: [provenance(), provenance({ documentPath: 'other.pdf' })],
  });
  const graph: CapabilityGraph = { capabilities: [cap], relationships: [] };
  const result = capabilityGraphToXoir(graph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const xoirNode = result.value.getNode(XoirNodeId(cap.id as unknown as string));
  assert.ok(xoirNode.ok);
  if (!xoirNode.ok) return;
  assert.equal(xoirNode.value.metadata.confidence, 0.55);
  assert.equal(xoirNode.value.metadata.confidenceDetail?.corroboration, 2);
  assert.equal(xoirNode.value.metadata.sourceRefs.length, 2);
});

test('the resulting XOIR graph passes structural validation', () => {
  const cap = capability({ canonicalName: 'Draft NDA', category: 'generation' });
  const graph: CapabilityGraph = { capabilities: [cap], relationships: [] };
  const result = capabilityGraphToXoir(graph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const report = validateGraph(result.value);
  assert.equal(report.valid, true, JSON.stringify(report.issues));
});

test('conversion is deterministic given a fixed `now`', () => {
  const now = () => '2026-01-01T00:00:00.000Z';
  const cap = capability({ canonicalName: 'Draft NDA', category: 'generation' });
  const graph: CapabilityGraph = { capabilities: [cap], relationships: [] };
  const r1 = capabilityGraphToXoir(graph, { now });
  const r2 = capabilityGraphToXoir(graph, { now });
  assert.ok(r1.ok && r2.ok);
  if (!r1.ok || !r2.ok) return;
  assert.equal(r1.value.contentHash(), r2.value.contentHash());
});
