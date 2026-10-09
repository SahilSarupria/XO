import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId } from '@xo/xoir';

/**
 * A realistic-shaped fixture drawn from the repo's own flagship domain
 * (`PACKAGE_README.md`'s Corporate Contract & Commercial Lawyer XO):
 * seven capabilities a compiled version of that package would plausibly
 * discover, wired together the same way `@xo/compiler`'s
 * `capability-to-xoir.ts` actually wires a `CapabilityGraph` into XOIR —
 * `REQUIRES` edges for hard dependencies, a `CONFLICTS_WITH` edge for two
 * mutually exclusive intake capabilities, and one capability
 * (`citation_lookup`) left deliberately unrelated to every other one, so
 * a caller composing over the whole set gets more than one candidate
 * workflow without this module ever being told there are two clusters.
 *
 * Six of the seven form one connected cluster:
 *
 *   document_intake_classification
 *     -> clause_extraction
 *          -> risk_flagging
 *               -> redline_drafting   \
 *               -> escalation_memo     >-> final_summary_report
 *
 * `redline_drafting` and `escalation_memo` both depend only on
 * `risk_flagging` and have no relationship to each other — deliberately
 * left ambiguous so the fixture also exercises `'ambiguous_precedence'`
 * without any test needing to assert which of the two comes first.
 *
 * `intake_conflicting_variant` exists solely to exercise
 * `'conflicting_capabilities'`.
 */
export function buildCorporateLawyerFixtureGraph(): XoirGraph {
  const graph = XoirGraph.create(XoirGraphId('corporate-lawyer-fixture'));
  const now = () => '2026-08-23T00:00:00.000Z';

  const addCapability = (
    id: string,
    name: string,
    description: string,
    options: { readonly dependencies?: readonly string[]; readonly confidence?: number; readonly documentPath?: string } = {},
  ): void => {
    const result = graph.createAndAddNode({
      id: XoirNodeId(id),
      kind: 'capability',
      properties: {
        name,
        description,
        ...(options.dependencies ? { dependencies: options.dependencies } : {}),
      },
      confidence: options.confidence ?? 0.9,
      sourceRefs: options.documentPath ? [{ documentPath: options.documentPath, locator: name }] : [],
      now,
    });
    if (!result.ok) throw new Error(`fixture setup failed for "${id}": ${result.error.message}`);
  };

  const requires = (fromId: string, toId: string): void => {
    const result = graph.createAndAddEdge({
      id: XoirEdgeId(`req_${fromId}_${toId}`),
      kind: 'REQUIRES',
      fromId: XoirNodeId(fromId),
      toId: XoirNodeId(toId),
      now,
    });
    if (!result.ok) throw new Error(`fixture edge setup failed for "${fromId}"->"${toId}": ${result.error.message}`);
  };

  addCapability('document_intake_classification', 'Document Intake Classification', 'Classifies an incoming document by contract type.', {
    confidence: 0.95,
    documentPath: 'knowledge/graph.json',
  });
  addCapability('clause_extraction', 'Clause Extraction', 'Extracts individual clauses from a classified contract.', {
    dependencies: ['document_intake_classification'],
    confidence: 0.92,
    documentPath: 'knowledge/graph.json',
  });
  addCapability('risk_flagging', 'Risk Flagging', 'Flags clauses that carry above-threshold commercial risk.', {
    dependencies: ['clause_extraction'],
    confidence: 0.88,
    documentPath: 'reasoning/decision_trees.json',
  });
  addCapability('redline_drafting', 'Redline Drafting', 'Drafts suggested redlines for flagged clauses.', {
    dependencies: ['risk_flagging'],
    confidence: 0.83,
    documentPath: 'reasoning/reasoning_traces.jsonl',
  });
  addCapability('escalation_memo', 'Escalation Memo', 'Drafts an escalation memo for clauses above the auto-resolve threshold.', {
    dependencies: ['risk_flagging'],
    confidence: 0.81,
    documentPath: 'safety/rules.json',
  });
  addCapability('final_summary_report', 'Final Summary Report', 'Produces the client-facing summary memo.', {
    dependencies: ['redline_drafting', 'escalation_memo'],
    confidence: 0.9,
    documentPath: 'reasoning/case_library.json',
  });
  addCapability('citation_lookup', 'Citation Lookup', 'Looks up statutory/case citations on demand — used standalone, not part of the review pipeline.', {
    confidence: 0.97,
    documentPath: 'knowledge/graph.json',
  });

  requires('clause_extraction', 'document_intake_classification');
  requires('risk_flagging', 'clause_extraction');
  requires('redline_drafting', 'risk_flagging');
  requires('escalation_memo', 'risk_flagging');
  requires('final_summary_report', 'redline_drafting');
  requires('final_summary_report', 'escalation_memo');

  return graph;
}

