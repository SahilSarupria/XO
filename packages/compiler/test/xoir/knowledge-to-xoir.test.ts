import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGraph, XoirNodeId } from '@xo/xoir';
import { computeKnowledgeNodeId, computeKnowledgeEdgeId } from '../../src/knowledge/node-id.js';
import type { KnowledgeEdge, KnowledgeGraph, KnowledgeNode, KnowledgeProvenance } from '../../src/knowledge/types.js';
import { knowledgeGraphToXoir, collectKnowledgeRuleSources } from '../../src/xoir/knowledge-to-xoir.js';

function provenance(overrides: Partial<KnowledgeProvenance> = {}): KnowledgeProvenance {
  return {
    experienceUnitId: 'unit-1',
    documentPath: 'contracts/nda.pdf',
    pages: [1],
    sectionPath: ['Definitions'],
    charOffsetRange: [0, 10],
    confidence: 0.9,
    ...overrides,
  };
}

function node(overrides: Partial<KnowledgeNode> & { canonicalLabel: string; semanticType: KnowledgeNode['semanticType'] }): KnowledgeNode {
  const id = overrides.id ?? computeKnowledgeNodeId(overrides.semanticType, overrides.canonicalLabel);
  return {
    id,
    semanticType: overrides.semanticType,
    canonicalLabel: overrides.canonicalLabel,
    aliases: overrides.aliases ?? [],
    confidence: overrides.confidence ?? 0.8,
    provenance: overrides.provenance ?? [provenance()],
    metadata: overrides.metadata ?? {},
    ...(overrides.producedBy !== undefined ? { producedBy: overrides.producedBy } : {}),
  };
}

test('a "concept"-mapped node (organization) converts to a XOIR concept node with subtype preserved', () => {
  const n = node({ semanticType: 'organization', canonicalLabel: 'Acme Corp' });
  const graph: KnowledgeGraph = { nodes: [n], edges: [] };

  const result = knowledgeGraphToXoir(graph);
  assert.ok(result.ok);
  if (!result.ok) return;

  const xoirNode = result.value.getNode(XoirNodeId(n.id as unknown as string));
  assert.ok(xoirNode.ok);
  if (!xoirNode.ok) return;
  assert.equal(xoirNode.value.kind, 'concept');
  assert.equal(xoirNode.value.metadata.subtype, 'organization');
  assert.equal((xoirNode.value.properties as { definition: string }).definition, 'Acme Corp');
});

