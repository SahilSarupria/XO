import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph, XoirGraphId, XoirNodeId } from '@xo/xoir';
import { composeWorkflows } from '../src/compose.js';
import {
  buildCorporateLawyerFixtureGraph,
  buildCyclicFixtureGraph,
  buildConflictingFixtureGraph,
  buildInconsistentDependencyFixtureGraph,
} from './fixtures/corporate-lawyer-fixture.js';

function indexOf(steps: readonly { readonly capabilityId: string }[], id: string): number {
  const index = steps.findIndex((s) => s.capabilityId === id);
  assert.notEqual(index, -1, `expected step "${id}" to be present`);
  return index;
}

// ---------------------------------------------------------------------------
// Main fixture: capability -> workflow composition without a hardcoded sequence
// ---------------------------------------------------------------------------

test('composes the connected capability cluster into one workflow, ordered by discovered precedence only', () => {
  const graph = buildCorporateLawyerFixtureGraph();
  const result = composeWorkflows(graph, { now: () => '2026-08-23T00:00:00.000Z' });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  // Two candidates: the six-capability review cluster, and the standalone citation_lookup.
  assert.equal(result.value.length, 2);

  const clustered = result.value.find((w) => w.sourceCapabilityIds.includes('risk_flagging'));
  assert.ok(clustered, 'expected to find the clustered workflow');
  if (!clustered) return;

  assert.equal(clustered.steps.length, 6);
  assert.deepEqual(
    [...clustered.sourceCapabilityIds].sort(),
    ['clause_extraction', 'document_intake_classification', 'escalation_memo', 'final_summary_report', 'redline_drafting', 'risk_flagging'].sort(),
  );

  // Precedence constraints derived from REQUIRES edges — checked relationally,
  // never as a hardcoded full sequence, since redline_drafting vs escalation_memo
  // has no defined order between them.
  const steps = clustered.steps;
  assert.ok(indexOf(steps, 'document_intake_classification') < indexOf(steps, 'clause_extraction'));
  assert.ok(indexOf(steps, 'clause_extraction') < indexOf(steps, 'risk_flagging'));
  assert.ok(indexOf(steps, 'risk_flagging') < indexOf(steps, 'redline_drafting'));
  assert.ok(indexOf(steps, 'risk_flagging') < indexOf(steps, 'escalation_memo'));
  assert.ok(indexOf(steps, 'redline_drafting') < indexOf(steps, 'final_summary_report'));
  assert.ok(indexOf(steps, 'escalation_memo') < indexOf(steps, 'final_summary_report'));

  // The ambiguity between redline_drafting and escalation_memo must be surfaced,
  // not silently resolved.
  const ambiguityGap = clustered.gaps.find((g) => g.kind === 'ambiguous_precedence');
  assert.ok(ambiguityGap, 'expected an ambiguous_precedence gap');
  if (ambiguityGap) {
    assert.deepEqual([...ambiguityGap.involvedCapabilityIds].sort(), ['escalation_memo', 'redline_drafting']);
  }

  // No cycle, no conflict -> not blocking.
  assert.equal(clustered.gaps.some((g) => g.kind === 'circular_dependency'), false);
  assert.equal(clustered.gaps.some((g) => g.kind === 'conflicting_capabilities'), false);
  assert.equal(clustered.requiresHumanDecision, false);

  // Confidence is the weakest link (escalation_memo, 0.81), not an average.
  assert.equal(clustered.confidence, 0.81);

  // Rationale is populated and never invents a dependency that isn't a real edge.
  const finalStep = steps[indexOf(steps, 'final_summary_report')]!;
  const orderedAfterIds = finalStep.rationale.orderedAfter.map((r) => r.capabilityId).sort();
  assert.deepEqual(orderedAfterIds, ['escalation_memo', 'redline_drafting']);

  // The standalone capability becomes its own single-step candidate, not folded
  // into the cluster and not dropped.
  const standalone = result.value.find((w) => w.sourceCapabilityIds.includes('citation_lookup'));
  assert.ok(standalone);
  if (standalone) {
    assert.equal(standalone.steps.length, 1);
    assert.equal(standalone.requiresHumanDecision, false);
    assert.equal(standalone.gaps.length, 0);
  }
});

