import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId, toJson } from '@xo/xoir';
import { FsCompilationStore } from '../src/compilations/fs-compilation-store.js';
import type { CapabilityProjection } from '../src/compilations/compilation.js';
import { workspaceCompilationsStore } from '../src/workspace/workspace-context.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

/**
 * TEST-ONLY hand-built XOIR fixture for P0.8's multi-step mechanics.
 *
 * WHY THIS EXISTS (see the P0.8 completion report): no real fixture in
 * this repo (Commercial Property, Aastha, burglary, the multi-doc text
 * set, the OpenAPI/structured operation fixtures) compiles to a
 * workflow that is (a) multi-step AND (b) `executable_candidate` under
 * the existing audit, nor to a proven producer -> consumer binding
 * between steps the standard resolvers can bind. `@xo/compiler` emits
 * `outputs: []` for every discovered capability today. So — exactly as
 * `packages/runtime/test/workflow/candidate-workflow-bridge.test.ts` and
 * `apps/api/test/human-task-resume.test.ts` already do for the same
 * reason — the multi-step graph below is hand-built from REAL
 * `@xo/xoir` nodes/edges (declared `outputs`/`inputs` are the same
 * `CapabilityNodeProps` fields a source frontend would populate) and
 * stored through the REAL `FsCompilationStore`. Everything downstream
 * of "a succeeded compilation with a persisted graph exists" — HTTP,
 * auth, ownership, composition, audit, binding resolution, the runtime
 * bridge/executor, permission gates, HITL, persistence — is the real,
 * unmodified production path.
 *
 * This is NOT presented as a newly discovered production capability, no
 * compiler semantics are changed to make it executable, and no
 * client-controllable override exists: the fixture only decides what
 * evidence sits in a stored compilation.
 *
 * NOTE on the data-flow value: the standard deterministic binding
 * (`StructuredComparisonBindingResolver`) always returns
 * `{ matched, ruleSourceNodeId?, outcome? }`. A proven producer ->
 * consumer transfer through the standard resolvers can therefore only
 * carry one of those keys; the fixture declares Step A's authoritative
 * output as `matched` (boolean), as the existing runtime bridge test
 * does. (A numeric `amount` output would require a bespoke binding —
 * i.e. the `bindingOverrides` seam P0.8 explicitly does not expose.)
 */

const REF = [{ documentPath: 'p08-fixture.pdf', pages: [1] }];

export const FIXTURE_CAPABILITY_IDS = {
  flowA: 'cap_p08_flow_a_threshold',
  flowB: 'cap_p08_flow_b_payout',
  hitlA: 'cap_p08_hitl_a_threshold',
  hitlB: 'cap_p08_hitl_b_review',
  hitlC: 'cap_p08_hitl_c_payout',
  twoH1: 'cap_p08_two_h1_review_one',
  twoH2: 'cap_p08_two_h2_review_two',
  orphan: 'cap_p08_orphan_unbound',
  cycleX: 'cap_p08_cycle_x',
  cycleY: 'cap_p08_cycle_y',
  perm: 'cap_p08_needs_permission',
  xsegA: 'cap_p08_xseg_a_intake',
  xsegH: 'cap_p08_xseg_h_review',
  xsegC: 'cap_p08_xseg_c_settle',
} as const;

function must<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(`fixture construction failed: ${r.error.message}`);
  return r.value;
}

