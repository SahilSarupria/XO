import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph, XoirGraphId, XoirNodeId, type CapabilityNodeProps } from '@xo/xoir';
import { linkRuleSourcesToReferencedNodes, type RuleLinkSource } from '../../src/xoir/rule-capability-linking.js';

const now = () => '2026-01-01T00:00:00.000Z';

/**
 * Builds a graph with one `capability` node (own unit `u-cap`, `name` +
 * `description` as given) plus whatever extra nodes a test needs, mirroring
 * the shape `pipeline/compile.ts#convertToXoir` hands `linkRuleSourcesToReferencedNodes`:
 * every candidate capability/concept node already present before linking runs.
 */
function graphWithCapability(id: string, name: string, description: string, unitId: string): XoirGraph {
  const graph = XoirGraph.create(XoirGraphId('test'));
  const props: CapabilityNodeProps = { name, description };
  const result = graph.createAndAddNode({
    id: XoirNodeId(id),
    kind: 'capability',
    properties: props,
    sourceRefs: [{ documentPath: 'doc.pdf', experienceUnitId: unitId }],
    now,
  });
  assert.ok(result.ok);
  return graph;
}

function ruleSource(nodeId: string, searchableText: string, unitId: string | undefined): RuleLinkSource {
  return { nodeId, searchableText, unitId };
}

function requiresEdgesTo(graph: XoirGraph, capabilityId: string): readonly { readonly fromId: unknown; readonly evidenceKind: unknown }[] {
  return graph
    .allEdges()
    .filter((e) => e.kind === 'REQUIRES' && e.toId === XoirNodeId(capabilityId))
    .map((e) => ({ fromId: e.fromId, evidenceKind: (e.metadata as { readonly custom?: { readonly evidenceKind?: string } }).custom?.evidenceKind }));
}

// ---------------------------------------------------------------------------
// 1. The diagnosed gap: a manager-approval-style rule, same unit as an
//    existing capability whose bare `name` is generic ("Review Action") but
//    whose `description` (its real originating sentence) carries the shared
//    domain vocabulary — must now link.
// ---------------------------------------------------------------------------

test('a same-unit rule links to a capability via shared vocabulary drawn from the description, not just the terse name', () => {
  const graph = graphWithCapability(
    'cap_review',
    'Review Action',
    'If the policy has expired before the date of loss, the claim must be referred for coverage review.',
    'u-section-7',
  );
  const sources: RuleLinkSource[] = [
    ruleSourceWithNode(graph, 'rule_manager_approval', 'If the claim amount is greater than INR 10,000 and all required documents are present, manager approval is required.', 'u-section-7'),
  ];

  linkRuleSourcesToReferencedNodes(graph, sources, now);

  const edges = requiresEdgesTo(graph, 'cap_review');
  assert.equal(edges.length, 1, 'expected exactly one REQUIRES edge to the capability');
  assert.equal(edges[0]!.fromId, XoirNodeId('rule_manager_approval'));
  assert.equal(edges[0]!.evidenceKind, 'same_unit_term_overlap', 'must remain the existing inferred tier, never a new one');
});

// ---------------------------------------------------------------------------
// 2. A capability in a DIFFERENT unit, even one whose description happens to
//    share generic vocabulary ("claim"), must NOT receive a link — the
//    same-unit gate is unchanged, only the vocabulary pool considered after
//    it passes has widened.
// ---------------------------------------------------------------------------

test('an unrelated capability in a different unit does not receive the link, even with shared generic vocabulary', () => {
  const graph = graphWithCapability('cap_notify', 'Notify the Insurer', 'The Insured must notify the Insurer of a loss within 7 days after becoming aware of the loss.', 'u-section-4');
  const sources: RuleLinkSource[] = [
    ruleSourceWithNode(graph, 'rule_manager_approval', 'If the claim amount is greater than INR 10,000 and all required documents are present, manager approval is required.', 'u-section-7'),
  ];

  linkRuleSourcesToReferencedNodes(graph, sources, now);

  assert.equal(requiresEdgesTo(graph, 'cap_notify').length, 0);
});

