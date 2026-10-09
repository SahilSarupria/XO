import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId } from '@xo/xoir';

const NOW = () => '2026-09-01T00:00:00.000Z';

/**
 * Mirrors the real shape `@xo/compiler` produces for a bulleted,
 * multi-step operational section (the Aastha reconciliation fixture,
 * `examples/vertical-test/Aastha.pdf`, §3 "Brokerage Reconciliation"):
 * three capabilities extracted from consecutive bullets in the same
 * document section, connected only by `COMPLEMENTS` edges (document
 * sequence — never a `REQUIRES`/dependency edge, since nothing in the
 * source states an execution dependency between them), all sharing one
 * exact `sectionPath`, plus a `concept` node (subtype `action`) whose
 * content is the section heading itself — the same "heading became its
 * own action node" shape Stage 4 actually produces for several of
 * Aastha's five sections.
 */
export function buildReconciliationSectionFixtureGraph(): XoirGraph {
  const graph = XoirGraph.create(XoirGraphId('reconciliation-section-fixture'));
  const sectionPath = ['Reconciliation Operations Manual', '3. Brokerage Reconciliation'] as const;

  const heading = graph.createAndAddNode({
    id: XoirNodeId('kn_section_heading'),
    kind: 'concept',
    properties: { definition: '3. Brokerage Reconciliation', aliases: [], summary: '3. Brokerage Reconciliation' },
    subtype: 'action',
    confidence: 0.5,
    sourceRefs: [{ documentPath: 'reconciliation-manual.pdf', sectionPath: [...sectionPath], pages: [1] }],
    now: NOW,
  });
  if (!heading.ok) throw new Error(heading.error.message);

  const addStep = (id: string, name: string, description: string): void => {
    const result = graph.createAndAddNode({
      id: XoirNodeId(id),
      kind: 'capability',
      properties: { name, description },
      confidence: 0.5,
      sourceRefs: [{ documentPath: 'reconciliation-manual.pdf', sectionPath: [...sectionPath], pages: [1] }],
      now: NOW,
    });
    if (!result.ok) throw new Error(`fixture setup failed for "${id}": ${result.error.message}`);
  };

  // In-source order: obtain data -> reconcile records -> compare expected vs actual.
  addStep('cap_obtain_statement', 'Obtain Insurer Statement', 'Retrieve the monthly insurer statement for reconciliation.');
  addStep('cap_reconcile_records', 'Reconcile Records', 'Map CRM policy records against the insurer statement.');
  addStep('cap_compare_expected_actual', 'Compare Expected vs Actual', 'Compare expected brokerage against actual brokerage received.');

  const complements = (fromId: string, toId: string): void => {
    // fromId is the later capability, toId is the immediately preceding one — matches
    // @xo/compiler's capabilities/relationship-builder.ts direction exactly.
    const result = graph.createAndAddEdge({ id: XoirEdgeId(`complements_${fromId}_${toId}`), kind: 'COMPLEMENTS', fromId: XoirNodeId(fromId), toId: XoirNodeId(toId), now: NOW });
    if (!result.ok) throw new Error(result.error.message);
  };
  complements('cap_reconcile_records', 'cap_obtain_statement');
  complements('cap_compare_expected_actual', 'cap_reconcile_records');

  return graph;
}

/**
 * Two capabilities in the same document section (a real `REQUIRES` edge
 * still exists between them) plus a third capability from a *different*
 * section connected to neither. Exercises: real precedence still wins
 * over source sequence when both exist, and the differently-sectioned
 * capability never gets pulled into the same `processGrouping` or the
 * same connected component.
 */
export function buildMixedEvidenceFixtureGraph(): XoirGraph {
  const graph = XoirGraph.create(XoirGraphId('mixed-evidence-fixture'));
  const sectionA = ['Manual', '3. Brokerage Reconciliation'] as const;
  const sectionB = ['Manual', '4. Financial Accounting'] as const;

  const addCap = (id: string, name: string, sectionPath: readonly string[]): void => {
    const result = graph.createAndAddNode({
      id: XoirNodeId(id),
      kind: 'capability',
      properties: { name, description: name },
      confidence: 0.6,
      sourceRefs: [{ documentPath: 'manual.pdf', sectionPath: [...sectionPath] }],
      now: NOW,
    });
    if (!result.ok) throw new Error(result.error.message);
  };

  addCap('cap_map_records', 'Map Records', sectionA);
  addCap('cap_verify_brokerage', 'Verify Brokerage', sectionA);
  addCap('cap_unrelated_section', 'Unrelated Bookkeeping Step', sectionB);

  const requires = graph.createAndAddEdge({ id: XoirEdgeId('req_verify_map'), kind: 'REQUIRES', fromId: XoirNodeId('cap_verify_brokerage'), toId: XoirNodeId('cap_map_records'), now: NOW });
  if (!requires.ok) throw new Error(requires.error.message);

  return graph;
}

/**
 * A single `concept` node (subtype `process`) with zero associated
 * capability nodes anywhere in scope — the "process was named in the
 * source but nothing executable was extracted from it" case. Composing
 * over this graph's (empty) capability scope must yield no candidate
 * workflow, never a hallucinated one built from the process concept
 * alone.
 */
export function buildProcessWithNoCapabilitiesFixtureGraph(): XoirGraph {
  const graph = XoirGraph.create(XoirGraphId('process-no-capabilities-fixture'));
  const result = graph.createAndAddNode({
    id: XoirNodeId('kn_named_process'),
    kind: 'concept',
    properties: { definition: 'Month-End Close Process', aliases: [], summary: 'consists of several steps' },
    subtype: 'process',
    confidence: 0.5,
    sourceRefs: [{ documentPath: 'manual.pdf', sectionPath: ['Manual', '9. Month-End Close'] }],
    now: NOW,
  });
  if (!result.ok) throw new Error(result.error.message);
  return graph;
}
