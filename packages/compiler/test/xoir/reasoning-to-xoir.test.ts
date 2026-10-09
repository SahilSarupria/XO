import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGraph, XoirNodeId } from '@xo/xoir';
import { extractReasoningGraph } from '../../src/reasoning/reasoning-extractor.js';
import { reasoningGraphToXoir } from '../../src/xoir/reasoning-to-xoir.js';
import { knowledgeGraphToXoir } from '../../src/xoir/knowledge-to-xoir.js';
import { capabilityGraphToXoir } from '../../src/xoir/capability-to-xoir.js';
import { computeKnowledgeNodeId } from '../../src/knowledge/node-id.js';
import { computeCapabilityId } from '../../src/capabilities/capability-id.js';
import type { KnowledgeGraph, KnowledgeNode } from '../../src/knowledge/types.js';
import type { Capability, CapabilityGraph } from '../../src/capabilities/types.js';
import { UNKNOWN_SIGNATURE } from '../../src/capabilities/types.js';
import type { ExperienceDocument, ExperienceUnit } from '../../src/semantic/types.js';

const now = () => '2026-01-01T00:00:00.000Z';

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

test('a rule node converts to a XOIR heuristic node with condition/action/exceptionConditions', async () => {
  const graph = await extractReasoningGraph(makeDoc([makeUnit('If the payment is late, apply a penalty fee.')]));
  const result = reasoningGraphToXoir(graph, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  const node = result.value.allNodes().find((n) => n.kind === 'heuristic');
  assert.ok(node);
  const props = node!.properties as { condition: string; action: string };
  assert.equal(props.condition, 'the payment is late');
  assert.equal(props.action, 'apply a penalty fee');
  assert.equal(node!.metadata.subtype, 'rule');
});

test('a decision node converts to a XOIR decision_node node', async () => {
  const graph = await extractReasoningGraph(makeDoc([makeUnit('If the customer is eligible, approve the request.')]));
  const result = reasoningGraphToXoir(graph, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  const node = result.value.allNodes().find((n) => n.kind === 'decision_node');
  assert.ok(node);
  assert.equal(node!.metadata.subtype, 'decision');
});

test('a prerequisite node converts to a XOIR constraint node with severity', async () => {
  const graph = await extractReasoningGraph(makeDoc([makeUnit('Before signing, KYC verification must be completed.')]));
  const result = reasoningGraphToXoir(graph, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  const node = result.value.allNodes().find((n) => n.kind === 'constraint');
  assert.ok(node);
  assert.equal(node!.metadata.subtype, 'prerequisite');
  const props = node!.properties as { rule: string; severity: string };
  assert.ok(['info', 'warning', 'blocking'].includes(props.severity));
});

test('a prohibition node converts to a XOIR constraint node with blocking severity', async () => {
  const graph = await extractReasoningGraph(makeDoc([makeUnit('Do not disclose confidential client information.')]));
  const result = reasoningGraphToXoir(graph, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  const node = result.value.allNodes().find((n) => n.kind === 'constraint');
  assert.ok(node);
  const props = node!.properties as { severity: string };
  assert.equal(props.severity, 'blocking');
});

test('an exception + rule pair converts with a SUPERSEDES edge (overrides -> SUPERSEDES)', async () => {
  const graph = await extractReasoningGraph(makeDoc([makeUnit('If the order is late, cancel it unless the customer has a premium subscription.')]));
  const result = reasoningGraphToXoir(graph, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  const supersedesEdges = result.value.allEdges().filter((e) => e.kind === 'SUPERSEDES');
  assert.equal(supersedesEdges.length, 1);
});

test('an alternative pair converts with an ALTERNATIVE_TO edge', async () => {
  const graph = await extractReasoningGraph(makeDoc([makeUnit('If the customer is eligible, approve the loan otherwise refer to underwriting.')]));
  const result = reasoningGraphToXoir(graph, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  const altEdges = result.value.allEdges().filter((e) => e.kind === 'ALTERNATIVE_TO');
  assert.equal(altEdges.length, 1);
});

test('the resulting XOIR graph passes structural validation', async () => {
  const graph = await extractReasoningGraph(
    makeDoc([
      makeUnit('If the payment is late, apply a penalty fee.'),
      makeUnit('Before signing, KYC verification must be completed.'),
      makeUnit('Cannot approve a request without identity verification.'),
      makeUnit('Only managers may approve refunds over $1000.'),
      makeUnit('Expedited shipping is preferred when the order value exceeds $200.'),
      makeUnit('Because the contract lacks a signature, the agreement was voided.'),
    ]),
  );
  const result = reasoningGraphToXoir(graph, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  const report = validateGraph(result.value);
  assert.equal(report.valid, true, JSON.stringify(report.issues));
});

test('provenance and confidence survive conversion', async () => {
  const graph = await extractReasoningGraph(makeDoc([makeUnit('If the payment is late, apply a penalty fee.', 'u1'), makeUnit('If the payment is late, apply a penalty fee.', 'u2')]));
  const result = reasoningGraphToXoir(graph, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  const node = result.value.allNodes().find((n) => n.kind === 'heuristic')!;
  assert.equal(node.metadata.sourceRefs.length, 2);
  assert.equal(node.metadata.confidenceDetail?.corroboration, 2);
});

test('prerequisite -> capability: best-effort linking finds a real Capability node by label match', async () => {
  const capability: Capability = {
    id: computeCapabilityId('workflow', 'Sign Contract'),
    canonicalName: 'Sign Contract',
    aliases: [],
    description: 'Signs a contract',
    category: 'workflow',
    confidence: 0.9,
    provenance: [],
    inputs: [],
    outputs: [],
    dependencies: [],
    requiredKnowledgeNodeIds: [],
    relatedConcepts: [],
    requiredPermissions: [],
    invocationHints: [],
    examples: [],
    signature: UNKNOWN_SIGNATURE,
    metadata: {},
  };
  const cGraph: CapabilityGraph = { capabilities: [capability], relationships: [] };
  const combined = capabilityGraphToXoir(cGraph, { now });
  assert.ok(combined.ok);
  if (!combined.ok) return;

  const rGraph = await extractReasoningGraph(makeDoc([makeUnit('Before Sign Contract, KYC verification must be completed.')]));
  const result = reasoningGraphToXoir(rGraph, { into: combined.value, now });
  assert.ok(result.ok);
  if (!result.ok) return;

  const requiresEdges = result.value.allEdges().filter((e) => e.kind === 'REQUIRES');
  assert.ok(requiresEdges.some((e) => e.toId === XoirNodeId(capability.id as unknown as string)));
});

test('rule -> capability: best-effort linking works for a rule whose action mentions a known capability by name', async () => {
  const knowledgeNode: KnowledgeNode = {
    id: computeKnowledgeNodeId('organization', 'Compliance Team'),
    semanticType: 'organization',
    canonicalLabel: 'Compliance Team',
    aliases: [],
    confidence: 0.9,
    provenance: [],
    metadata: {},
  };
  const kGraph: KnowledgeGraph = { nodes: [knowledgeNode], edges: [] };
  const combined = knowledgeGraphToXoir(kGraph, { now });
  assert.ok(combined.ok);
  if (!combined.ok) return;

  const rGraph = await extractReasoningGraph(makeDoc([makeUnit('If fraud is suspected, escalate to Compliance Team.')]));
  const result = reasoningGraphToXoir(rGraph, { into: combined.value, now });
  assert.ok(result.ok);
  if (!result.ok) return;

  const requiresEdges = result.value.allEdges().filter((e) => e.kind === 'REQUIRES');
  assert.ok(requiresEdges.some((e) => e.toId === XoirNodeId(knowledgeNode.id as unknown as string)));
});

test('linkReferencedNodes: false disables best-effort linking entirely', async () => {
  const capability: Capability = {
    id: computeCapabilityId('workflow', 'Sign Contract'),
    canonicalName: 'Sign Contract',
    aliases: [],
    description: 'Signs a contract',
    category: 'workflow',
    confidence: 0.9,
    provenance: [],
    inputs: [],
    outputs: [],
    dependencies: [],
    requiredKnowledgeNodeIds: [],
    relatedConcepts: [],
    requiredPermissions: [],
    invocationHints: [],
    examples: [],
    signature: UNKNOWN_SIGNATURE,
    metadata: {},
  };
  const combined = capabilityGraphToXoir({ capabilities: [capability], relationships: [] }, { now });
  assert.ok(combined.ok);
  if (!combined.ok) return;

  const rGraph = await extractReasoningGraph(makeDoc([makeUnit('Before Sign Contract, KYC verification must be completed.')]));
  const result = reasoningGraphToXoir(rGraph, { into: combined.value, now, linkReferencedNodes: false });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.allEdges().filter((e) => e.kind === 'REQUIRES').length, 0);
});

// ---------------------------------------------------------------------------
// Deterministic semantic linking (semantic-link.ts): scenarios A-F from the
// design brief, exercised end to end through reasoningGraphToXoir + a real
// capabilityGraphToXoir-built capability node, not just the pure scoreLink
// unit tests in semantic-link.test.ts.
// ---------------------------------------------------------------------------

function makeCapability(name: string, unitId: string, overrides: Partial<Capability> = {}): Capability {
  return {
    id: computeCapabilityId('insurance', name),
    canonicalName: name,
    aliases: [],
    description: `Handles ${name.toLowerCase()}`,
    category: 'analysis',
    confidence: 0.65,
    provenance: [{ experienceUnitId: unitId, documentPath: 'doc.pdf', pages: [1], sectionPath: [name], charOffsetRange: [0, 10], confidence: 0.65 }],
    inputs: [],
    outputs: [],
    dependencies: [],
    requiredKnowledgeNodeIds: [],
    relatedConcepts: [],
    requiredPermissions: [],
    invocationHints: [],
    examples: [],
    signature: UNKNOWN_SIGNATURE,
    metadata: {},
    ...overrides,
  };
}

test('scenario A (exact match): "Claim Assessment" capability links to a same-worded IF/THEN rule regardless of unit', async () => {
  const capability = makeCapability('Claim Assessment', 'unit-capability');
  const combined = capabilityGraphToXoir({ capabilities: [capability], relationships: [] }, { now });
  assert.ok(combined.ok);
  if (!combined.ok) return;

  const rGraph = await extractReasoningGraph(makeDoc([makeUnit('If the claim assessment amount exceeds 5000, then reject the claim.', 'unit-rule')]));
  const result = reasoningGraphToXoir(rGraph, { into: combined.value, now });
  assert.ok(result.ok);
  if (!result.ok) return;

  const edge = result.value.allEdges().find((e) => e.kind === 'REQUIRES' && e.toId === XoirNodeId(capability.id as unknown as string));
  assert.ok(edge);
  assert.equal(edge!.metadata.custom['evidenceKind'], 'exact_label');
  assert.equal(edge!.metadata.confidenceDetail?.basis, 'observed');
});

test('scenario B (normalized/same-unit match): links when co-located with the capability and sharing real vocabulary, even with no exact label substring', async () => {
  const capability = makeCapability('Claim Assessment', 'unit-shared');
  const combined = capabilityGraphToXoir({ capabilities: [capability], relationships: [] }, { now });
  assert.ok(combined.ok);
  if (!combined.ok) return;

  const rGraph = await extractReasoningGraph(makeDoc([makeUnit('If the amount claimed exceeds 5000, then reject the claim.', 'unit-shared')]));
  const result = reasoningGraphToXoir(rGraph, { into: combined.value, now });
  assert.ok(result.ok);
  if (!result.ok) return;

  const edge = result.value.allEdges().find((e) => e.kind === 'REQUIRES' && e.toId === XoirNodeId(capability.id as unknown as string));
  assert.ok(edge);
  assert.equal(edge!.metadata.custom['evidenceKind'], 'same_unit_term_overlap');
  assert.equal(edge!.metadata.confidenceDetail?.basis, 'inferred');
  assert.ok((edge!.metadata.confidenceDetail?.score ?? 0) < 0.85);
});

test('scenario C (synonym-like but unsafe): a differently-worded, differently-located rule is NOT linked — insufficient evidence, left unlinked', async () => {
  const capability = makeCapability('Claim Assessment', 'unit-capability');
  const combined = capabilityGraphToXoir({ capabilities: [capability], relationships: [] }, { now });
  assert.ok(combined.ok);
  if (!combined.ok) return;

  const rGraph = await extractReasoningGraph(makeDoc([makeUnit('Warranted that claims above 5000 may be rejected at the insurer\u2019s discretion.', 'unit-elsewhere')]));
  const result = reasoningGraphToXoir(rGraph, { into: combined.value, now });
  assert.ok(result.ok);
  if (!result.ok) return;

  const edge = result.value.allEdges().find((e) => e.kind === 'REQUIRES' && e.toId === XoirNodeId(capability.id as unknown as string));
  assert.equal(edge, undefined);
});

test('scenario D (same-document false positive): an unrelated capability and rule co-occurring in one document must not link', async () => {
  const capability = makeCapability('Contact 24-Hour Call Centre', 'unit-callcentre');
  const combined = capabilityGraphToXoir({ capabilities: [capability], relationships: [] }, { now });
  assert.ok(combined.ok);
  if (!combined.ok) return;

  const rGraph = await extractReasoningGraph(makeDoc([makeUnit('Warranted that claims above 5000 may be rejected at the insurer\u2019s discretion.', 'unit-claims')]));
  const result = reasoningGraphToXoir(rGraph, { into: combined.value, now });
  assert.ok(result.ok);
  if (!result.ok) return;

  const edge = result.value.allEdges().find((e) => e.kind === 'REQUIRES' && e.toId === XoirNodeId(capability.id as unknown as string));
  assert.equal(edge, undefined);
});

test('scenario E (similar labels not collapsed): "Policy", "Policy Copy", "Policy Schedule", and "Policy Number" are four distinct capability nodes that each link only on their own evidence', async () => {
  const policy = makeCapability('Policy', 'unit-a');
  const policyCopy = makeCapability('Policy Copy', 'unit-b');
  const policySchedule = makeCapability('Policy Schedule', 'unit-c');
  const policyNumber = makeCapability('Policy Number', 'unit-d');
  const combined = capabilityGraphToXoir({ capabilities: [policy, policyCopy, policySchedule, policyNumber], relationships: [] }, { now });
  assert.ok(combined.ok);
  if (!combined.ok) return;

  const rGraph = await extractReasoningGraph(makeDoc([makeUnit('Warranted that a valid Policy Copy must be retained by the insured.', 'unit-b')]));
  const result = reasoningGraphToXoir(rGraph, { into: combined.value, now });
  assert.ok(result.ok);
  if (!result.ok) return;

  const linkedTargets = new Set(result.value.allEdges().filter((e) => e.kind === 'REQUIRES').map((e) => e.toId));
  assert.ok(linkedTargets.has(XoirNodeId(policyCopy.id as unknown as string)), 'the exact-worded "Policy Copy" capability should link');
  // "Policy" (the bare, generic word) legitimately exact-substring-matches too — that's correct, unchanged behavior, not a false collapse of distinct entities.
  assert.ok(linkedTargets.has(XoirNodeId(policy.id as unknown as string)), '"Policy" exact-substring-matches "...a valid Policy Copy..." — expected, unrelated to entity collapsing');
  // The real point of this scenario: "Policy Schedule" and "Policy Number" are NOT collapsed with "Policy Copy" just because they share the word "Policy" — no exact phrase match, different unit, so no link at all.
  assert.ok(!linkedTargets.has(XoirNodeId(policySchedule.id as unknown as string)), '"Policy Schedule" (different unit, different wording) must not link');
  assert.ok(!linkedTargets.has(XoirNodeId(policyNumber.id as unknown as string)), '"Policy Number" (different unit, different wording) must not link');
});

test('scenario F (different sections, identical terms): shared vocabulary across unrelated sections does not automatically link', async () => {
  const capability = makeCapability('Warranty Compliance', 'unit-warranties');
  const combined = capabilityGraphToXoir({ capabilities: [capability], relationships: [] }, { now });
  assert.ok(combined.ok);
  if (!combined.ok) return;

  // Shares "warranted"/"compliance"-adjacent vocabulary with the capability's own label/description, but was extracted from a completely different section/unit.
  const rGraph = await extractReasoningGraph(makeDoc([makeUnit('Warranted that the building complies with local fire safety regulations.', 'unit-fire-safety')]));
  const result = reasoningGraphToXoir(rGraph, { into: combined.value, now });
  assert.ok(result.ok);
  if (!result.ok) return;

  const edge = result.value.allEdges().find((e) => e.kind === 'REQUIRES' && e.toId === XoirNodeId(capability.id as unknown as string));
  assert.equal(edge, undefined);
});

test('execution authority boundary: a same-unit-linked but non-deterministic rule keeps the capability UNRESOLVED, never silently promoted to RESOLVED', async () => {
  // The linker correctly finds a real relationship the old exact-substring rule would have missed entirely...
  const capability = makeCapability('Claim Assessment', 'unit-mixed');
  const combined = capabilityGraphToXoir({ capabilities: [capability], relationships: [] }, { now });
  assert.ok(combined.ok);
  if (!combined.ok) return;

  const rGraph = await extractReasoningGraph(
    makeDoc([makeUnit('If the claim assessment amount exceeds 5000, then reject the claim.\n\nSubject to satisfactory proof of loss, the insurer will process the claim within 14 days.', 'unit-mixed')]),
  );
  const result = reasoningGraphToXoir(rGraph, { into: combined.value, now });
  assert.ok(result.ok);
  if (!result.ok) return;

  const edges = result.value.allEdges().filter((e) => e.kind === 'REQUIRES' && e.toId === XoirNodeId(capability.id as unknown as string));
  // ...both the deterministic decision AND the non-deterministic "subject to" obligation are now linked (better semantic relationships)...
  assert.equal(edges.length, 2);

  // ...but that must never, by itself, change what the (untouched) capability-contract resolver decides. This test asserts the graph shape only — see synthetic-property-policy-quality.test.ts's package-level regression test for the corresponding lowerCapabilitiesToManifest assertion (unresolved, because the "subject to" rule has no outcome for a deterministic evaluator to return).
  const validation = validateGraph(result.value);
  assert.equal(validation.valid, true);
});

test('conversion is deterministic given a fixed now', async () => {
  const doc = makeDoc([makeUnit('If the payment is late, apply a penalty fee.')]);
  const graph = await extractReasoningGraph(doc);
  const r1 = reasoningGraphToXoir(graph, { now });
  const r2 = reasoningGraphToXoir(graph, { now });
  assert.ok(r1.ok && r2.ok);
  if (!r1.ok || !r2.ok) return;
  assert.equal(r1.value.contentHash(), r2.value.contentHash());
});

test('an edge whose endpoint is missing is skipped rather than failing the whole conversion', async () => {
  const graph = await extractReasoningGraph(makeDoc([makeUnit('If the order is late, cancel it unless the customer has a premium subscription.')]));
  const filtered = { nodes: graph.nodes.filter((n) => n.nodeType !== 'exception'), edges: graph.edges };
  const result = reasoningGraphToXoir(filtered, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.allEdges().filter((e) => e.kind === 'SUPERSEDES').length, 0);
});

// --- Phase 2: structured semantic expressions on XOIR node properties ---

test('Phase 2: a decision_node carries structuredCondition/structuredAction on its XOIR properties, validating cleanly', async () => {
  const graph = await extractReasoningGraph(makeDoc([makeUnit('If the claim assessment amount exceeds 10000, then deny the claim.')]));
  const result = reasoningGraphToXoir(graph, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  const node = result.value.allNodes().find((n) => n.kind === 'decision_node');
  assert.ok(node);
  const props = node!.properties as { structuredCondition?: unknown; structuredAction?: unknown };
  assert.deepEqual(props.structuredCondition, { type: 'comparison', field: 'the claim assessment amount', operator: '>', value: 10000 });
  assert.deepEqual(props.structuredAction, { type: 'action', action: 'deny', target: 'the claim' });
  const validation = validateGraph(result.value);
  assert.equal(validation.valid, true);
});

test('Phase 2: a constraint node carries structuredCondition (projected from its `action`/rule text) but never a structuredAction — constraint has no action slot', async () => {
  const graph = await extractReasoningGraph(makeDoc([makeUnit('Terrorism cover is excluded.')]));
  const result = reasoningGraphToXoir(graph, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  const node = result.value.allNodes().find((n) => n.kind === 'constraint');
  assert.ok(node);
  const props = node!.properties as { structuredCondition?: unknown; structuredAction?: unknown };
  assert.deepEqual(props.structuredCondition, { type: 'categorical', field: 'Terrorism cover', operator: '==', value: 'excluded' });
  assert.equal(props.structuredAction, undefined);
});

test('Phase 2: a node with no confidently-structurable text has no structuredCondition/structuredAction key at all on its XOIR properties', async () => {
  const graph = await extractReasoningGraph(makeDoc([makeUnit('If the customer was treated unfairly, escalate the matter.')]));
  const result = reasoningGraphToXoir(graph, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  const node = result.value.allNodes().find((n) => n.kind === 'heuristic' || n.kind === 'decision_node');
  assert.ok(node);
  assert.ok(!('structuredCondition' in node!.properties));
});

test('Phase 2: reasoning_step/escalation_rule/risk_policy XOIR kinds never gain a structuredCondition key (out of scope — no slot exists for them)', async () => {
  // justification -> reasoning_step
  const graph = await extractReasoningGraph(makeDoc([makeUnit('Because the applicant has a clean record, the request was approved.')]));
  const result = reasoningGraphToXoir(graph, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  const reasoningStepNode = result.value.allNodes().find((n) => n.kind === 'reasoning_step');
  if (reasoningStepNode) assert.ok(!('structuredCondition' in reasoningStepNode.properties));
});

test('Phase 2: conversion remains deterministic given a fixed now, with structured fields present', async () => {
  const doc = makeDoc([makeUnit('If the claim assessment amount exceeds 10000, then deny the claim.')]);
  const graph = await extractReasoningGraph(doc);
  const r1 = reasoningGraphToXoir(graph, { now });
  const r2 = reasoningGraphToXoir(graph, { now });
  assert.ok(r1.ok && r2.ok);
  if (!r1.ok || !r2.ok) return;
  assert.equal(r1.value.contentHash(), r2.value.contentHash());
});
