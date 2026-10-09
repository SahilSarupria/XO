import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph, XoirGraphId } from '@xo/xoir';
import {
  buildBenchmarkSuiteComponent,
  buildCaseLibraryComponent,
  buildDecisionTreesComponent,
  buildKnowledgeGraphComponent,
  buildLongTermMemoryGraphComponent,
  buildReasoningTracesComponent,
  buildSafetyRulesComponent,
} from '../../src/xoir/xoir-to-package.js';

const now = () => '2026-01-01T00:00:00.000Z';

function buildGraph(): XoirGraph {
  const graph = XoirGraph.create(XoirGraphId('g1'));

  graph.createAndAddNode({
    id: 'concept:hospital' as never,
    kind: 'concept',
    properties: { definition: 'The treating hospital named on the claim form.' },
    confidence: 0.82,
    subtype: 'organization',
    sourceRefs: [{ documentPath: 'claim.pdf', pages: [1], sourceConfidence: 0.9 }],
    now,
  });

  graph.createAndAddNode({
    id: 'fact:policy-number' as never,
    kind: 'fact',
    properties: { statement: 'Policy number field is 16 digits.', domain: 'insurance' },
    confidence: 0.7,
    now,
  });

  graph.createAndAddNode({
    id: 'decision:pre-existing' as never,
    kind: 'decision_node',
    properties: { question: 'Is this a pre-existing condition?', outcome: 'route to underwriting', rationale: 'policy clause 4.2' },
    confidence: 0.6,
    now,
  });

  graph.createAndAddNode({
    id: 'constraint:kyc' as never,
    kind: 'constraint',
    properties: { rule: 'KYC documents must be attached before submission.', severity: 'blocking' },
    confidence: 0.95,
    now,
  });

  graph.createAndAddNode({
    id: 'reasoning:step-1' as never,
    kind: 'reasoning_step',
    properties: { premise: 'Claim form is incomplete.', conclusion: 'Request the missing field.' },
    confidence: 0.75,
    now,
  });

  graph.createAndAddEdge({
    id: 'e1' as never,
    kind: 'REQUIRES',
    fromId: 'decision:pre-existing' as never,
    toId: 'concept:hospital' as never,
    now,
  });

  return graph;
}

test('buildKnowledgeGraphComponent includes concept/fact nodes with full provenance, sorted by id', () => {
  const graph = buildGraph();
  const component = buildKnowledgeGraphComponent(graph);
  assert.ok(component);
  const ids = component!.nodes.map((n) => n.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(component!.nodes.length, 2); // concept + fact only (decision_node/constraint/reasoning_step live elsewhere)

  const conceptNode = component!.nodes.find((n) => n.id === 'concept:hospital');
  assert.ok(conceptNode);
  assert.equal(conceptNode!.kind, 'concept');
  assert.equal(conceptNode!.subtype, 'organization');
  assert.equal(conceptNode!.confidence, 0.82);
  assert.equal(conceptNode!.sourceRefs.length, 1);
  assert.equal(conceptNode!.sourceRefs[0]!.documentPath, 'claim.pdf');
});

test('buildKnowledgeGraphComponent returns undefined when there is nothing to lower', () => {
  const empty = XoirGraph.create(XoirGraphId('empty'));
  assert.equal(buildKnowledgeGraphComponent(empty), undefined);
});

test('cross-component edges are preserved (not dropped) and flagged external on the knowledge_graph side', () => {
  const graph = buildGraph();
  const component = buildKnowledgeGraphComponent(graph);
  assert.ok(component);
  // The REQUIRES edge goes decision_node -> concept; decision_node lives in
  // decision_trees, not knowledge_graph, so on the knowledge_graph side this
  // edge's "from" endpoint is outside this component -> external: true.
  const edge = component!.edges.find((e) => e.id === 'e1');
  assert.ok(edge);
  assert.equal(edge!.external, true);
  assert.equal(edge!.to, 'concept:hospital');
});

test('the same edge shows up on the decision_trees side too, also flagged external', () => {
  const graph = buildGraph();
  const decisionTrees = buildDecisionTreesComponent(graph);
  assert.ok(decisionTrees);
  const edge = decisionTrees!.edges.find((e) => e.id === 'e1');
  assert.ok(edge);
  assert.equal(edge!.external, true);
  assert.equal(edge!.from, 'decision:pre-existing');
});

test('buildSafetyRulesComponent includes constraint nodes and is never undefined (required component)', () => {
  const graph = buildGraph();
  const safety = buildSafetyRulesComponent(graph);
  assert.equal(safety.nodes.length, 1);
  assert.equal(safety.nodes[0]!.id, 'constraint:kyc');

  const empty = XoirGraph.create(XoirGraphId('empty'));
  const emptySafety = buildSafetyRulesComponent(empty);
  assert.deepEqual(emptySafety.nodes, []); // present-but-empty, not undefined — see doc comment
});

test('buildBenchmarkSuiteComponent is honestly empty with an explanatory note when there are no evaluation_artifact nodes', () => {
  const graph = buildGraph();
  const benchmark = buildBenchmarkSuiteComponent(graph);
  assert.equal(benchmark.totalItems, 0);
  assert.deepEqual(benchmark.categories, []);
  assert.match(benchmark.note ?? '', /no Benchmark Synthesizer/);
});

test('buildBenchmarkSuiteComponent has no note once real evaluation_artifact nodes exist (does not fabricate a false "no synthesizer" claim once one exists)', () => {
  const graph = buildGraph();
  graph.createAndAddNode({
    id: 'eval:1' as never,
    kind: 'evaluation_artifact',
    properties: { input: 'Given an incomplete KYC field, what should the capability do?', expectedBehavior: 'Ask for the missing field before proceeding.' },
    confidence: 0.5,
    now,
  });
  const benchmark = buildBenchmarkSuiteComponent(graph);
  assert.equal(benchmark.totalItems, 1);
  assert.equal(benchmark.note, undefined);
  assert.equal(benchmark.categories[0]!.items[0]!.id, 'eval:1');
});

test('buildReasoningTracesComponent emits one JSON object per line (JSONL), undefined when empty', () => {
  const graph = buildGraph();
  const jsonl = buildReasoningTracesComponent(graph);
  assert.ok(jsonl);
  const lines = jsonl!.trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.id, 'reasoning:step-1');

  const empty = XoirGraph.create(XoirGraphId('empty'));
  assert.equal(buildReasoningTracesComponent(empty), undefined);
});

test('buildCaseLibraryComponent / buildLongTermMemoryGraphComponent are undefined for a graph with no failure_case/success_pattern/memory_unit nodes (today\'s real, honest outcome)', () => {
  const graph = buildGraph();
  assert.equal(buildCaseLibraryComponent(graph), undefined);
  assert.equal(buildLongTermMemoryGraphComponent(graph), undefined);
});

test('serialization is deterministic: building the same component twice from the same graph produces identical JSON', () => {
  const graph = buildGraph();
  const first = JSON.stringify(buildKnowledgeGraphComponent(graph));
  const second = JSON.stringify(buildKnowledgeGraphComponent(graph));
  assert.equal(first, second);
});