test('composition is deterministic across repeated calls on the same graph', () => {
  const graph = buildCorporateLawyerFixtureGraph();
  const now = () => '2026-08-23T00:00:00.000Z';
  const first = composeWorkflows(graph, { now });
  const second = composeWorkflows(graph, { now });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.deepEqual(first.value, second.value);
});

test('capability ids and names are preserved verbatim, never invented or renamed', () => {
  const graph = buildCorporateLawyerFixtureGraph();
  const result = composeWorkflows(graph);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const allStepIds = result.value.flatMap((w) => w.steps.map((s) => s.capabilityId));
  const allNodeIds = graph.allNodes().map((n) => n.id);
  assert.deepEqual([...allStepIds].sort(), [...allNodeIds].sort());
});

// ---------------------------------------------------------------------------
// Scoping
// ---------------------------------------------------------------------------

test('capabilityNodeIds restricts composition to the requested subset', () => {
  const graph = buildCorporateLawyerFixtureGraph();
  const result = composeWorkflows(graph, {
    capabilityNodeIds: [XoirNodeId('document_intake_classification'), XoirNodeId('clause_extraction')],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.length, 1);
  assert.equal(result.value[0]!.steps.length, 2);
  assert.equal(indexOf(result.value[0]!.steps, 'document_intake_classification') < indexOf(result.value[0]!.steps, 'clause_extraction'), true);
});

test('an unknown requested capability id is a Result error, not a thrown exception', () => {
  const graph = buildCorporateLawyerFixtureGraph();
  const result = composeWorkflows(graph, { capabilityNodeIds: [XoirNodeId('does_not_exist')] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'CAPABILITY_NODE_NOT_FOUND');
});

test('requesting a non-capability node id is a Result error', () => {
  const graph = buildCorporateLawyerFixtureGraph();
  const nonCapability = graph.createAndAddNode({
    id: XoirNodeId('some_constraint'),
    kind: 'constraint',
    properties: { rule: 'must not exceed budget', severity: 'blocking' },
  });
  assert.equal(nonCapability.ok, true);
  const result = composeWorkflows(graph, { capabilityNodeIds: [XoirNodeId('some_constraint')] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'NODE_NOT_A_CAPABILITY');
});

test('an empty graph composes to an empty, non-error result', () => {
  const graph = XoirGraph.create(XoirGraphId('empty'));
  const result = composeWorkflows(graph);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, []);
});

// ---------------------------------------------------------------------------
// Gaps: cycles, conflicts, inconsistent declared dependencies
// ---------------------------------------------------------------------------

test('a precedence cycle is surfaced as a gap and blocks unattended execution, never silently broken', () => {
  const graph = buildCyclicFixtureGraph();
  const result = composeWorkflows(graph);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.length, 1);
  const workflow = result.value[0]!;
  assert.equal(workflow.steps.length, 3);
  assert.equal(workflow.requiresHumanDecision, true);
  const cycleGap = workflow.gaps.find((g) => g.kind === 'circular_dependency');
  assert.ok(cycleGap);
  if (cycleGap) {
    assert.deepEqual([...cycleGap.involvedCapabilityIds].sort(), ['cap_a', 'cap_b', 'cap_c']);
  }
});

test('a CONFLICTS_WITH relationship is surfaced as a gap requiring human decision, without dropping either capability', () => {
  const graph = buildConflictingFixtureGraph();
  const result = composeWorkflows(graph);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.length, 1);
  const workflow = result.value[0]!;
  assert.equal(workflow.steps.length, 2);
  assert.equal(workflow.requiresHumanDecision, true);
  const conflictGap = workflow.gaps.find((g) => g.kind === 'conflicting_capabilities');
  assert.ok(conflictGap);
  if (conflictGap) {
    assert.deepEqual([...conflictGap.involvedCapabilityIds].sort(), ['automated_review_intake', 'manual_review_intake']);
  }
});

test('a declared dependency with no matching graph edge is flagged, not silently trusted or silently ignored', () => {
  const graph = buildInconsistentDependencyFixtureGraph();
  const result = composeWorkflows(graph);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // No edges connect the two nodes, so they land in separate single-step components.
  assert.equal(result.value.length, 2);
  const withGap = result.value.find((w) => w.gaps.length > 0);
  assert.ok(withGap);
  if (withGap) {
    assert.equal(withGap.gaps[0]!.kind, 'declared_dependency_unresolved');
    assert.equal(withGap.requiresHumanDecision, false); // flagged, but not itself execution-blocking
  }
});