// ---------------------------------------------------------------------------
// 3. Existing, already-working links (exact-label on the bare name, and
//    same-unit overlap purely via the name) must continue to work unchanged.
// ---------------------------------------------------------------------------

test('existing exact-label linking on the capability name still works unchanged', () => {
  const graph = graphWithCapability('cap_claims_procedure', 'Claims Procedure', 'General claims handling process.', 'u-section-6');
  const sources: RuleLinkSource[] = [ruleSourceWithNode(graph, 'rule_heading_ref', '6. Claims Procedure', 'u-elsewhere')];

  linkRuleSourcesToReferencedNodes(graph, sources, now);

  const edges = requiresEdgesTo(graph, 'cap_claims_procedure');
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.evidenceKind, 'exact_label');
});

test('existing same-unit overlap linking that already worked via the name alone still works when description adds nothing new', () => {
  const graph = graphWithCapability('cap_assess', 'Assess the claim', 'The Insurer may appoint a loss adjuster to assess the claim.', 'u-section-6');
  const sources: RuleLinkSource[] = [ruleSourceWithNode(graph, 'rule_reject', 'If any information provided in the claim is materially incorrect, the claim may be rejected.', 'u-section-6')];

  linkRuleSourcesToReferencedNodes(graph, sources, now);

  const edges = requiresEdgesTo(graph, 'cap_assess');
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.evidenceKind, 'same_unit_term_overlap');
});

// ---------------------------------------------------------------------------
// 4. Evidence/provenance is preserved: the edge records the shared terms
//    that justified it, and those terms are real, inspectable strings, not
//    an opaque score.
// ---------------------------------------------------------------------------

test('evidence is preserved on the created edge: shared terms are recorded and traceable', () => {
  const graph = graphWithCapability('cap_review', 'Review Action', 'the claim must be referred for coverage review', 'u-section-7');
  const sources: RuleLinkSource[] = [ruleSourceWithNode(graph, 'rule_manager_approval', 'the claim amount exceeds INR 10,000, manager approval is required', 'u-section-7')];

  linkRuleSourcesToReferencedNodes(graph, sources, now);

  const edge = graph.allEdges().find((e) => e.kind === 'REQUIRES' && e.toId === XoirNodeId('cap_review'))!;
  assert.ok(edge);
  const custom = (edge.metadata as { readonly custom?: { readonly evidenceKind?: string; readonly sharedTerms?: readonly string[] } }).custom;
  assert.equal(custom?.evidenceKind, 'same_unit_term_overlap');
  assert.ok(custom?.sharedTerms && custom.sharedTerms.includes('claim'));
});

// ---------------------------------------------------------------------------
// 5. Ambiguity: when two same-unit capabilities are both plausible, each
//    gets its own independently-evidenced edge rather than the linker
//    arbitrarily picking one and discarding the other — the existing
//    architecture's way of representing "more than one candidate applies."
// ---------------------------------------------------------------------------

test('two plausible same-unit capabilities both receive their own edge rather than one being arbitrarily chosen', () => {
  const graph = graphWithCapability('cap_review', 'Review Action', 'the claim must be referred for coverage review', 'u-section-7');
  const props2: CapabilityNodeProps = { name: 'Settle Action', description: 'a claim may be settled only if the loss is covered' };
  const added = graph.createAndAddNode({ id: XoirNodeId('cap_settle'), kind: 'capability', properties: props2, sourceRefs: [{ documentPath: 'doc.pdf', experienceUnitId: 'u-section-7' }], now });
  assert.ok(added.ok);

  const sources: RuleLinkSource[] = [ruleSourceWithNode(graph, 'rule_manager_approval', 'the claim amount exceeds INR 10,000, manager approval is required before coverage review or claim is settled', 'u-section-7')];
  linkRuleSourcesToReferencedNodes(graph, sources, now);

  assert.equal(requiresEdgesTo(graph, 'cap_review').length, 1);
  assert.equal(requiresEdgesTo(graph, 'cap_settle').length, 1);
  // Neither is silently promoted to the strong (exact-label/"observed") tier — both stay inferred.
  for (const id of ['cap_review', 'cap_settle']) {
    const edge = graph.allEdges().find((e) => e.kind === 'REQUIRES' && e.toId === XoirNodeId(id))!;
    assert.equal(edge.metadata.confidenceDetail?.basis, 'inferred');
  }
});

