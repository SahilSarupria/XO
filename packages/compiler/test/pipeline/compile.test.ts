import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph, XoirGraphId, XoirNodeId } from '@xo/xoir';
import { computeKnowledgeNodeId } from '../../src/knowledge/node-id.js';
import { computeCapabilityId } from '../../src/capabilities/capability-id.js';
import type { Capability, CapabilityGraph } from '../../src/capabilities/types.js';
import { UNKNOWN_SIGNATURE } from '../../src/capabilities/types.js';
import type { KnowledgeGraph, KnowledgeNode, KnowledgeProvenance } from '../../src/knowledge/types.js';
import { compileXoir } from '../../src/pipeline/compile.js';
import { XOIR_VALIDATION_PASS_NAME } from '../../src/pipeline/validate-pass.js';
import { REASONING_VALIDATION_PASS_NAME } from '../../src/pipeline/reasoning-validate-pass.js';
import { XOIR_NORMALIZATION_PASS_NAME } from '../../src/pipeline/normalize-pass.js';
import { buildSemanticCapabilityContract } from '@xo/capability-contract';

const now = () => '2026-01-01T00:00:00.000Z';

function provenance(overrides: Partial<KnowledgeProvenance> = {}): KnowledgeProvenance {
  return { experienceUnitId: 'u1', documentPath: 'doc.pdf', pages: [1], sectionPath: ['S'], charOffsetRange: [0, 5], confidence: 0.9, ...overrides };
}

