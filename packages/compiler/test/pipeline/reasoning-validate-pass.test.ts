import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId, PassManager, type PassContext } from '@xo/xoir';
import { createReasoningValidationPass, REASONING_VALIDATION_PASS_NAME } from '../../src/pipeline/reasoning-validate-pass.js';
import { createXoirValidationPass, XOIR_VALIDATION_PASS_NAME } from '../../src/pipeline/validate-pass.js';
import { extractReasoningGraph } from '../../src/reasoning/reasoning-extractor.js';
import { reasoningGraphToXoir } from '../../src/xoir/reasoning-to-xoir.js';
import { compileXoir } from '../../src/pipeline/compile.js';
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

async function runPass(graph: XoirGraph) {
  const manager = new PassManager();
  manager.register(createReasoningValidationPass());
  const result = await manager.run(graph);
  assert.ok(result.ok);
  return result.ok ? result.value.diagnostics : [];
}

// --- Valid structures --------------------------------------------------------

test('valid decision node produces no diagnostics', async () => {
  const graph = await extractReasoningGraph(makeDoc([makeUnit('If the customer is eligible, approve the request.')]));
  const xoir = reasoningGraphToXoir(graph, { now });
  assert.ok(xoir.ok);
  if (!xoir.ok) return;
  const diagnostics = await runPass(xoir.value);
  assert.equal(diagnostics.length, 0);
});

test('valid rule node produces no diagnostics', async () => {
  const graph = await extractReasoningGraph(makeDoc([makeUnit('If the payment is late, apply a penalty fee.')]));
  const xoir = reasoningGraphToXoir(graph, { now });
  assert.ok(xoir.ok);
  if (!xoir.ok) return;
  const diagnostics = await runPass(xoir.value);
  assert.equal(diagnostics.length, 0);
});

test('valid prerequisite produces no diagnostics', async () => {
  const graph = await extractReasoningGraph(makeDoc([makeUnit('Before signing, KYC verification must be completed.')]));
  const xoir = reasoningGraphToXoir(graph, { now });
  assert.ok(xoir.ok);
  if (!xoir.ok) return;
  const diagnostics = await runPass(xoir.value);
  assert.equal(diagnostics.length, 0);
});

test('valid alternative (IF/THEN/ELSE) produces no diagnostics', async () => {
  const graph = await extractReasoningGraph(makeDoc([makeUnit('If the customer is eligible, approve the loan otherwise refer to underwriting.')]));
  const xoir = reasoningGraphToXoir(graph, { now });
  assert.ok(xoir.ok);
  if (!xoir.ok) return;
  const diagnostics = await runPass(xoir.value);
  assert.equal(diagnostics.length, 0);
});

test('valid exception/override (inline UNLESS) produces no diagnostics', async () => {
  const graph = await extractReasoningGraph(makeDoc([makeUnit('If the order is late, cancel it unless the customer has a premium subscription.')]));
  const xoir = reasoningGraphToXoir(graph, { now });
  assert.ok(xoir.ok);
  if (!xoir.ok) return;
  const diagnostics = await runPass(xoir.value);
  assert.equal(diagnostics.length, 0);
});

test('valid reasoning relationship (justification) produces no diagnostics', async () => {
  const graph = await extractReasoningGraph(makeDoc([makeUnit('Because the contract lacks a signature, the agreement was voided.')]));
  const xoir = reasoningGraphToXoir(graph, { now });
  assert.ok(xoir.ok);
  if (!xoir.ok) return;
  const diagnostics = await runPass(xoir.value);
  assert.equal(diagnostics.length, 0);
});

// --- Invalid structures -------------------------------------------------------

test('malformed decision (blank question) is flagged with DECISION_MISSING_REQUIRED_STRUCTURE', async () => {
  const graph = XoirGraph.create(XoirGraphId('g'));
  graph.createAndAddNode({ id: XoirNodeId('d1'), kind: 'decision_node', subtype: 'decision', properties: { question: '  ', outcome: 'approve', rationale: '' }, now });
  const diagnostics = await runPass(graph);
  assert.ok(diagnostics.some((d) => d.code === 'DECISION_MISSING_REQUIRED_STRUCTURE'));
  assert.equal(diagnostics[0]!.nodeId, XoirNodeId('d1'));
  assert.equal(diagnostics[0]!.severity, 'error');
  assert.equal(diagnostics[0]!.passName, REASONING_VALIDATION_PASS_NAME);
});

test('malformed decision (blank outcome) is flagged', async () => {
  const graph = XoirGraph.create(XoirGraphId('g'));
  graph.createAndAddNode({ id: XoirNodeId('d1'), kind: 'decision_node', subtype: 'decision', properties: { question: 'is eligible?', outcome: '', rationale: '' }, now });
  const diagnostics = await runPass(graph);
  assert.ok(diagnostics.some((d) => d.code === 'DECISION_MISSING_REQUIRED_STRUCTURE'));
});