// ---------------------------------------------------------------------------
// 6. Determinism: identical input produces an identical edge set, run to run.
// ---------------------------------------------------------------------------

test('linking is deterministic across repeated runs on identical input', () => {
  function build(): XoirGraph {
    const g = graphWithCapability('cap_review', 'Review Action', 'the claim must be referred for coverage review', 'u-section-7');
    ruleSourceWithNode(g, 'rule_manager_approval', 'the claim amount exceeds INR 10,000, manager approval is required', 'u-section-7');
    return g;
  }
  const sources: RuleLinkSource[] = [ruleSource('rule_manager_approval', 'the claim amount exceeds INR 10,000, manager approval is required', 'u-section-7')];

  const graph1 = build();
  const graph2 = build();

  linkRuleSourcesToReferencedNodes(graph1, sources, now);
  linkRuleSourcesToReferencedNodes(graph2, sources, now);

  const edges1 = graph1.allEdges().map((e) => `${e.fromId}->${e.toId}:${e.kind}`);
  const edges2 = graph2.allEdges().map((e) => `${e.fromId}->${e.toId}:${e.kind}`);
  assert.deepEqual(edges1, edges2);
});

// ---------------------------------------------------------------------------
// 7. No shared vocabulary anywhere (name or description) in the same unit
//    still correctly produces no link — widening the pool never fabricates
//    evidence that isn't there.
// ---------------------------------------------------------------------------

test('same unit with zero shared vocabulary in either name or description still does not link', () => {
  const graph = graphWithCapability('cap_review', 'Review Action', 'the affected property is listed in the schedule', 'u-section-7');
  const sources: RuleLinkSource[] = [ruleSource('rule_unrelated', 'the building has three floors and a basement', 'u-section-7')];

  linkRuleSourcesToReferencedNodes(graph, sources, now);

  assert.equal(requiresEdgesTo(graph, 'cap_review').length, 0);
});

// ---------------------------------------------------------------------------
// 8. Concept candidates are unaffected by this change: a concept's only
//    text is `definition`, which already equals `label` — there is no
//    separate description field to widen, so a concept's same-unit-overlap
//    behavior must be byte-for-byte identical to before this fix.
// ---------------------------------------------------------------------------

test('concept candidates are unaffected: same-unit overlap still uses definition only, same as before this change', () => {
  const graph = XoirGraph.create(XoirGraphId('test'));
  const conceptProps = { definition: 'coverage review procedure' };
  const added = graph.createAndAddNode({
    id: XoirNodeId('concept_review'),
    kind: 'concept',
    properties: conceptProps,
    sourceRefs: [{ documentPath: 'doc.pdf', experienceUnitId: 'u-section-7' }],
    now,
  });
  assert.ok(added.ok);

  // Shares "claim" with a rule elsewhere in the unit only through a hypothetical wider text pool —
  // but concepts have no description field to draw one from, so this must NOT link on "claim" alone;
  // it can only link on tokens actually present in its own definition ("review").
  const sources: RuleLinkSource[] = [ruleSourceWithNode(graph, 'rule_manager_approval', 'the claim amount exceeds INR 10,000, manager approval is required before coverage review', 'u-section-7')];
  linkRuleSourcesToReferencedNodes(graph, sources, now);

  const edges = requiresEdgesTo(graph, 'concept_review');
  assert.equal(edges.length, 1, 'expected the link to still happen, but only via "review" — the definition itself');
  const edge = graph.allEdges().find((e) => e.kind === 'REQUIRES' && e.toId === XoirNodeId('concept_review'))!;
  assert.equal((edge.metadata as { readonly custom?: { readonly evidenceKind?: string; readonly sharedTerms?: readonly string[] } }).custom?.evidenceKind, 'same_unit_term_overlap');
  const sharedTerms = (edge.metadata as { readonly custom?: { readonly sharedTerms?: readonly string[] } }).custom?.sharedTerms ?? [];
  assert.ok(sharedTerms.includes('review'));
  assert.ok(!sharedTerms.includes('claim'), 'concept has no description field to widen its vocabulary from, so "claim" must not appear as shared evidence');
});