test('a "fact"-mapped node (metric) converts to a XOIR fact node with subtype preserved', () => {
  const n = node({ semanticType: 'metric', canonicalLabel: 'Contract value is $2M' });
  const graph: KnowledgeGraph = { nodes: [n], edges: [] };
  const result = knowledgeGraphToXoir(graph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const xoirNode = result.value.getNode(XoirNodeId(n.id as unknown as string));
  assert.ok(xoirNode.ok);
  if (!xoirNode.ok) return;
  assert.equal(xoirNode.value.kind, 'fact');
  assert.equal(xoirNode.value.metadata.subtype, 'metric');
});

test('a "constraint"-mapped node (obligation) converts to a XOIR constraint node with subtype preserved', () => {
  const n = node({ semanticType: 'obligation', canonicalLabel: 'Must deliver within 30 days' });
  const graph: KnowledgeGraph = { nodes: [n], edges: [] };
  const result = knowledgeGraphToXoir(graph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const xoirNode = result.value.getNode(XoirNodeId(n.id as unknown as string));
  assert.ok(xoirNode.ok);
  if (!xoirNode.ok) return;
  assert.equal(xoirNode.value.kind, 'constraint');
  assert.equal(xoirNode.value.metadata.subtype, 'obligation');
});

test('a custom:<name> semanticType falls back to concept but still preserves the exact subtype string', () => {
  const n = node({ semanticType: 'custom:governing-law-clause', canonicalLabel: 'Governed by NY law' });
  const graph: KnowledgeGraph = { nodes: [n], edges: [] };
  const result = knowledgeGraphToXoir(graph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const xoirNode = result.value.getNode(XoirNodeId(n.id as unknown as string));
  assert.ok(xoirNode.ok);
  if (!xoirNode.ok) return;
  assert.equal(xoirNode.value.kind, 'concept');
  assert.equal(xoirNode.value.metadata.subtype, 'custom:governing-law-clause');
});

test('aliases are preserved on the converted concept node', () => {
  const n = node({ semanticType: 'organization', canonicalLabel: 'OpenAI', aliases: ['Open AI', 'OpenAI Inc.'] });
  const graph: KnowledgeGraph = { nodes: [n], edges: [] };
  const result = knowledgeGraphToXoir(graph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const xoirNode = result.value.getNode(XoirNodeId(n.id as unknown as string));
  assert.ok(xoirNode.ok);
  if (!xoirNode.ok) return;
  assert.deepEqual((xoirNode.value.properties as { aliases: readonly string[] }).aliases, ['Open AI', 'OpenAI Inc.']);
});

test('provenance converts losslessly (documentPath, pages, sectionPath, charOffsetRange, experienceUnitId, sourceConfidence)', () => {
  const p = provenance({ documentPath: 'contracts/msa.pdf', pages: [4, 5], sectionPath: ['Term', 'Renewal'], charOffsetRange: [100, 140], confidence: 0.77, experienceUnitId: 'unit-42' });
  const n = node({ semanticType: 'concept', canonicalLabel: 'Auto-renewal clause', provenance: [p] });
  const graph: KnowledgeGraph = { nodes: [n], edges: [] };
  const result = knowledgeGraphToXoir(graph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const xoirNode = result.value.getNode(XoirNodeId(n.id as unknown as string));
  assert.ok(xoirNode.ok);
  if (!xoirNode.ok) return;
  const ref = xoirNode.value.metadata.sourceRefs[0]!;
  assert.equal(ref.documentPath, 'contracts/msa.pdf');
  assert.deepEqual(ref.pages, [4, 5]);
  assert.deepEqual(ref.sectionPath, ['Term', 'Renewal']);
  assert.deepEqual(ref.charOffsetRange, [100, 140]);
  assert.equal(ref.experienceUnitId, 'unit-42');
  assert.equal(ref.sourceConfidence, 0.77);
});

test('confidence converts to both metadata.confidence (unchanged) and a derived confidenceDetail with real corroboration count', () => {
  const n = node({ semanticType: 'concept', canonicalLabel: 'X', confidence: 0.65, provenance: [provenance(), provenance({ documentPath: 'other.pdf' }), provenance({ documentPath: 'third.pdf' })] });
  const graph: KnowledgeGraph = { nodes: [n], edges: [] };
  const result = knowledgeGraphToXoir(graph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const xoirNode = result.value.getNode(XoirNodeId(n.id as unknown as string));
  assert.ok(xoirNode.ok);
  if (!xoirNode.ok) return;
  assert.equal(xoirNode.value.metadata.confidence, 0.65);
  assert.equal(xoirNode.value.metadata.confidenceDetail?.score, 0.65);
  assert.equal(xoirNode.value.metadata.confidenceDetail?.corroboration, 3);
  assert.equal(xoirNode.value.metadata.confidenceDetail?.evidenceStrength, 'moderate');
  assert.equal(xoirNode.value.metadata.confidenceDetail?.calibrated, false);
});

test('node identity is preserved: the KnowledgeNode id becomes the XOIR node id verbatim', () => {
  const n = node({ semanticType: 'organization', canonicalLabel: 'Acme Corp' });
  const graph: KnowledgeGraph = { nodes: [n], edges: [] };
  const result = knowledgeGraphToXoir(graph);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(result.value.hasNode(XoirNodeId(n.id as unknown as string)));
});

test('edges convert with the total Stage 4 -> XOIR edge kind mapping and preserve provenance/confidence', () => {
  const a = node({ semanticType: 'organization', canonicalLabel: 'Acme Corp' });
  const b = node({ semanticType: 'jurisdiction', canonicalLabel: 'New York' });
  const e: KnowledgeEdge = {
    id: computeKnowledgeEdgeId('located_in', a.id, b.id),
    type: 'located_in',
    fromNodeId: a.id,
    toNodeId: b.id,
    confidence: 0.72,
    provenance: [provenance()],
  };
  const graph: KnowledgeGraph = { nodes: [a, b], edges: [e] };
  const result = knowledgeGraphToXoir(graph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const xoirEdge = result.value.getEdge(e.id);
  assert.ok(xoirEdge.ok);
  if (!xoirEdge.ok) return;
  assert.equal(xoirEdge.value.kind, 'LOCATED_IN');
  assert.equal(xoirEdge.value.metadata.confidence, 0.72);
  assert.equal(xoirEdge.value.metadata.sourceRefs.length, 1);
});

test('every core-semantic Stage 4 edge type (requires/supports/contradicts/derived_from/supersedes) lands on the matching XOIR core edge kind', () => {
  const a = node({ semanticType: 'concept', canonicalLabel: 'A' });
  const b = node({ semanticType: 'concept', canonicalLabel: 'B' });
  const pairs: ReadonlyArray<[KnowledgeEdge['type'], string]> = [
    ['requires', 'REQUIRES'],
    ['supports', 'SUPPORTS'],
    ['contradicts', 'CONTRADICTS'],
    ['derived_from', 'DERIVED_FROM'],
    ['supersedes', 'SUPERSEDES'],
  ];
  for (const [type, expectedKind] of pairs) {
    const e: KnowledgeEdge = { id: computeKnowledgeEdgeId(type, a.id, b.id), type, fromNodeId: a.id, toNodeId: b.id, confidence: 0.5, provenance: [] };
    const graph: KnowledgeGraph = { nodes: [a, b], edges: [e] };
    const result = knowledgeGraphToXoir(graph);
    assert.ok(result.ok);
    if (!result.ok) continue;
    const xoirEdge = result.value.getEdge(e.id);
    assert.ok(xoirEdge.ok);
    if (!xoirEdge.ok) continue;
    assert.equal(xoirEdge.value.kind, expectedKind);
  }
});

test('an edge whose endpoint is missing from the KnowledgeGraph is skipped rather than failing the whole conversion', () => {
  const a = node({ semanticType: 'concept', canonicalLabel: 'A' });
  const e: KnowledgeEdge = { id: 'e1', type: 'references', fromNodeId: a.id, toNodeId: 'does-not-exist' as KnowledgeEdge['toNodeId'], confidence: 0.5, provenance: [] };
  const graph: KnowledgeGraph = { nodes: [a], edges: [e] };
  const result = knowledgeGraphToXoir(graph);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.getEdge('e1').ok, false);
  assert.equal(result.value.allNodes().length, 1);
});

test('the resulting XOIR graph passes structural validation', () => {
  const a = node({ semanticType: 'organization', canonicalLabel: 'Acme Corp' });
  const b = node({ semanticType: 'jurisdiction', canonicalLabel: 'New York' });
  const e: KnowledgeEdge = { id: computeKnowledgeEdgeId('located_in', a.id, b.id), type: 'located_in', fromNodeId: a.id, toNodeId: b.id, confidence: 0.72, provenance: [provenance()] };
  const graph: KnowledgeGraph = { nodes: [a, b], edges: [e] };
  const result = knowledgeGraphToXoir(graph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const report = validateGraph(result.value);
  assert.equal(report.valid, true, JSON.stringify(report.issues));
});

test('conversion is deterministic given a fixed `now`: re-converting the same KnowledgeGraph produces an identical XOIR graph content hash', () => {
  const now = () => '2026-01-01T00:00:00.000Z';
  const n = node({ semanticType: 'organization', canonicalLabel: 'Acme Corp' });
  const graph: KnowledgeGraph = { nodes: [n], edges: [] };
  const r1 = knowledgeGraphToXoir(graph, { now });
  const r2 = knowledgeGraphToXoir(graph, { now });
  assert.ok(r1.ok && r2.ok);
  if (!r1.ok || !r2.ok) return;
  assert.equal(r1.value.contentHash(), r2.value.contentHash());
});

// ---------------------------------------------------------------------------
// collectKnowledgeRuleSources: the pure helper pipeline/compile.ts uses to
// find candidate knowledge-stage "rule" nodes for rule-capability-linking.ts.
// Independent of any XOIR conversion — operates on the raw KnowledgeGraph.
// ---------------------------------------------------------------------------

test('collectKnowledgeRuleSources: a constraint/obligation/exception node becomes a rule source; a concept/fact node does not', () => {
  const constraintNode = node({ semanticType: 'constraint', canonicalLabel: 'Claims must be filed within 30 days' });
  const obligationNode = node({ semanticType: 'obligation', canonicalLabel: 'Insurer must acknowledge receipt within 10 days' });
  const exceptionNode = node({ semanticType: 'exception', canonicalLabel: 'Unless the delay was caused by the insurer' });
  const conceptNode = node({ semanticType: 'concept', canonicalLabel: 'Claim' });
  const factNode = node({ semanticType: 'metric', canonicalLabel: 'Deductible is $500' });
  const graph: KnowledgeGraph = { nodes: [constraintNode, obligationNode, exceptionNode, conceptNode, factNode], edges: [] };

  const sources = collectKnowledgeRuleSources(graph);
  const sourceIds = sources.map((s) => s.nodeId).sort();
  assert.deepEqual(sourceIds, [constraintNode.id, exceptionNode.id, obligationNode.id].sort());
});

test('collectKnowledgeRuleSources: searchableText is the node\'s own canonicalLabel verbatim, never fabricated', () => {
  const n = node({ semanticType: 'constraint', canonicalLabel: 'Claims must be filed within 30 days of loss' });
  const graph: KnowledgeGraph = { nodes: [n], edges: [] };
  const sources = collectKnowledgeRuleSources(graph);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.searchableText, 'Claims must be filed within 30 days of loss');
});

test('collectKnowledgeRuleSources: unitId is the node\'s first provenance experienceUnitId', () => {
  const n = node({ semanticType: 'obligation', canonicalLabel: 'Must notify within 24 hours', provenance: [provenance({ experienceUnitId: 'unit-42' }), provenance({ experienceUnitId: 'unit-99' })] });
  const graph: KnowledgeGraph = { nodes: [n], edges: [] };
  const sources = collectKnowledgeRuleSources(graph);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.unitId, 'unit-42');
});

test('collectKnowledgeRuleSources: a node with no provenance gets unitId undefined, not a guess', () => {
  const n = node({ semanticType: 'constraint', canonicalLabel: 'No provenance rule', provenance: [] });
  const graph: KnowledgeGraph = { nodes: [n], edges: [] };
  const sources = collectKnowledgeRuleSources(graph);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.unitId, undefined);
});

test('collectKnowledgeRuleSources: an empty KnowledgeGraph yields no rule sources', () => {
  assert.deepEqual(collectKnowledgeRuleSources({ nodes: [], edges: [] }), []);
});

// --- P0.9A area A: producer attribution ---

test('a KnowledgeNode.producedBy survives conversion into the XOIR node\'s metadata.producedBy verbatim', () => {
  const n = node({ semanticType: 'organization', canonicalLabel: 'Acme Corp', producedBy: 'rule-based' });
  const graph: KnowledgeGraph = { nodes: [n], edges: [] };
  const result = knowledgeGraphToXoir(graph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const xoirNode = result.value.getNode(XoirNodeId(n.id));
  assert.ok(xoirNode.ok);
  if (xoirNode.ok) assert.equal(xoirNode.value.metadata.producedBy, 'rule-based');
});

test('a KnowledgeNode with no producedBy converts to a XOIR node with metadata.producedBy absent, not fabricated', () => {
  const n = node({ semanticType: 'organization', canonicalLabel: 'Ambiguous Corp' });
  const graph: KnowledgeGraph = { nodes: [n], edges: [] };
  const result = knowledgeGraphToXoir(graph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const xoirNode = result.value.getNode(XoirNodeId(n.id));
  assert.ok(xoirNode.ok);
  if (xoirNode.ok) assert.equal(xoirNode.value.metadata.producedBy, undefined);
});

test('conversion preserves existing sourceRefs and confidence/basis unchanged alongside the new producedBy field', () => {
  const n = node({
    semanticType: 'organization',
    canonicalLabel: 'Acme Corp',
    producedBy: 'ai',
    confidence: 0.73,
    provenance: [provenance({ experienceUnitId: 'unit-7', confidence: 0.73 })],
  });
  const graph: KnowledgeGraph = { nodes: [n], edges: [] };
  const result = knowledgeGraphToXoir(graph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const xoirNode = result.value.getNode(XoirNodeId(n.id));
  assert.ok(xoirNode.ok);
  if (!xoirNode.ok) return;
  assert.equal(xoirNode.value.metadata.producedBy, 'ai');
  assert.equal(xoirNode.value.metadata.confidence, 0.73);
  assert.equal(xoirNode.value.metadata.sourceRefs.length, 1);
  assert.equal(xoirNode.value.metadata.sourceRefs[0]!.experienceUnitId, 'unit-7');
  assert.ok(xoirNode.value.metadata.confidenceDetail !== undefined, 'existing ConfidenceBasis derivation must still run');
});

test('reviewStatus is optional and absent by default: a graph with no reviewStatus set anywhere converts and round-trips with the field absent (backward compatible)', () => {
  const n = node({ semanticType: 'organization', canonicalLabel: 'Acme Corp' });
  const graph: KnowledgeGraph = { nodes: [n], edges: [] };
  const result = knowledgeGraphToXoir(graph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const xoirNode = result.value.getNode(XoirNodeId(n.id));
  assert.ok(xoirNode.ok);
  if (xoirNode.ok) assert.equal(xoirNode.value.metadata.reviewStatus, undefined);
});