test('malformed rule (blank condition) is flagged with RULE_MISSING_REQUIRED_STRUCTURE', async () => {
  const graph = XoirGraph.create(XoirGraphId('g'));
  graph.createAndAddNode({ id: XoirNodeId('r1'), kind: 'heuristic', subtype: 'rule', properties: { condition: '', action: 'apply penalty', exceptionConditions: [] }, now });
  const diagnostics = await runPass(graph);
  assert.ok(diagnostics.some((d) => d.code === 'RULE_MISSING_REQUIRED_STRUCTURE'));
});

test('malformed prerequisite (blank rule text) is flagged with REASONING_INVALID_STRUCTURE', async () => {
  const graph = XoirGraph.create(XoirGraphId('g'));
  graph.createAndAddNode({ id: XoirNodeId('p1'), kind: 'constraint', subtype: 'prerequisite', properties: { rule: '   ', severity: 'warning' }, now });
  const diagnostics = await runPass(graph);
  assert.ok(diagnostics.some((d) => d.code === 'REASONING_INVALID_STRUCTURE'));
});

test('unresolved/invalid ALTERNATIVE_TO target (not a decision_node) is flagged with INVALID_REASONING_RELATIONSHIP', async () => {
  const graph = XoirGraph.create(XoirGraphId('g'));
  graph.createAndAddNode({ id: XoirNodeId('d1'), kind: 'decision_node', subtype: 'decision', properties: { question: 'q', outcome: 'approve', rationale: '' }, now });
  graph.createAndAddNode({ id: XoirNodeId('f1'), kind: 'fact', properties: { statement: 's', domain: 'd' }, now });
  graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'ALTERNATIVE_TO', fromId: XoirNodeId('d1'), toId: XoirNodeId('f1'), now });
  const diagnostics = await runPass(graph);
  assert.ok(diagnostics.some((d) => d.code === 'INVALID_REASONING_RELATIONSHIP' && d.edgeId === XoirEdgeId('e1')));
});

test('malformed alternative/exception: an override (SUPERSEDES) targeting a bare fact node is flagged', async () => {
  const graph = XoirGraph.create(XoirGraphId('g'));
  graph.createAndAddNode({ id: XoirNodeId('exc'), kind: 'heuristic', subtype: 'exception', properties: { condition: 'c', action: 'a', exceptionConditions: [] }, now });
  graph.createAndAddNode({ id: XoirNodeId('f1'), kind: 'fact', properties: { statement: 's', domain: 'd' }, now });
  graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'SUPERSEDES', fromId: XoirNodeId('exc'), toId: XoirNodeId('f1'), now });
  const diagnostics = await runPass(graph);
  assert.ok(diagnostics.some((d) => d.code === 'INVALID_REASONING_RELATIONSHIP' && d.edgeId === XoirEdgeId('e1')));
});

test('a self-referential reasoning edge is flagged', async () => {
  const graph = XoirGraph.create(XoirGraphId('g'));
  graph.createAndAddNode({ id: XoirNodeId('r1'), kind: 'heuristic', subtype: 'rule', properties: { condition: 'c', action: 'a', exceptionConditions: [] }, now });
  graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'REQUIRES', fromId: XoirNodeId('r1'), toId: XoirNodeId('r1'), now });
  const diagnostics = await runPass(graph);
  assert.ok(diagnostics.some((d) => d.code === 'INVALID_REASONING_RELATIONSHIP'));
});

// --- No false positives -------------------------------------------------------

test('a valid override (SUPERSEDES) targeting a real rule is NOT flagged', async () => {
  const graph = await extractReasoningGraph(makeDoc([makeUnit('If the order is late, cancel it unless the customer has a premium subscription.')]));
  const xoir = reasoningGraphToXoir(graph, { now });
  assert.ok(xoir.ok);
  if (!xoir.ok) return;
  const diagnostics = await runPass(xoir.value);
  assert.equal(
    diagnostics.filter((d) => d.code === 'INVALID_REASONING_RELATIONSHIP').length,
    0,
  );
});

test('Stage 4/5 content (concept/capability nodes, no Stage 7 subtype) is never touched by this pass, even when structurally minimal', async () => {
  const graph = XoirGraph.create(XoirGraphId('g'));
  graph.createAndAddNode({ id: XoirNodeId('c1'), kind: 'concept', properties: { definition: 'x' }, now });
  graph.createAndAddNode({ id: XoirNodeId('cap1'), kind: 'capability', properties: { name: 'X', description: 'd' }, now });
  graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'REQUIRES', fromId: XoirNodeId('cap1'), toId: XoirNodeId('c1'), now });
  const diagnostics = await runPass(graph);
  assert.equal(diagnostics.length, 0);
});

test('a SUPERSEDES edge with no Stage 7-sourced endpoint at all is not checked by this pass (out of scope, per doc comment)', async () => {
  const graph = XoirGraph.create(XoirGraphId('g'));
  graph.createAndAddNode({ id: XoirNodeId('a'), kind: 'concept', properties: { definition: 'a' }, now });
  graph.createAndAddNode({ id: XoirNodeId('b'), kind: 'fact', properties: { statement: 'b', domain: 'd' }, now });
  graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'SUPERSEDES', fromId: XoirNodeId('a'), toId: XoirNodeId('b'), now });
  const diagnostics = await runPass(graph);
  assert.equal(diagnostics.length, 0);
});