/**
 * Adds a minimal `decision_node` to `graph` for the given `RuleLinkSource`
 * id, then returns the same source unchanged. `linkRuleSourcesToReferencedNodes`
 * creates a REQUIRES edge FROM the rule source's node id — `XoirGraph.createAndAddEdge`
 * requires both edge endpoints to already exist (fails closed with
 * `XOIR_DANGLING_EDGE` otherwise, silently discarded by the caller — see
 * this file's own known-failing pre-existing tests, which never add this
 * node and so never observe any edge at all, regardless of what
 * `scoreLink` returns). Real callers always satisfy this precondition —
 * `linkRuleSourcesToReferencedNodes`'s own doc comment states the graph
 * must already contain every candidate node before it runs, and in the
 * real pipeline the reasoning/knowledge nodes a `RuleLinkSource` is
 * built from are always added to the graph first. This test-only helper
 * exists solely so THIS file's new tests exercise a graph that actually
 * satisfies that precondition, without touching the pre-existing
 * `ruleSource`/`graphWithCapability` helpers above (which several
 * already-failing, pre-existing tests depend on unchanged).
 */
function ruleSourceWithNode(graph: XoirGraph, nodeId: string, searchableText: string, unitId: string | undefined): RuleLinkSource {
  const added = graph.createAndAddNode({
    id: XoirNodeId(nodeId),
    kind: 'decision_node',
    properties: { question: searchableText, outcome: 'n/a', rationale: 'n/a' },
    sourceRefs: unitId !== undefined ? [{ documentPath: 'doc.pdf', experienceUnitId: unitId }] : [],
    now,
  });
  assert.ok(added.ok, added.ok ? undefined : JSON.stringify(added.error));
  return ruleSource(nodeId, searchableText, unitId);
}

// --- Problem C: structural containment helpers ------------------------------

/** Adds a `capability` node whose `sourceRefs[0]` carries the given `sectionPath` (Problem C's structural-linking signal), on top of an already-existing graph. Distinct unit id per node so nothing accidentally also qualifies for same-unit tiers unless a test wants that. */
function addCapabilityAtPath(graph: XoirGraph, id: string, name: string, description: string, sectionPath: readonly string[], unitId: string): void {
  const props: CapabilityNodeProps = { name, description };
  const result = graph.createAndAddNode({
    id: XoirNodeId(id),
    kind: 'capability',
    properties: props,
    sourceRefs: [{ documentPath: 'doc.pdf', experienceUnitId: unitId, sectionPath }],
    now,
  });
  assert.ok(result.ok, result.ok ? undefined : JSON.stringify(result.error));
}

/** Like `ruleSourceWithNode`, but the reasoning node's own `sourceRefs[0]` also carries `sectionPath` — required for it to ever be a candidate for structural containment. */
function ruleSourceWithNodeAtPath(graph: XoirGraph, nodeId: string, searchableText: string, sectionPath: readonly string[], unitId: string): RuleLinkSource {
  const added = graph.createAndAddNode({
    id: XoirNodeId(nodeId),
    kind: 'decision_node',
    properties: { question: searchableText, outcome: 'n/a', rationale: 'n/a' },
    sourceRefs: [{ documentPath: 'doc.pdf', experienceUnitId: unitId, sectionPath }],
    now,
  });
  assert.ok(added.ok, added.ok ? undefined : JSON.stringify(added.error));
  return ruleSource(nodeId, searchableText, unitId);
}

function emptyGraph(): XoirGraph {
  return XoirGraph.create(XoirGraphId('test'));
}