export function buildFixtureGraph(): XoirGraph {
  const graph = XoirGraph.create(XoirGraphId('p08_fixture_graph'));
  const cap = (id: string, name: string, extra: Record<string, unknown> = {}): void => {
    must(graph.createAndAddNode({ id: XoirNodeId(id), kind: 'capability', properties: { name, description: `${name} (P0.8 test fixture)`, ...extra }, confidence: 0.8, sourceRefs: REF }));
  };
  /** A `decision_node` with an outcome is what `StructuredComparisonBindingResolver` needs to bind a deterministic capability. */
  const rule = (capId: string, ruleId: string, question: string, outcome: string): void => {
    must(graph.createAndAddNode({ id: XoirNodeId(ruleId), kind: 'decision_node', properties: { question, outcome }, confidence: 0.8, sourceRefs: REF }));
    must(graph.createAndAddEdge({ id: XoirEdgeId(`edge_${capId}_requires_${ruleId}`), kind: 'REQUIRES', fromId: XoirNodeId(capId), toId: XoirNodeId(ruleId) }));
  };
  /** An operational-action concept linked by REQUIRES is what `ActionEscalationBindingResolver` needs to bind a human_in_the_loop capability. */
  const action = (capId: string, conceptId: string, text: string): void => {
    must(graph.createAndAddNode({ id: XoirNodeId(conceptId), kind: 'concept', properties: { name: text, text }, confidence: 0.7, sourceRefs: REF, subtype: 'action' }));
    must(graph.createAndAddEdge({ id: XoirEdgeId(`edge_${capId}_requires_${conceptId}`), kind: 'REQUIRES', fromId: XoirNodeId(capId), toId: XoirNodeId(conceptId) }));
  };
  const requires = (consumer: string, producer: string): void => {
    must(graph.createAndAddEdge({ id: XoirEdgeId(`edge_${consumer}_requires_${producer}`), kind: 'REQUIRES', fromId: XoirNodeId(consumer), toId: XoirNodeId(producer) }));
  };

  // Workflow 1 — proven data flow: A (deterministic, declares output `matched`) -> B (deterministic, declares input `matched`).
  cap(FIXTURE_CAPABILITY_IDS.flowA, 'Check claim threshold', { outputs: ['matched: Whether the threshold rule matched'] });
  rule(FIXTURE_CAPABILITY_IDS.flowA, 'decision_p08_flow_a', 'the claim amount exceeds 10000', 'flag for payout');
  cap(FIXTURE_CAPABILITY_IDS.flowB, 'Authorize payout', { inputs: ['matched: Whether the threshold rule matched', 'payout amount: The payout amount to authorize'] });
  rule(FIXTURE_CAPABILITY_IDS.flowB, 'decision_p08_flow_b', 'the payout amount exceeds 500', 'release payout');
  requires(FIXTURE_CAPABILITY_IDS.flowB, FIXTURE_CAPABILITY_IDS.flowA);

  // Workflow 2 — HITL in the middle: A (deterministic) -> B (human_in_the_loop) -> C (deterministic).
  cap(FIXTURE_CAPABILITY_IDS.hitlA, 'Screen the claim');
  rule(FIXTURE_CAPABILITY_IDS.hitlA, 'decision_p08_hitl_a', 'the screening score exceeds 70', 'screening passed');
  cap(FIXTURE_CAPABILITY_IDS.hitlB, 'Underwriter review of the flagged claim');
  action(FIXTURE_CAPABILITY_IDS.hitlB, 'concept_p08_hitl_b', 'Underwriter reviews the flagged claim');
  cap(FIXTURE_CAPABILITY_IDS.hitlC, 'Release the settlement');
  rule(FIXTURE_CAPABILITY_IDS.hitlC, 'decision_p08_hitl_c', 'the settlement amount exceeds 500', 'settlement released');
  requires(FIXTURE_CAPABILITY_IDS.hitlB, FIXTURE_CAPABILITY_IDS.hitlA);
  requires(FIXTURE_CAPABILITY_IDS.hitlC, FIXTURE_CAPABILITY_IDS.hitlB);

  // Workflow 3 — two consecutive HITL steps (proves stale-decision protection across steps).
  cap(FIXTURE_CAPABILITY_IDS.twoH1, 'First manual review');
  action(FIXTURE_CAPABILITY_IDS.twoH1, 'concept_p08_two_h1', 'Reviewer performs the first manual review');
  cap(FIXTURE_CAPABILITY_IDS.twoH2, 'Second manual review');
  action(FIXTURE_CAPABILITY_IDS.twoH2, 'concept_p08_two_h2', 'Reviewer performs the second manual review');
  requires(FIXTURE_CAPABILITY_IDS.twoH2, FIXTURE_CAPABILITY_IDS.twoH1);

  // Workflow 4 — not_executable_yet: a capability with neither a rule nor action evidence (no binding resolves).
  cap(FIXTURE_CAPABILITY_IDS.orphan, 'Assess the overall situation');

  // Workflow 5 — semantically_invalid: a precedence cycle.
  cap(FIXTURE_CAPABILITY_IDS.cycleX, 'Cycle member X');
  action(FIXTURE_CAPABILITY_IDS.cycleX, 'concept_p08_cycle_x', 'Perform cycle member X');
  cap(FIXTURE_CAPABILITY_IDS.cycleY, 'Cycle member Y');
  action(FIXTURE_CAPABILITY_IDS.cycleY, 'concept_p08_cycle_y', 'Perform cycle member Y');
  requires(FIXTURE_CAPABILITY_IDS.cycleX, FIXTURE_CAPABILITY_IDS.cycleY);
  requires(FIXTURE_CAPABILITY_IDS.cycleY, FIXTURE_CAPABILITY_IDS.cycleX);

  // Workflow 6 — a single deterministic step whose contract declares a required permission no policy grants (fail-closed).
  cap(FIXTURE_CAPABILITY_IDS.perm, 'Read the customer file', { requiredPermissions: ['filesystem.read'] });
  rule(FIXTURE_CAPABILITY_IDS.perm, 'decision_p08_perm', 'the file size exceeds 10', 'file readable');

  // Workflow 7 — proven data flow ACROSS a human pause: A (deterministic, declares output `matched`) -> H (human_in_the_loop) -> C (deterministic, declares input `matched`).
  // C's proven producer is A, not the adjacent HITL step, so the value must survive the pause (and a restart) via persisted step state.
  cap(FIXTURE_CAPABILITY_IDS.xsegA, 'Intake check', { outputs: ['matched: Whether the intake rule matched'] });
  rule(FIXTURE_CAPABILITY_IDS.xsegA, 'decision_p08_xseg_a', 'the intake score exceeds 50', 'intake accepted');
  cap(FIXTURE_CAPABILITY_IDS.xsegH, 'Manual intake review');
  action(FIXTURE_CAPABILITY_IDS.xsegH, 'concept_p08_xseg_h', 'Reviewer performs the manual intake review');
  cap(FIXTURE_CAPABILITY_IDS.xsegC, 'Settle the intake', { inputs: ['matched: Whether the intake rule matched', 'review amount: The reviewed amount'] });
  rule(FIXTURE_CAPABILITY_IDS.xsegC, 'decision_p08_xseg_c', 'the review amount exceeds 500', 'intake settled');
  requires(FIXTURE_CAPABILITY_IDS.xsegH, FIXTURE_CAPABILITY_IDS.xsegA);
  requires(FIXTURE_CAPABILITY_IDS.xsegC, FIXTURE_CAPABILITY_IDS.xsegH);
  requires(FIXTURE_CAPABILITY_IDS.xsegC, FIXTURE_CAPABILITY_IDS.xsegA);

  return graph;
}