/** A minimal three-node cycle: A requires B, B requires C, C requires A. */
export function buildCyclicFixtureGraph(): XoirGraph {
  const graph = XoirGraph.create(XoirGraphId('cyclic-fixture'));
  for (const id of ['cap_a', 'cap_b', 'cap_c']) {
    const result = graph.createAndAddNode({
      id: XoirNodeId(id),
      kind: 'capability',
      properties: { name: id, description: `Capability ${id}` },
      confidence: 0.8,
    });
    if (!result.ok) throw new Error(result.error.message);
  }
  for (const [from, to] of [
    ['cap_a', 'cap_b'],
    ['cap_b', 'cap_c'],
    ['cap_c', 'cap_a'],
  ] as const) {
    const result = graph.createAndAddEdge({ id: XoirEdgeId(`req_${from}_${to}`), kind: 'REQUIRES', fromId: XoirNodeId(from), toId: XoirNodeId(to) });
    if (!result.ok) throw new Error(result.error.message);
  }
  return graph;
}

/** Two capabilities marked mutually exclusive via `CONFLICTS_WITH`. */
export function buildConflictingFixtureGraph(): XoirGraph {
  const graph = XoirGraph.create(XoirGraphId('conflict-fixture'));
  for (const id of ['manual_review_intake', 'automated_review_intake']) {
    const result = graph.createAndAddNode({
      id: XoirNodeId(id),
      kind: 'capability',
      properties: { name: id, description: `Capability ${id}` },
      confidence: 0.85,
    });
    if (!result.ok) throw new Error(result.error.message);
  }
  const edge = graph.createAndAddEdge({
    id: XoirEdgeId('conflict_manual_automated'),
    kind: 'CONFLICTS_WITH',
    fromId: XoirNodeId('manual_review_intake'),
    toId: XoirNodeId('automated_review_intake'),
  });
  if (!edge.ok) throw new Error(edge.error.message);
  return graph;
}

/** A capability whose declared `dependencies` property names an id that has no matching graph edge — exercises `'declared_dependency_unresolved'`. */
export function buildInconsistentDependencyFixtureGraph(): XoirGraph {
  const graph = XoirGraph.create(XoirGraphId('inconsistent-dependency-fixture'));
  const a = graph.createAndAddNode({
    id: XoirNodeId('needs_phantom'),
    kind: 'capability',
    properties: { name: 'needs_phantom', description: 'Declares a dependency with no matching edge.', dependencies: ['phantom_capability'] },
    confidence: 0.7,
  });
  if (!a.ok) throw new Error(a.error.message);
  const b = graph.createAndAddNode({
    id: XoirNodeId('phantom_capability'),
    kind: 'capability',
    properties: { name: 'phantom_capability', description: 'Present in the graph, but no REQUIRES edge connects it.' },
    confidence: 0.7,
  });
  if (!b.ok) throw new Error(b.error.message);
  // Deliberately no REQUIRES edge added, and no other edge either — these two are
  // unrelated as far as the graph itself is concerned, so they land in separate
  // components; the mismatch is still detected per-node from `dependencies` alone.
  return graph;
}