// ---------------------------------------------------------------------------
// 9. Problem B — isolated numeric extraction-artifact tokens (clause/section
//    numbering, in particular) must not create a REQUIRES edge at this
//    integration layer either, mirroring the real fixture's actual
//    false-positive shape: a "7. Decision Rules" heading and an unrelated
//    "7.6 ..." sub-clause elsewhere in the same unit sharing only "7".
// ---------------------------------------------------------------------------

test('a same-unit rule sharing only a clause/section number with a capability does not link', () => {
  const graph = graphWithCapability(
    'cap_assess',
    'Assess whether reasonable precautions',
    '10.3 A qualified surveyor will evaluate whether adequate safeguards were installed prior to the event.',
    'u-section-10',
  );
  const sources: RuleLinkSource[] = [
    ruleSourceWithNode(graph, 'rule_ambiguous', '10. Ambiguous and Semantic Provisions. 10.1 Additional context may be requested where circumstances appear unclear.', 'u-section-10'),
  ];

  linkRuleSourcesToReferencedNodes(graph, sources, now);

  assert.equal(requiresEdgesTo(graph, 'cap_assess').length, 0, 'sharing only the digit "10" (clause numbering) must not create a link');
});

test('a same-unit rule sharing a clause number AND real vocabulary with a capability still links, with the number preserved in sharedTerms', () => {
  const graph = graphWithCapability(
    'cap_schedule',
    'Schedule specifies a higher',
    '3.1 A deductible of INR 25,000 applies to each covered occurrence unless the Schedule specifies a higher deductible.',
    'u-section-3',
  );
  const sources: RuleLinkSource[] = [
    ruleSourceWithNode(graph, 'rule_deductibles', '3. Deductibles and Limits. 3.2 For theft losses, a deductible of INR 50,000 applies to each occurrence.', 'u-section-3'),
  ];

  linkRuleSourcesToReferencedNodes(graph, sources, now);

  const edges = requiresEdgesTo(graph, 'cap_schedule');
  assert.equal(edges.length, 1, 'shared "deductible" alongside the shared digit "3" is sufficient evidence, unlike the numeric-only case above');
  const edge = graph.allEdges().find((e) => e.kind === 'REQUIRES' && e.toId === XoirNodeId('cap_schedule'))!;
  const sharedTerms = (edge.metadata as { readonly custom?: { readonly sharedTerms?: readonly string[] } }).custom?.sharedTerms ?? [];
  assert.ok(sharedTerms.includes('deductible'));
  assert.ok(sharedTerms.includes('3'), 'the numeric token is still reported as corroborating evidence, only excluded from the sufficiency decision when alone');
});

// ---------------------------------------------------------------------------
// 10. Problem B.1 — corpus-frequency-aware ambiguity gate. Reproduces the
//     real fixture's actual fan-out failure directly: one rule sharing only
//     a single common word ("claim") with TWO different capabilities must
//     not link to both (or either) of them, since the shared word alone
//     cannot tell you which one is meant.
// ---------------------------------------------------------------------------

test('a rule sharing only a common word with two different same-unit capabilities does not fan out to either — reproduces the real "claim" fan-out defect directly', () => {
  const graph = graphWithCapability('cap_assess_claim', 'Assess the claim', 'The reviewer will assess the claim for completeness.', 'u-claims-section');
  // A second capability, same unit, also mentioning "claim" but otherwise
  // textually unrelated — mirrors "Assess the claim" vs. "6. Claims
  // Procedure" both existing in the real fixture's claims section.
  const secondProps: CapabilityNodeProps = { name: 'Claims Procedure', description: 'The procedure for submitting a claim to the Insurer.' };
  const secondAdded = graph.createAndAddNode({ id: XoirNodeId('cap_claims_procedure'), kind: 'capability', properties: secondProps, sourceRefs: [{ documentPath: 'doc.pdf', experienceUnitId: 'u-claims-section' }], now });
  assert.ok(secondAdded.ok);

  const sources: RuleLinkSource[] = [
    ruleSourceWithNode(graph, 'rule_info_incorrect', 'Any information provided in the claim is materially incorrect.', 'u-claims-section'),
  ];

  linkRuleSourcesToReferencedNodes(graph, sources, now);

  assert.equal(requiresEdgesTo(graph, 'cap_assess_claim').length, 0, 'sharing only "claim" — a word both candidates contain — must not link to the first candidate');
  assert.equal(requiresEdgesTo(graph, 'cap_claims_procedure').length, 0, 'nor to the second candidate, for the same reason: the shared word cannot discriminate between them');
});

