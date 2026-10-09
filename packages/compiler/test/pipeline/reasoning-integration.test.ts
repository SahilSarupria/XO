import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirNodeId } from '@xo/xoir';
import { compileXoir } from '../../src/pipeline/compile.js';
import { extractReasoningGraph } from '../../src/reasoning/reasoning-extractor.js';
import { computeKnowledgeNodeId } from '../../src/knowledge/node-id.js';
import { computeCapabilityId } from '../../src/capabilities/capability-id.js';
import type { KnowledgeGraph, KnowledgeNode, KnowledgeProvenance } from '../../src/knowledge/types.js';
import type { Capability, CapabilityGraph } from '../../src/capabilities/types.js';
import { UNKNOWN_SIGNATURE } from '../../src/capabilities/types.js';
import type { ExperienceDocument, ExperienceUnit } from '../../src/semantic/types.js';

const now = () => '2026-01-01T00:00:00.000Z';

function unitProvenance(overrides: Partial<KnowledgeProvenance> = {}): KnowledgeProvenance {
  return { experienceUnitId: 'u1', documentPath: 'doc.pdf', pages: [1], sectionPath: ['Article 1'], charOffsetRange: [0, 5], confidence: 0.9, ...overrides };
}

function knowledgeNode(overrides: Partial<KnowledgeNode> & { canonicalLabel: string; semanticType: KnowledgeNode['semanticType'] }): KnowledgeNode {
  return {
    id: overrides.id ?? computeKnowledgeNodeId(overrides.semanticType, overrides.canonicalLabel),
    semanticType: overrides.semanticType,
    canonicalLabel: overrides.canonicalLabel,
    aliases: overrides.aliases ?? [],
    confidence: overrides.confidence ?? 0.8,
    provenance: overrides.provenance ?? [unitProvenance()],
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
    provenance: overrides.provenance ?? [unitProvenance()],
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

function makeUnit(content: string, id = 'u1'): ExperienceUnit {
  return {
    id: id as ExperienceUnit['id'],
    title: 'Unit',
    semanticType: 'clause',
    content,
    provenance: { documentPath: 'doc.pdf', pages: [1], sectionPath: ['Article 1'], blockProvenance: [], blockIndexRange: [0, 0] },
    hierarchy: { depth: 1, parentUnitId: undefined, siblingUnitIds: [] },
    confidence: 0.9,
    relationships: [],
    documentReferences: [],
    metadata: {},
  };
}

function makeDoc(units: readonly ExperienceUnit[]): ExperienceDocument {
  return { documentPath: 'doc.pdf', documentTitle: 'Doc', units, relationshipGraph: { relationships: [] } };
}

test('pipeline: reasoning-only input converts, validates, and normalizes through compileXoir()', async () => {
  const reasoning = await extractReasoningGraph(makeDoc([makeUnit('If the payment is late, apply a penalty fee.')]));
  const result = await compileXoir({ kind: 'knowledge', graph: { nodes: [], edges: [] }, reasoning }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.valid, true);
  assert.ok(result.value.graph.allNodes().some((n) => n.kind === 'heuristic'));
});

test('pipeline: Stage 4 + Stage 5 + Stage 7 combined input compiles to a validated, normalized XOIR graph', async () => {
  const kNode = knowledgeNode({ semanticType: 'organization', canonicalLabel: 'Sign Contract Capability' });
  const cap = capability({ canonicalName: 'Sign Contract', category: 'workflow' });
  const reasoning = await extractReasoningGraph(makeDoc([makeUnit('Before Sign Contract, KYC verification must be completed.')]));

  const result = await compileXoir(
    {
      kind: 'combined',
      knowledge: { nodes: [kNode], edges: [] },
      capability: { capabilities: [cap], relationships: [] },
      reasoning,
    },
    { now },
  );

  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.valid, true, JSON.stringify(result.value.validation.issues));

  const graph = result.value.graph;
  assert.ok(graph.allNodes().some((n) => n.kind === 'concept'));
  assert.ok(graph.allNodes().some((n) => n.kind === 'capability'));
  assert.ok(graph.allNodes().some((n) => n.kind === 'constraint')); // the prerequisite

  // Best-effort linking should have connected the prerequisite constraint to the real capability node.
  const requiresEdges = graph.allEdges().filter((e) => e.kind === 'REQUIRES');
  const capabilityNode = graph.allNodes().find((n) => n.kind === 'capability')!;
  assert.ok(requiresEdges.some((e) => e.toId === capabilityNode.id));
});

test('pipeline: reasoning enrichment survives validation and normalization with correct diagnostics/passRuns', async () => {
  const reasoning = await extractReasoningGraph(makeDoc([makeUnit('Cannot approve a request without identity verification.')]));
  const result = await compileXoir({ kind: 'capability', graph: { capabilities: [], relationships: [] }, reasoning }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(
    result.value.diagnostics.some((d) => d.severity === 'error'),
    false,
  );
  assert.equal(result.value.passRuns.length, 3);
});

test('determinism: the combined Stage 4 + 5 + 7 pipeline produces an identical content hash across repeated runs', async () => {
  const kNode = knowledgeNode({ semanticType: 'organization', canonicalLabel: 'Sign Contract Capability' });
  const cap = capability({ canonicalName: 'Sign Contract', category: 'workflow' });
  const reasoning = await extractReasoningGraph(makeDoc([makeUnit('Before Sign Contract, KYC verification must be completed.')]));
  const input = { kind: 'combined' as const, knowledge: { nodes: [kNode], edges: [] }, capability: { capabilities: [cap], relationships: [] }, reasoning };

  const r1 = await compileXoir(input, { now });
  const r2 = await compileXoir(input, { now });
  assert.ok(r1.ok && r2.ok);
  if (!r1.ok || !r2.ok) return;
  assert.equal(r1.value.graph.contentHash(), r2.value.graph.contentHash());
});

test('an invalid reasoning-derived XOIR graph (constructed directly, bypassing the extractor) is caught by pipeline validation and stops before normalization', async () => {
  // Use the 'xoir' escape hatch to hand the pipeline an already-broken graph shaped like Stage 7 output,
  // proving validation genuinely covers reasoning-derived node kinds too, not just knowledge/capability ones.
  const { XoirGraph, XoirGraphId, XoirNodeId } = await import('@xo/xoir');
  const graph = XoirGraph.create(XoirGraphId('bad-reasoning'));
  graph.createAndAddNode({ id: XoirNodeId('n1'), kind: 'heuristic', properties: {}, now }); // missing required condition/action
  const result = await compileXoir({ kind: 'xoir', graph }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.valid, false);
});

// ---------------------------------------------------------------------------
// Composite: a Stage 4 knowledge-stage rule node and a Stage 7 reasoning-stage
// rule node both link to the *same* capability, from one compiled document.
// Proves the two linking passes (rule-capability-linking.ts, invoked once
// from knowledge-to-xoir.ts's collected sources and once from
// reasoning-to-xoir.ts's own) don't collide on edge ids and don't produce a
// duplicate/double-counted SemanticCapabilityRule for either source node —
// i.e. the general shape of "10 discovered -> some genuinely deterministic,
// some correctly left unresolved" the real benchmark PDF exercises.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Regression proof for the clause-number stripping fix
// (rule-pattern-parser.ts#stripLeadingClauseNumber): the exact real-world
// sentence shape from XO_Commercial_Property_Test_Policy_Compatible.pdf now
// reaches Stage 7 extraction as an outcome-bearing rule/heuristic node, end
// to end through the real ReasoningGraph extractor and XOIR conversion —
// not just at the parseSentence unit-test level.
// ---------------------------------------------------------------------------

test('a numbered real-world "N.N If A, B." clause becomes an outcome-bearing rule node through full reasoning extraction, not just parseSentence in isolation', async () => {
  const reasoning = await extractReasoningGraph(
    makeDoc([makeUnit('7.1 If the claim amount is greater than INR 10,000 and all required documents are present, manager approval is required.')]),
  );
  const ruleNode = reasoning.nodes.find((n) => n.nodeType === 'rule' || n.nodeType === 'decision');
  assert.ok(ruleNode, `expected a rule/decision node; got kinds: ${reasoning.nodes.map((n) => n.nodeType).join(', ')}`);
  assert.equal(ruleNode!.condition, 'the claim amount is greater than INR 10,000 and all required documents are present');
  assert.ok(ruleNode!.action !== undefined && ruleNode!.action.length > 0, 'expected a non-empty action/outcome');

  const result = await compileXoir({ kind: 'knowledge', graph: { nodes: [], edges: [] }, reasoning }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  const xoirNode = result.value.graph.allNodes().find((n) => n.kind === 'heuristic' || n.kind === 'decision_node');
  assert.ok(xoirNode, `expected a heuristic/decision_node XOIR node; got kinds: ${result.value.graph.allNodes().map((n) => n.kind).join(', ')}`);
  // The whole point: this node now has a real, non-fabricated outcome — pulled straight from
  // the source sentence's own action clause, never invented — so it is structurally eligible
  // for deterministic resolution (whether the comparison grammar can actually parse "greater
  // than INR 10,000" is downstream of this task's scope, per the investigation brief).
  const outcome = (xoirNode!.properties as { readonly action?: string }).action;
  assert.ok(outcome !== undefined && outcome.length > 0);
});

test('a knowledge-stage constraint and a reasoning-stage prerequisite both link to the same capability without edge-id collision or duplicate rules', async () => {
  const kNode = knowledgeNode({ semanticType: 'constraint', canonicalLabel: 'Sign Contract requires notarization before execution', provenance: [unitProvenance({ experienceUnitId: 'u-knowledge' })] });
  const cap = capability({ canonicalName: 'Sign Contract', category: 'workflow', provenance: [unitProvenance({ experienceUnitId: 'u-capability' })] });
  const reasoning = await extractReasoningGraph(makeDoc([makeUnit('Before Sign Contract, KYC verification must be completed.')]));

  const result = await compileXoir(
    { kind: 'combined', knowledge: { nodes: [kNode], edges: [] }, capability: { capabilities: [cap], relationships: [] }, reasoning },
    { now },
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.valid, true, JSON.stringify(result.value.validation.issues));

  const graph = result.value.graph;
  const capabilityNode = graph.allNodes().find((n) => n.kind === 'capability')!;
  const requiresEdges = graph.allEdges().filter((e) => e.kind === 'REQUIRES' && e.toId === capabilityNode.id);
  // The knowledge-stage constraint (exact-label: its own canonicalLabel contains "Sign Contract")
  // and the reasoning-stage prerequisite constraint each produce their own distinct edge.
  assert.ok(requiresEdges.some((e) => e.fromId === XoirNodeId(kNode.id as unknown as string)));
  const reasoningConstraintNode = graph.allNodes().find((n) => n.kind === 'constraint' && n.id !== XoirNodeId(kNode.id as unknown as string));
  assert.ok(reasoningConstraintNode, 'expected the reasoning-extracted prerequisite constraint node too');
  assert.ok(requiresEdges.some((e) => e.fromId === reasoningConstraintNode!.id));

  const { buildSemanticCapabilityContract } = await import('@xo/capability-contract');
  const contractResult = buildSemanticCapabilityContract(graph, capabilityNode.id);
  assert.ok(contractResult.ok);
  if (!contractResult.ok) return;
  const ruleSourceIds = contractResult.value.rules.map((r) => r.sourceNodeId).sort();
  assert.deepEqual(ruleSourceIds, [kNode.id, reasoningConstraintNode!.id as unknown as string].sort());
});