/** Stores the fixture as a SUCCEEDED compilation in `workspace`'s real compilation store (same `FsCompilationStore` `POST .../compile` writes to). */
export async function storeFixtureCompilation(workspace: WorkspaceRecord, dataRootDir: string): Promise<{ readonly compilationId: string }> {
  const store = new FsCompilationStore(workspaceCompilationsStore(workspace, { dataRootDir }));
  const created = await store.create(workspace.workspaceId, workspace.identityId, { sourceId: 'src_p08_fixture', sourceDigestSha256: 'p08-fixture-digest' });
  if (!created.ok) throw created.error;
  const graph = buildFixtureGraph();
  const capabilities: CapabilityProjection[] = Object.values(FIXTURE_CAPABILITY_IDS).map((id) => ({
    capabilityId: id,
    contractId: id,
    name: id,
    description: 'P0.8 test fixture capability',
    status: 'resolved' as const,
    confidence: 0.8,
    provenance: [{ documentPath: 'p08-fixture.pdf', pages: [1] }],
  }));
  const done = await store.markSucceeded(created.value.compilationId, { capabilities, discoveredCount: capabilities.length, resolvedCount: capabilities.length, graph: toJson(graph) });
  if (!done.ok) throw done.error;
  return { compilationId: created.value.compilationId };
}