test('once one of two same-unit capabilities has DISTINCTIVE additional vocabulary, the rule correctly links only to it, not the ambiguous one', () => {
  const graph = graphWithCapability('cap_assess_claim', 'Assess the claim', 'The reviewer will assess the claim for completeness.', 'u-claims-section');
  const secondProps: CapabilityNodeProps = { name: 'Claims Procedure', description: 'The procedure for submitting a claim application form to the Insurer for settlement.' };
  const secondAdded = graph.createAndAddNode({ id: XoirNodeId('cap_claims_procedure'), kind: 'capability', properties: secondProps, sourceRefs: [{ documentPath: 'doc.pdf', experienceUnitId: 'u-claims-section' }], now });
  assert.ok(secondAdded.ok);

  const sources: RuleLinkSource[] = [
    ruleSourceWithNode(graph, 'rule_submission', 'The claimant must submit a completed claim application form for settlement.', 'u-claims-section'),
  ];

  linkRuleSourcesToReferencedNodes(graph, sources, now);

  assert.equal(requiresEdgesTo(graph, 'cap_assess_claim').length, 0, 'still ambiguous on "claim" alone with respect to this candidate');
  const distinctiveEdges = requiresEdgesTo(graph, 'cap_claims_procedure');
  assert.equal(distinctiveEdges.length, 1, 'shares "claim" AND "form"/"application"/"settlement" — genuinely more specific, multi-term evidence — so it correctly links');
});

// ---------------------------------------------------------------------------
// 11. Problem C — structural containment + lexical corroboration. Different
//     units, different heading depths — exactly the API-reference failure
//     mode the Problem C investigation diagnosed.
// ---------------------------------------------------------------------------

test('Problem C — a reasoning node nested inside a capability\'s own section links via structural_containment, even in a different unit', () => {
  const graph = emptyGraph();
  addCapabilityAtPath(graph, 'cap_create_charge', 'Create a Charge', 'Creates a new charge for the requested amount.', ['Root', 'Create a Charge'], 'u-cap');
  const sources: RuleLinkSource[] = [
    ruleSourceWithNodeAtPath(graph, 'rn_amount_check', 'If the charge amount is below the minimum threshold, reject it.', ['Root', 'Create a Charge', 'Response'], 'u-rule'),
  ];

  linkRuleSourcesToReferencedNodes(graph, sources, now);

  const edges = requiresEdgesTo(graph, 'cap_create_charge');
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.evidenceKind, 'structural_containment');
});

test('Problem C — an unrelated sibling branch does not structurally link merely because both share a document root', () => {
  const graph = emptyGraph();
  addCapabilityAtPath(graph, 'cap_a', 'Capability A', 'Handles A-related requests.', ['Root', 'Capability A'], 'u-cap-a');
  addCapabilityAtPath(graph, 'cap_b', 'Capability B', 'Handles B-related requests.', ['Root', 'Capability B'], 'u-cap-b');
  const sources: RuleLinkSource[] = [
    ruleSourceWithNodeAtPath(graph, 'rn_b_error', 'If the B request is invalid, reject it.', ['Root', 'Capability B', 'Errors'], 'u-rule'),
  ];

  linkRuleSourcesToReferencedNodes(graph, sources, now);

  assert.equal(requiresEdgesTo(graph, 'cap_a').length, 0, 'Capability A is not an ancestor of this reasoning node at all — must never link');
  assert.equal(requiresEdgesTo(graph, 'cap_b').length, 1, 'Capability B genuinely is the governing ancestor, and shares "B"/"request"/"invalid"-adjacent vocabulary');
});