function knowledgeNode(overrides: Partial<KnowledgeNode> & { canonicalLabel: string; semanticType: KnowledgeNode['semanticType'] }): KnowledgeNode {
  return {
    id: overrides.id ?? computeKnowledgeNodeId(overrides.semanticType, overrides.canonicalLabel),
    semanticType: overrides.semanticType,
    canonicalLabel: overrides.canonicalLabel,
    aliases: overrides.aliases ?? [],
    confidence: overrides.confidence ?? 0.8,
    provenance: overrides.provenance ?? [provenance()],
    metadata: overrides.metadata ?? {},
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

// --- Pipeline: Stage 4 input ------------------------------------------------

test('pipeline: KnowledgeGraph input converts to XOIR, validates, and normalizes successfully', async () => {
  const kg: KnowledgeGraph = { nodes: [knowledgeNode({ semanticType: 'organization', canonicalLabel: 'Acme Corp' })], edges: [] };
  const result = await compileXoir({ kind: 'knowledge', graph: kg }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.valid, true);
  assert.equal(result.value.validation.valid, true);
  assert.equal(result.value.stats.nodeCount, 1);
  assert.ok(result.value.graph.hasNode(XoirNodeId(computeKnowledgeNodeId('organization', 'Acme Corp') as unknown as string)));
});

// --- Pipeline: Stage 5 input ------------------------------------------------

test('pipeline: CapabilityGraph input converts to XOIR, validates, and normalizes successfully', async () => {
  const cg: CapabilityGraph = { capabilities: [capability({ canonicalName: 'Send Email', category: 'communication' })], relationships: [] };
  const result = await compileXoir({ kind: 'capability', graph: cg }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.valid, true);
  assert.equal(result.value.stats.nodeCount, 1);
});

// --- Pipeline: combined Stage 4 + Stage 5 input ----------------------------

test('pipeline: combined input converts Knowledge + Capability via the `into` mechanism, with REQUIRES edges resolving', async () => {
  const kNode = knowledgeNode({ semanticType: 'obligation', canonicalLabel: 'Must maintain confidentiality' });
  const kg: KnowledgeGraph = { nodes: [kNode], edges: [] };
  const cap = capability({ canonicalName: 'Draft NDA', category: 'generation', requiredKnowledgeNodeIds: [kNode.id] });
  const cg: CapabilityGraph = { capabilities: [cap], relationships: [] };

  const result = await compileXoir({ kind: 'combined', knowledge: kg, capability: cg }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.valid, true);
  assert.equal(result.value.stats.nodeCount, 2);
  const requiresEdges = result.value.graph.allEdges().filter((e) => e.kind === 'REQUIRES');
  assert.equal(requiresEdges.length, 1);
  // This edge is capability --REQUIRES--> knowledge node (requiredKnowledgeNodeIds' own
  // direction, capability-to-xoir.ts) — see contract-builder.test.ts for the regression
  // proving @xo/capability-contract now picks this direction up too as a linked rule.
  assert.equal(requiresEdges[0]!.fromId, XoirNodeId(cap.id as unknown as string));
  assert.equal(requiresEdges[0]!.toId, XoirNodeId(kNode.id as unknown as string));
});

// ---------------------------------------------------------------------------
// Knowledge-stage (Stage 4) rule -> capability content-mention linking: the
// gap this task closes. A constraint/obligation/exception node with no
// requiredKnowledgeNodeIds relationship at all can still be linked to a
// capability via the same conservative two-tier evidence model Stage 7
// reasoning nodes already use — see rule-capability-linking.ts.
// ---------------------------------------------------------------------------

test('pipeline: a knowledge-stage constraint node links to a capability via exact-label evidence, with no requiredKnowledgeNodeIds relationship at all', async () => {
  const kNode = knowledgeNode({ semanticType: 'constraint', canonicalLabel: 'If the claim assessment amount exceeds 10000, deny the claim.', provenance: [provenance({ experienceUnitId: 'unit-rule' })] });
  const kg: KnowledgeGraph = { nodes: [kNode], edges: [] };
  const cap = capability({ canonicalName: 'Claim Assessment', category: 'analysis', provenance: [provenance({ experienceUnitId: 'unit-capability' })] });
  const cg: CapabilityGraph = { capabilities: [cap], relationships: [] };

  const result = await compileXoir({ kind: 'combined', knowledge: kg, capability: cg }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;

  const linkEdge = result.value.graph.allEdges().find((e) => e.kind === 'REQUIRES' && e.fromId === XoirNodeId(kNode.id as unknown as string) && e.toId === XoirNodeId(cap.id as unknown as string));
  assert.ok(linkEdge, 'expected a constraint -> capability REQUIRES edge from content-mention linking');
  assert.equal(linkEdge!.metadata.custom['evidenceKind'], 'exact_label');
});

test('pipeline: a knowledge-stage constraint node links to a capability via same-unit term overlap, with no exact label substring', async () => {
  const kNode = knowledgeNode({ semanticType: 'constraint', canonicalLabel: 'The amount claimed must not exceed 5000', provenance: [provenance({ experienceUnitId: 'unit-shared' })] });
  const kg: KnowledgeGraph = { nodes: [kNode], edges: [] };
  const cap = capability({ canonicalName: 'Claim Assessment', category: 'analysis', provenance: [provenance({ experienceUnitId: 'unit-shared' })] });
  const cg: CapabilityGraph = { capabilities: [cap], relationships: [] };

  const result = await compileXoir({ kind: 'combined', knowledge: kg, capability: cg }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;

  const linkEdge = result.value.graph.allEdges().find((e) => e.kind === 'REQUIRES' && e.fromId === XoirNodeId(kNode.id as unknown as string) && e.toId === XoirNodeId(cap.id as unknown as string));
  assert.ok(linkEdge, 'expected a constraint -> capability REQUIRES edge from same-unit-term-overlap evidence');
  assert.equal(linkEdge!.metadata.custom['evidenceKind'], 'same_unit_term_overlap');
});

test('pipeline: an unrelated knowledge-stage constraint (different unit, no shared vocabulary, no exact label) is NOT linked to any capability — false negatives preserved over false positives', async () => {
  const kNode = knowledgeNode({ semanticType: 'constraint', canonicalLabel: 'Employees must complete annual training', provenance: [provenance({ experienceUnitId: 'unit-far-away' })] });
  const kg: KnowledgeGraph = { nodes: [kNode], edges: [] };
  const cap = capability({ canonicalName: 'Claim Assessment', category: 'analysis', provenance: [provenance({ experienceUnitId: 'unit-capability' })] });
  const cg: CapabilityGraph = { capabilities: [cap], relationships: [] };

  const result = await compileXoir({ kind: 'combined', knowledge: kg, capability: cg }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;

  const requiresEdges = result.value.graph.allEdges().filter((e) => e.kind === 'REQUIRES');
  assert.equal(requiresEdges.length, 0);
});

test('pipeline: a knowledge-stage concept/fact node (not constraint/obligation/exception) is never treated as a rule source, even with an exact-label match', async () => {
  const kNode = knowledgeNode({ semanticType: 'concept', canonicalLabel: 'Claim Assessment procedures apply to all commercial property claims', provenance: [provenance({ experienceUnitId: 'unit-rule' })] });
  const kg: KnowledgeGraph = { nodes: [kNode], edges: [] };
  const cap = capability({ canonicalName: 'Claim Assessment', category: 'analysis', provenance: [provenance({ experienceUnitId: 'unit-capability' })] });
  const cg: CapabilityGraph = { capabilities: [cap], relationships: [] };

  const result = await compileXoir({ kind: 'combined', knowledge: kg, capability: cg }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;

  const requiresEdges = result.value.graph.allEdges().filter((e) => e.kind === 'REQUIRES');
  assert.equal(requiresEdges.length, 0);
});

// ---------------------------------------------------------------------------
// Full path proof: PDF-shaped Knowledge+Capability input -> linked knowledge-
// stage rule -> non-empty SemanticCapabilityContract.rules (@xo/capability-
// contract, consumed exactly as capability-lowering.ts consumes it — this
// test never touches capability-lowering.ts/packager.ts/contract-embed.ts
// themselves, per this task's off-limits list, only proves the XOIR-level
// prerequisite those untouched modules depend on now actually exists).
// ---------------------------------------------------------------------------

test('end-to-end: a knowledge-stage constraint linked via content-mention evidence produces a non-empty, correctly-typed SemanticCapabilityContract.rules entry', async () => {
  const kNode = knowledgeNode({ semanticType: 'constraint', canonicalLabel: 'If the claim assessment amount exceeds 10000, deny the claim.', provenance: [provenance({ experienceUnitId: 'unit-rule' })] });
  const kg: KnowledgeGraph = { nodes: [kNode], edges: [] };
  const cap = capability({ canonicalName: 'Claim Assessment', category: 'analysis', provenance: [provenance({ experienceUnitId: 'unit-capability' })] });
  const cg: CapabilityGraph = { capabilities: [cap], relationships: [] };

  const result = await compileXoir({ kind: 'combined', knowledge: kg, capability: cg }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;

  const contractResult = buildSemanticCapabilityContract(result.value.graph, XoirNodeId(cap.id as unknown as string));
  assert.ok(contractResult.ok);
  if (!contractResult.ok) return;
  assert.equal(contractResult.value.rules.length, 1);
  assert.equal(contractResult.value.rules[0]!.kind, 'constraint');
  assert.equal(contractResult.value.rules[0]!.sourceNodeId, kNode.id);
  // A bare constraint rule carries a condition but never a fabricated outcome — a
  // constraint's XOIR shape (rule/severity only, see @xo/xoir's ConstraintNodeProps) has
  // no outcome field to draw one from, so it is expected to remain 'unresolved' at the
  // binding-resolver stage even once linked, which is correct: linking makes a rule
  // *reachable*, it does not by itself make a rule *deterministic*.
  assert.equal(contractResult.value.rules[0]!.outcome, undefined);
});

// --- Pipeline: raw XOIR escape hatch ----------------------------------------

test('pipeline: a pre-built XoirGraph (future-adapter escape hatch) is accepted directly', async () => {
  const graph = XoirGraph.create(XoirGraphId('pre-built'));
  graph.createAndAddNode({ id: XoirNodeId('n1'), kind: 'concept', properties: { definition: 'x' }, now });
  const result = await compileXoir({ kind: 'xoir', graph }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.valid, true);
});

// --- Validation ---------------------------------------------------------------

test('validation: a structurally invalid XOIR graph stops before normalization, with structured diagnostics', async () => {
  const graph = XoirGraph.create(XoirGraphId('bad'));
  // Missing required property "definition" for a concept node.
  graph.createAndAddNode({ id: XoirNodeId('n1'), kind: 'concept', properties: {}, now });

  const result = await compileXoir({ kind: 'xoir', graph }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.valid, false);
  assert.equal(result.value.validation.valid, false);
  assert.ok(result.value.diagnostics.length > 0);
  assert.ok(result.value.diagnostics.every((d) => d.passName === XOIR_VALIDATION_PASS_NAME));
  // Normalization must not have run at all.
  assert.ok(result.value.passRuns.every((r) => r.passName !== XOIR_NORMALIZATION_PASS_NAME));
});

test('validation: diagnostics carry code, severity, pass, and the relevant node id', async () => {
  const graph = XoirGraph.create(XoirGraphId('bad'));
  graph.createAndAddNode({ id: XoirNodeId('n1'), kind: 'concept', properties: {}, now });
  const result = await compileXoir({ kind: 'xoir', graph }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  const diag = result.value.diagnostics[0]!;
  assert.equal(diag.severity, 'error');
  assert.equal(diag.code, 'xoir-validation/missing_required_property');
  assert.equal(diag.passName, XOIR_VALIDATION_PASS_NAME);
  assert.equal(diag.nodeId, XoirNodeId('n1'));
});

test('validation: a graph-level issue (unsupported schema version) has no nodeId/edgeId', async () => {
  const graph = XoirGraph.create(XoirGraphId('bad'), 999);
  const result = await compileXoir({ kind: 'xoir', graph }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.valid, false);
  const diag = result.value.diagnostics.find((d) => d.code === 'xoir-validation/unsupported_schema_version');
  assert.ok(diag);
  assert.equal(diag!.nodeId, undefined);
  assert.equal(diag!.edgeId, undefined);
});

test('validation: a valid graph proceeds and reports no error diagnostics', async () => {
  const kg: KnowledgeGraph = { nodes: [knowledgeNode({ semanticType: 'organization', canonicalLabel: 'Acme Corp' })], edges: [] };
  const result = await compileXoir({ kind: 'knowledge', graph: kg }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(
    result.value.diagnostics.some((d) => d.severity === 'error'),
    false,
  );
});

// --- Normalization --------------------------------------------------------

test('normalization: node/edge iteration order is stable (sorted by id) regardless of insertion order', async () => {
  const nodeZ = knowledgeNode({ semanticType: 'organization', canonicalLabel: 'Zebra Corp' });
  const nodeA = knowledgeNode({ semanticType: 'organization', canonicalLabel: 'Aardvark Inc' });
  const kg: KnowledgeGraph = { nodes: [nodeZ, nodeA], edges: [] };
  const result = await compileXoir({ kind: 'knowledge', graph: kg }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  const ids = result.value.graph.allNodes().map((n) => n.id);
  assert.deepEqual([...ids].sort(), ids);
});

test('normalization: sourceRefs are reordered into canonical order without losing any of them', async () => {
  const node = knowledgeNode({
    semanticType: 'organization',
    canonicalLabel: 'Acme Corp',
    provenance: [provenance({ documentPath: 'z.pdf' }), provenance({ documentPath: 'a.pdf' })],
  });
  const kg: KnowledgeGraph = { nodes: [node], edges: [] };
  const result = await compileXoir({ kind: 'knowledge', graph: kg }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  const xoirNode = result.value.graph.getNode(XoirNodeId(node.id as unknown as string));
  assert.ok(xoirNode.ok);
  if (!xoirNode.ok) return;
  assert.equal(xoirNode.value.metadata.sourceRefs.length, 2);
  assert.deepEqual(
    xoirNode.value.metadata.sourceRefs.map((r) => r.documentPath).sort(),
    ['a.pdf', 'z.pdf'],
  );
});

test('normalization: two structurally-equivalent inputs with different array/insertion orders normalize to the identical content hash', async () => {
  const nodeA = knowledgeNode({ semanticType: 'organization', canonicalLabel: 'Aardvark Inc' });
  const nodeB = knowledgeNode({ semanticType: 'organization', canonicalLabel: 'Zebra Corp' });
  const kg1: KnowledgeGraph = { nodes: [nodeA, nodeB], edges: [] };
  const kg2: KnowledgeGraph = { nodes: [nodeB, nodeA], edges: [] };

  const r1 = await compileXoir({ kind: 'knowledge', graph: kg1 }, { now });
  const r2 = await compileXoir({ kind: 'knowledge', graph: kg2 }, { now });
  assert.ok(r1.ok && r2.ok);
  if (!r1.ok || !r2.ok) return;
  assert.equal(r1.value.graph.contentHash(), r2.value.graph.contentHash());
});

test('normalization: exact-duplicate edges (same kind/from/to under different ids) are collapsed with provenance union, not dropped', async () => {
  const a = knowledgeNode({ semanticType: 'organization', canonicalLabel: 'Acme Corp' });
  const b = knowledgeNode({ semanticType: 'jurisdiction', canonicalLabel: 'New York' });
  const kg: KnowledgeGraph = {
    nodes: [a, b],
    edges: [
      { id: 'edge-1', type: 'located_in', fromNodeId: a.id, toNodeId: b.id, confidence: 0.7, provenance: [provenance({ documentPath: 'x.pdf' })] },
      { id: 'edge-2', type: 'located_in', fromNodeId: a.id, toNodeId: b.id, confidence: 0.6, provenance: [provenance({ documentPath: 'y.pdf' })] },
    ],
  };
  const result = await compileXoir({ kind: 'knowledge', graph: kg }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  const locatedInEdges = result.value.graph.allEdges().filter((e) => e.kind === 'LOCATED_IN');
  assert.equal(locatedInEdges.length, 1);
  assert.equal(locatedInEdges[0]!.id, 'edge-1'); // lexicographically smaller id kept
  assert.equal(locatedInEdges[0]!.metadata.sourceRefs.length, 2); // provenance from both survives
  const collapseDiagnostic = result.value.diagnostics.find((d) => d.code === 'xoir-normalization/equivalent_edges_collapsed');
  assert.ok(collapseDiagnostic);
});

test('normalization: no information is lost — node/edge/provenance counts are identical before and after normalization', async () => {
  const a = knowledgeNode({ semanticType: 'organization', canonicalLabel: 'Acme Corp', provenance: [provenance({ documentPath: 'x.pdf' })] });
  const b = knowledgeNode({ semanticType: 'jurisdiction', canonicalLabel: 'New York' });
  const kg: KnowledgeGraph = {
    nodes: [a, b],
    edges: [{ id: 'edge-1', type: 'located_in', fromNodeId: a.id, toNodeId: b.id, confidence: 0.7, provenance: [provenance()] }],
  };
  const result = await compileXoir({ kind: 'knowledge', graph: kg }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.graph.allNodes().length, 2);
  assert.equal(result.value.graph.allEdges().length, 1);
});

// --- Determinism -----------------------------------------------------------

test('determinism: running the same pipeline input twice produces an identical content hash', async () => {
  const kg: KnowledgeGraph = { nodes: [knowledgeNode({ semanticType: 'organization', canonicalLabel: 'Acme Corp' })], edges: [] };
  const r1 = await compileXoir({ kind: 'knowledge', graph: kg }, { now });
  const r2 = await compileXoir({ kind: 'knowledge', graph: kg }, { now });
  assert.ok(r1.ok && r2.ok);
  if (!r1.ok || !r2.ok) return;
  assert.equal(r1.value.graph.contentHash(), r2.value.graph.contentHash());
});

test('determinism: the combined Stage 4 + Stage 5 pipeline is deterministic end to end', async () => {
  const kNode = knowledgeNode({ semanticType: 'obligation', canonicalLabel: 'Must maintain confidentiality' });
  const kg: KnowledgeGraph = { nodes: [kNode], edges: [] };
  const cap = capability({ canonicalName: 'Draft NDA', category: 'generation', requiredKnowledgeNodeIds: [kNode.id] });
  const cg: CapabilityGraph = { capabilities: [cap], relationships: [] };

  const r1 = await compileXoir({ kind: 'combined', knowledge: kg, capability: cg }, { now });
  const r2 = await compileXoir({ kind: 'combined', knowledge: kg, capability: cg }, { now });
  assert.ok(r1.ok && r2.ok);
  if (!r1.ok || !r2.ok) return;
  assert.equal(r1.value.graph.contentHash(), r2.value.graph.contentHash());
});

// --- Provenance/confidence survive the pipeline -----------------------------

test('provenance and confidence survive validation and normalization intact', async () => {
  const node = knowledgeNode({
    semanticType: 'metric',
    canonicalLabel: 'Contract value is $2M',
    confidence: 0.73,
    provenance: [provenance({ documentPath: 'a.pdf' }), provenance({ documentPath: 'b.pdf' })],
  });
  const kg: KnowledgeGraph = { nodes: [node], edges: [] };
  const result = await compileXoir({ kind: 'knowledge', graph: kg }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  const xoirNode = result.value.graph.getNode(XoirNodeId(node.id as unknown as string));
  assert.ok(xoirNode.ok);
  if (!xoirNode.ok) return;
  assert.equal(xoirNode.value.metadata.confidence, 0.73);
  assert.equal(xoirNode.value.metadata.confidenceDetail?.corroboration, 2);
  assert.equal(xoirNode.value.metadata.sourceRefs.length, 2);
});

// --- Diagnostics -------------------------------------------------------------

test('diagnostics from every pass are aggregated in pass-execution order', async () => {
  const kg: KnowledgeGraph = { nodes: [knowledgeNode({ semanticType: 'organization', canonicalLabel: 'Acme Corp' })], edges: [] };
  const result = await compileXoir({ kind: 'knowledge', graph: kg }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  const passNames = result.value.passRuns.map((r) => r.passName);
  // As of the Stage 7 semantic validation hardening, reasoning-validation runs between generic
  // XOIR validation and normalization — see pipeline/reasoning-validate-pass.ts.
  assert.deepEqual(passNames, [XOIR_VALIDATION_PASS_NAME, REASONING_VALIDATION_PASS_NAME, XOIR_NORMALIZATION_PASS_NAME]);
});

// --- Error behavior: conversion failure -------------------------------------

test('a domain-level conversion failure (duplicate node id within one KnowledgeGraph) surfaces as a Result error, not a thrown exception', async () => {
  const node = knowledgeNode({ semanticType: 'organization', canonicalLabel: 'Acme Corp' });
  const kg: KnowledgeGraph = { nodes: [node, node], edges: [] }; // literal duplicate
  const result = await compileXoir({ kind: 'knowledge', graph: kg }, { now });
  assert.equal(result.ok, false);
});