test('minStepConfidence flags low-confidence steps without excluding them', () => {
  const graph = buildCorporateLawyerFixtureGraph();
  const result = composeWorkflows(graph, { minStepConfidence: 0.85 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const clustered = result.value.find((w) => w.sourceCapabilityIds.includes('risk_flagging'));
  assert.ok(clustered);
  if (!clustered) return;
  // risk_flagging (0.88) stays above threshold; redline_drafting (0.83) and
  // escalation_memo (0.81) fall below it.
  const lowConfidenceIds = clustered.gaps.filter((g) => g.kind === 'low_confidence_capability').flatMap((g) => g.involvedCapabilityIds);
  assert.deepEqual([...lowConfidenceIds].sort(), ['escalation_memo', 'redline_drafting']);
  // Still present as steps — flagged, not dropped.
  assert.equal(clustered.steps.length, 6);
});

// ---------------------------------------------------------------------------
// Contract / evidence pass-through
// ---------------------------------------------------------------------------

test('embedded contract id and source evidence are carried onto the step without re-deriving them', () => {
  const graph = XoirGraph.create(XoirGraphId('contract-fixture'));
  const created = graph.createAndAddNode({
    id: XoirNodeId('draft_nda'),
    kind: 'capability',
    properties: {
      name: 'Draft NDA',
      description: 'Drafts a standard mutual NDA.',
      semanticCapabilityContract: { id: 'sc_draft_nda', name: 'Draft NDA', description: 'x', inputs: [], outputs: [], requiredPermissions: [], determinism: 'unknown', rules: [], confidence: 0.9, sourceRefs: [], sourceXoirNodeIds: [] },
    },
    confidence: 0.9,
    sourceRefs: [{ documentPath: 'knowledge/graph.json', locator: 'NDA clause' }],
  });
  assert.equal(created.ok, true);

  const result = composeWorkflows(graph);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const step = result.value[0]!.steps[0]!;
  assert.equal(step.contractId, 'sc_draft_nda');
  assert.deepEqual(step.evidence, [{ documentPath: 'knowledge/graph.json', locator: 'NDA clause' }]);
});

// ---------------------------------------------------------------------------
// precedenceHint tie-break
// ---------------------------------------------------------------------------

test('precedenceHint changes only the tie-break order among genuinely ambiguous steps, never a real dependency order', () => {
  const graph = buildCorporateLawyerFixtureGraph();
  const withHint = composeWorkflows(graph, { precedenceHint: [XoirNodeId('escalation_memo'), XoirNodeId('redline_drafting')] });
  const withoutHint = composeWorkflows(graph, {});
  assert.equal(withHint.ok, true);
  assert.equal(withoutHint.ok, true);
  if (!withHint.ok || !withoutHint.ok) return;

  const hinted = withHint.value.find((w) => w.sourceCapabilityIds.includes('risk_flagging'))!;
  const unhinted = withoutHint.value.find((w) => w.sourceCapabilityIds.includes('risk_flagging'))!;

  // Without a hint, ids tie-break lexicographically: 'escalation_memo' < 'redline_drafting'.
  assert.ok(indexOf(unhinted.steps, 'escalation_memo') < indexOf(unhinted.steps, 'redline_drafting'));
  // With an explicit hint putting escalation_memo first too, the order agrees here;
  // the important invariant is that the real precedence constraints still hold.
  assert.ok(indexOf(hinted.steps, 'risk_flagging') < indexOf(hinted.steps, 'escalation_memo'));
  assert.ok(indexOf(hinted.steps, 'risk_flagging') < indexOf(hinted.steps, 'redline_drafting'));
});

// ---------------------------------------------------------------------------
// Direct XoirGraph plumbing sanity (edges added are the ones read back)
// ---------------------------------------------------------------------------

test('sanity: fixture graph REQUIRES edges resolve through XoirGraph.getNode/getEdge', () => {
  const graph = buildCorporateLawyerFixtureGraph();
  const node = graph.getNode(XoirNodeId('risk_flagging'));
  assert.equal(node.ok, true);
  const edge = graph.getEdge('req_risk_flagging_clause_extraction');
  assert.equal(edge.ok, true);
  if (edge.ok) {
    assert.equal(edge.value.kind, 'REQUIRES');
  }
});