test('Problem C — a document-root-level capability never receives a structural link, even to genuinely on-topic content', () => {
  const graph = emptyGraph();
  addCapabilityAtPath(graph, 'cap_root', 'Payments API Reference', 'Lets you create charges and manage customers.', ['Payments API Reference'], 'u-cap-root');
  const sources: RuleLinkSource[] = [
    ruleSourceWithNodeAtPath(graph, 'rn_deep_rule', 'If the charge amount is below the minimum, the customer cannot be charged.', ['Payments API Reference', 'Create a Charge', 'Response'], 'u-rule'),
  ];

  linkRuleSourcesToReferencedNodes(graph, sources, now);

  assert.equal(requiresEdgesTo(graph, 'cap_root').length, 0, 'a document-root-level capability must never structurally govern anything, regardless of topical relevance');
});

test('Problem C — nearest ancestor wins: a reasoning node under both a parent and a child capability links only to the child', () => {
  const graph = emptyGraph();
  addCapabilityAtPath(graph, 'cap_parent', 'Parent Capability', 'Handles parent-level requests and charges.', ['Root', 'Parent Capability'], 'u-cap-parent');
  addCapabilityAtPath(graph, 'cap_child', 'Child Capability', 'Handles child-level charge validation.', ['Root', 'Parent Capability', 'Child Capability'], 'u-cap-child');
  const sources: RuleLinkSource[] = [
    ruleSourceWithNodeAtPath(graph, 'rn_charge_rule', 'If the charge validation fails, reject the request.', ['Root', 'Parent Capability', 'Child Capability', 'Details'], 'u-rule'),
  ];

  linkRuleSourcesToReferencedNodes(graph, sources, now);

  assert.equal(requiresEdgesTo(graph, 'cap_child').length, 1, 'the deeper, more specific capability must win');
  assert.equal(requiresEdgesTo(graph, 'cap_parent').length, 0, 'the farther ancestor must not ALSO receive a link — nearest-only, no fan-out to every ancestor');
});

test('Problem C — numeric-only corroboration is rejected: a structurally nested reasoning node sharing only a clause number does not link', () => {
  const graph = emptyGraph();
  addCapabilityAtPath(graph, 'cap_decision_rules', 'Decision Rules', 'Governs how decisions are made for this section.', ['Root', 'Decision Rules'], 'u-cap');
  const sources: RuleLinkSource[] = [
    ruleSourceWithNodeAtPath(graph, 'rn_subclause', '7.6 Some unrelated sub-clause with no shared vocabulary at all.', ['Root', 'Decision Rules', 'Sub-clause 7.6'], 'u-rule'),
  ];

  linkRuleSourcesToReferencedNodes(graph, sources, now);

  assert.equal(requiresEdgesTo(graph, 'cap_decision_rules').length, 0);
});

test('Problem C — existing same-unit semantic evidence behaves identically when unrelated structural candidates are also present in the graph', () => {
  // Regression guard: adding a structural candidate elsewhere in the
  // graph must not change the existing same-unit exact_label outcome for
  // an unrelated pair.
  const graph = graphWithCapability('cap_review', 'Review Action', 'Reviews the submitted claim for completeness.', 'u-shared');
  addCapabilityAtPath(graph, 'cap_unrelated', 'Unrelated Capability', 'Handles something else entirely.', ['Root', 'Unrelated Capability'], 'u-other');
  const sources: RuleLinkSource[] = [ruleSourceWithNode(graph, 'rn_review', 'Review Action is required when the claim is incomplete.', 'u-shared')];

  linkRuleSourcesToReferencedNodes(graph, sources, now);

  const edges = requiresEdgesTo(graph, 'cap_review');
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.evidenceKind, 'exact_label', 'the existing same-unit exact_label result must be byte-identical to pre-Problem-C behavior');
  assert.equal(requiresEdgesTo(graph, 'cap_unrelated').length, 0);
});
