/**
 * Generates the hand-built XOIR fixture(s) under `fixtures/xoir/`.
 *
 *   npm run fixtures:xoir     (from packages/benchmark)
 *
 * WHY A HAND-BUILT GRAPH: no real source in this repository compiles to
 * (a) a multi-step workflow the existing audit classifies
 * `executable_candidate` AND (b) a proven producer -> consumer data-flow
 * binding between steps the standard resolvers can bind. `@xo/compiler`
 * emits no declared capability `outputs` today. The graph below is built
 * from REAL `@xo/xoir` nodes/edges — the same `CapabilityNodeProps` fields
 * a source frontend would populate — and is then loaded by the benchmark
 * observer via `fromJson` and sent through the REAL downstream pipeline
 * (packaging/lowering, contracts, binding resolution, workflow
 * composition + audit, runtime bridge + executor). It never bypasses
 * XOIR, contracts, or the runtime, changes no compiler semantics, and is
 * NOT presented as a discovered production capability.
 *
 * Fixed timestamps + fixed ids make the output byte-stable, so
 * `test/xoir-fixtures.test.ts` can assert the committed JSON equals what
 * this script generates.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId, toJson } from '@xo/xoir';

const FIXED_NOW = () => '2026-01-01T00:00:00.000Z';
const REF = [{ documentPath: 'bm-runtime-mechanics.fixture', pages: [1] }];

function must<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(`fixture construction failed: ${r.error.message}`);
  return r.value;
}

export function buildRuntimeMechanicsGraph(): XoirGraph {
  const graph = XoirGraph.create(XoirGraphId('bm_runtime_mechanics'));
  const cap = (id: string, name: string, extra: Record<string, unknown> = {}): void => {
    must(graph.createAndAddNode({ id: XoirNodeId(id), kind: 'capability', properties: { name, description: `${name} (benchmark fixture)`, ...extra }, confidence: 0.8, sourceRefs: REF, now: FIXED_NOW }));
  };
  const rule = (capId: string, ruleId: string, question: string, outcome: string): void => {
    must(graph.createAndAddNode({ id: XoirNodeId(ruleId), kind: 'decision_node', properties: { question, outcome }, confidence: 0.8, sourceRefs: REF, now: FIXED_NOW }));
    must(graph.createAndAddEdge({ id: XoirEdgeId(`edge_${capId}_requires_${ruleId}`), kind: 'REQUIRES', fromId: XoirNodeId(capId), toId: XoirNodeId(ruleId), now: FIXED_NOW }));
  };
  const action = (capId: string, conceptId: string, text: string): void => {
    must(graph.createAndAddNode({ id: XoirNodeId(conceptId), kind: 'concept', properties: { name: text, text }, confidence: 0.7, sourceRefs: REF, subtype: 'action', now: FIXED_NOW }));
    must(graph.createAndAddEdge({ id: XoirEdgeId(`edge_${capId}_requires_${conceptId}`), kind: 'REQUIRES', fromId: XoirNodeId(capId), toId: XoirNodeId(conceptId), now: FIXED_NOW }));
  };
  const requires = (consumer: string, producer: string): void => {
    must(graph.createAndAddEdge({ id: XoirEdgeId(`edge_${consumer}_requires_${producer}`), kind: 'REQUIRES', fromId: XoirNodeId(consumer), toId: XoirNodeId(producer), now: FIXED_NOW }));
  };

  // Workflow 1 — proven data flow: A (deterministic, declares output `matched`) -> B (deterministic, declares input `matched`).
  cap('cap_bm_flow_a', 'Check claim threshold', { outputs: ['matched: Whether the threshold rule matched'] });
  rule('cap_bm_flow_a', 'decision_bm_flow_a', 'the claim amount exceeds 10000', 'flag for payout');
  cap('cap_bm_flow_b', 'Authorize payout', { inputs: ['matched: Whether the threshold rule matched', 'payout amount: The payout amount to authorize'] });
  rule('cap_bm_flow_b', 'decision_bm_flow_b', 'the payout amount exceeds 500', 'release payout');
  requires('cap_bm_flow_b', 'cap_bm_flow_a');

  // Workflow 2 — a human pause in the middle: A (deterministic) -> B (human_in_the_loop) -> C (deterministic).
  cap('cap_bm_hitl_a', 'Screen the claim');
  rule('cap_bm_hitl_a', 'decision_bm_hitl_a', 'the screening score exceeds 70', 'screening passed');
  cap('cap_bm_hitl_b', 'Underwriter review of the flagged claim');
  action('cap_bm_hitl_b', 'concept_bm_hitl_b', 'Underwriter reviews the flagged claim');
  cap('cap_bm_hitl_c', 'Release the settlement');
  rule('cap_bm_hitl_c', 'decision_bm_hitl_c', 'the settlement amount exceeds 500', 'settlement released');
  requires('cap_bm_hitl_b', 'cap_bm_hitl_a');
  requires('cap_bm_hitl_c', 'cap_bm_hitl_b');

  // Workflow 3 — not executable yet: a capability with neither a rule nor action evidence (no binding resolves).
  cap('cap_bm_orphan', 'Assess the overall situation');

  // Workflow 4 — semantically invalid: a precedence cycle between two action-grounded capabilities.
  cap('cap_bm_cycle_x', 'Cycle member X');
  action('cap_bm_cycle_x', 'concept_bm_cycle_x', 'Perform cycle member X');
  cap('cap_bm_cycle_y', 'Cycle member Y');
  action('cap_bm_cycle_y', 'concept_bm_cycle_y', 'Perform cycle member Y');
  requires('cap_bm_cycle_x', 'cap_bm_cycle_y');
  requires('cap_bm_cycle_y', 'cap_bm_cycle_x');

  return graph;
}

export function renderRuntimeMechanicsJson(): string {
  return `${JSON.stringify(toJson(buildRuntimeMechanicsGraph()), null, 2)}\n`;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const out = join(dirname(fileURLToPath(import.meta.url)), 'xoir', 'runtime-mechanics.xoir.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderRuntimeMechanicsJson());
  // eslint-disable-next-line no-console
  console.log(`wrote ${out}`);
}