test('a unit that produces no structured reasoning at all is not an error (ambiguous input remains unstructured, not invalid)', async () => {
  const graph = await extractReasoningGraph(makeDoc([makeUnit('The weather was pleasant that afternoon.'), makeUnit('Management generally prefers option A.'), makeUnit('The decision was complex.')]));
  assert.equal(graph.nodes.length, 0);
  const xoir = reasoningGraphToXoir(graph, { now });
  assert.ok(xoir.ok);
  if (!xoir.ok) return;
  const diagnostics = await runPass(xoir.value);
  assert.equal(diagnostics.length, 0);
});

test('a decision_node with an honestly-absent rationale (not blank required fields) is NOT flagged', async () => {
  const graph = XoirGraph.create(XoirGraphId('g'));
  graph.createAndAddNode({ id: XoirNodeId('d1'), kind: 'decision_node', subtype: 'decision', properties: { question: 'is eligible?', outcome: 'approve', rationale: '' }, now });
  const diagnostics = await runPass(graph);
  assert.equal(diagnostics.length, 0);
});

// --- Pipeline integration ------------------------------------------------------

test('compileXoir() actually runs the reasoning semantic validation pass, not just a unit-test helper', async () => {
  const graph = XoirGraph.create(XoirGraphId('bad'));
  graph.createAndAddNode({ id: XoirNodeId('d1'), kind: 'decision_node', subtype: 'decision', properties: { question: '', outcome: 'approve', rationale: '' }, now });
  const result = await compileXoir({ kind: 'xoir', graph }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.valid, false);
  assert.ok(result.value.diagnostics.some((d) => d.code === 'DECISION_MISSING_REQUIRED_STRUCTURE'));
  assert.ok(result.value.passRuns.every((r) => r.passName !== 'xoir-normalization'));
});

test('compileXoir() lets a structurally AND semantically valid graph proceed through normalization', async () => {
  const graph = await extractReasoningGraph(makeDoc([makeUnit('If the payment is late, apply a penalty fee.')]));
  const result = await compileXoir({ kind: 'knowledge', graph: { nodes: [], edges: [] }, reasoning: graph }, { now });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.valid, true);
  assert.ok(result.value.passRuns.some((r) => r.passName === REASONING_VALIDATION_PASS_NAME));
  assert.ok(result.value.passRuns.some((r) => r.passName === 'xoir-normalization'));
});

test('generic structural validation still runs first and is still reused, not duplicated', async () => {
  const manager = new PassManager();
  manager.register(createXoirValidationPass());
  manager.register(createReasoningValidationPass());
  const graph = XoirGraph.create(XoirGraphId('bad'));
  graph.createAndAddNode({ id: XoirNodeId('d1'), kind: 'decision_node', properties: {}, now });
  const result = await manager.run(graph);
  assert.ok(result.ok);
  if (!result.ok) return;
  const passNames = result.value.runs.map((r) => r.passName);
  assert.deepEqual(passNames, [XOIR_VALIDATION_PASS_NAME, REASONING_VALIDATION_PASS_NAME]);
  assert.ok(result.value.diagnostics.some((d) => d.code?.startsWith('xoir-validation/')));
});

// --- Determinism -----------------------------------------------------------

test('diagnostics are deterministic: repeated runs on the same graph produce identical diagnostic ordering', async () => {
  const graph = XoirGraph.create(XoirGraphId('g'));
  graph.createAndAddNode({ id: XoirNodeId('r2'), kind: 'heuristic', subtype: 'rule', properties: { condition: '', action: '', exceptionConditions: [] }, now });
  graph.createAndAddNode({ id: XoirNodeId('r1'), kind: 'heuristic', subtype: 'rule', properties: { condition: '', action: '', exceptionConditions: [] }, now });
  const d1 = await runPass(graph);
  const d2 = await runPass(graph);
  assert.deepEqual(d1, d2);
  assert.equal(d1[0]!.nodeId, XoirNodeId('r1'));
});

async function context(graph: XoirGraph): Promise<PassContext> {
  const { noopLogger } = await import('@xo/logger');
  const { CancellationToken } = await import('@xo/xoir');
  return { graph, logger: noopLogger, cancellationToken: new CancellationToken(), diagnostics: [] };
}

test('the pass never mutates the graph it is given', async () => {
  const graph = XoirGraph.create(XoirGraphId('g'));
  graph.createAndAddNode({ id: XoirNodeId('d1'), kind: 'decision_node', subtype: 'decision', properties: { question: '', outcome: '', rationale: '' }, now });
  const pass = createReasoningValidationPass();
  const result = await pass.run(await context(graph));
  assert.equal(result.graph, graph);
});
