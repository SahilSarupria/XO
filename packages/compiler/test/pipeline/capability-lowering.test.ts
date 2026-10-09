import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId } from '@xo/xoir';
import { StructuredComparisonBindingResolver } from '@xo/capability-contract';
import { lowerCapabilitiesToManifest } from '../../src/pipeline/capability-lowering.js';

/**
 * Focused unit tests for the `CapabilityDeclaration.execution` field
 * populated by `toCapabilityDeclaration`/`buildExecutionDeclaration` in
 * `capability-lowering.ts`. `packager.test.ts` already covers the
 * broader lowering/packaging behavior (discovery counts, knowledge_graph
 * preservation, ambiguous/denied/unresolved non-promotion); this file
 * exists specifically to prove the R1 authoritative `execution` field
 * itself is populated correctly, with exactly the fields the real
 * contract/binding data supports and nothing invented.
 */

const now = () => '2026-01-01T00:00:00.000Z';

/** Mirrors packager.test.ts's `addResolvableCapability` fixture: a capability + one linked `decision_node` whose condition parses under `StructuredComparisonBindingResolver`'s closed grammar — resolves to `'resolved'`, `implementationClass: 'deterministic_rule'`. */
function graphWithResolvableCapability(suffix = 'a'): { readonly graph: XoirGraph; readonly capabilityId: string; readonly decisionId: string } {
  const graph = XoirGraph.create(XoirGraphId(`g-${suffix}`));
  const capabilityId = `capability:evaluate-claim-${suffix}`;
  const decisionId = `decision:deny-large-claim-${suffix}`;
  graph.createAndAddNode({
    id: XoirNodeId(capabilityId),
    kind: 'capability',
    properties: { name: 'Evaluate Claim', description: 'Evaluates a submitted claim against policy rules.', determinism: 'deterministic' },
    confidence: 0.7,
    now,
  });
  graph.createAndAddNode({
    id: XoirNodeId(decisionId),
    kind: 'decision_node',
    properties: { question: 'the claimed loss amount exceeds 10000', outcome: 'deny the claim' },
    confidence: 0.9,
    now,
  });
  graph.createAndAddEdge({ id: XoirEdgeId(`req-${suffix}`), kind: 'REQUIRES', fromId: XoirNodeId(decisionId), toId: XoirNodeId(capabilityId), now });
  return { graph, capabilityId, decisionId };
}

/** Same shape, but the capability node also carries `requiredPermissions` — exercises `requiredPermissionIds` passthrough. */
function graphWithResolvableCapabilityAndPermissions(suffix = 'perm'): { readonly graph: XoirGraph; readonly capabilityId: string } {
  const graph = XoirGraph.create(XoirGraphId(`g-${suffix}`));
  const capabilityId = `capability:evaluate-claim-${suffix}`;
  const decisionId = `decision:deny-large-claim-${suffix}`;
  graph.createAndAddNode({
    id: XoirNodeId(capabilityId),
    kind: 'capability',
    properties: {
      name: 'Evaluate Claim',
      description: 'Evaluates a submitted claim against policy rules.',
      determinism: 'deterministic',
      requiredPermissions: ['runtime.execute'],
    },
    confidence: 0.7,
    now,
  });
  graph.createAndAddNode({
    id: XoirNodeId(decisionId),
    kind: 'decision_node',
    properties: { question: 'the claimed loss amount exceeds 10000', outcome: 'deny the claim' },
    confidence: 0.9,
    now,
  });
  graph.createAndAddEdge({ id: XoirEdgeId(`req-${suffix}`), kind: 'REQUIRES', fromId: XoirNodeId(decisionId), toId: XoirNodeId(capabilityId), now });
  return { graph, capabilityId };
}

/** Same shape as `graphWithResolvableCapability`, but the capability node's `requiredPermissions` is exactly whatever `permissions` the caller supplies — for Phase 3's permission-format-validation tests, which need to control the exact (valid/invalid/mixed) permission strings on the contract. */
function graphWithResolvableCapabilityAndCustomPermissions(suffix: string, permissions: readonly string[]): { readonly graph: XoirGraph; readonly capabilityId: string } {
  const graph = XoirGraph.create(XoirGraphId(`g-${suffix}`));
  const capabilityId = `capability:evaluate-claim-${suffix}`;
  const decisionId = `decision:deny-large-claim-${suffix}`;
  graph.createAndAddNode({
    id: XoirNodeId(capabilityId),
    kind: 'capability',
    properties: {
      name: 'Evaluate Claim',
      description: 'Evaluates a submitted claim against policy rules.',
      determinism: 'deterministic',
      requiredPermissions: permissions,
    },
    confidence: 0.7,
    now,
  });
  graph.createAndAddNode({
    id: XoirNodeId(decisionId),
    kind: 'decision_node',
    properties: { question: 'the claimed loss amount exceeds 10000', outcome: 'deny the claim' },
    confidence: 0.9,
    now,
  });
  graph.createAndAddEdge({ id: XoirEdgeId(`req-${suffix}`), kind: 'REQUIRES', fromId: XoirNodeId(decisionId), toId: XoirNodeId(capabilityId), now });
  return { graph, capabilityId };
}

function graphWithUnresolvedCapability(suffix = 'bare'): { readonly graph: XoirGraph; readonly capabilityId: string } {
  const graph = XoirGraph.create(XoirGraphId(`g-${suffix}`));
  const capabilityId = `capability:bare-${suffix}`;
  graph.createAndAddNode({
    id: XoirNodeId(capabilityId),
    kind: 'capability',
    properties: { name: 'Bare Capability', description: 'No linked rules exist for this capability.' },
    confidence: 0.6,
    now,
  });
  return { graph, capabilityId };
}

function graphWithDeniedCapability(suffix = 'nd'): { readonly graph: XoirGraph; readonly capabilityId: string } {
  const graph = XoirGraph.create(XoirGraphId(`g-${suffix}`));
  const capabilityId = `capability:non-deterministic-${suffix}`;
  const decisionId = `decision:non-deterministic-${suffix}`;
  graph.createAndAddNode({
    id: XoirNodeId(capabilityId),
    kind: 'capability',
    properties: { name: 'Draft Freeform Reply', description: 'Drafts a freeform reply — inherently non-deterministic.', determinism: 'non_deterministic' },
    confidence: 0.7,
    now,
  });
  graph.createAndAddNode({
    id: XoirNodeId(decisionId),
    kind: 'decision_node',
    properties: { question: 'the claimed loss amount exceeds 10000', outcome: 'draft a reply' },
    confidence: 0.9,
    now,
  });
  graph.createAndAddEdge({ id: XoirEdgeId(`req-${suffix}`), kind: 'REQUIRES', fromId: XoirNodeId(decisionId), toId: XoirNodeId(capabilityId), now });
  return { graph, capabilityId };
}

// ---------------------------------------------------------------------------
// 1-6: resolved deterministic capability -> execution field, exact fields
// ---------------------------------------------------------------------------

test('a resolved deterministic capability produces CapabilityDeclaration.execution', () => {
  const { graph, capabilityId } = graphWithResolvableCapability('exec1');
  const result = lowerCapabilitiesToManifest(graph);

  assert.equal(result.declarations.length, 1);
  const declaration = result.declarations.find((d) => d.id === capabilityId);
  assert.ok(declaration);
  assert.ok(declaration!.execution, 'expected an execution field to be populated');
});

test('execution.mode is deterministic_rule', () => {
  const { graph, capabilityId } = graphWithResolvableCapability('exec2');
  const result = lowerCapabilitiesToManifest(graph);
  const declaration = result.declarations.find((d) => d.id === capabilityId)!;
  assert.equal(declaration.execution!.mode, 'deterministic_rule');
});

test('execution.contractId matches the real contract id (== the source XOIR capability node id)', () => {
  const { graph, capabilityId } = graphWithResolvableCapability('exec3');
  const result = lowerCapabilitiesToManifest(graph);
  const declaration = result.declarations.find((d) => d.id === capabilityId)!;
  assert.equal(declaration.execution!.contractId, capabilityId);
});

test('execution.bindingId matches the real binding id produced by the resolver', () => {
  const { graph, capabilityId } = graphWithResolvableCapability('exec4');
  const result = lowerCapabilitiesToManifest(graph);
  const declaration = result.declarations.find((d) => d.id === capabilityId)!;
  // Same id convention StructuredComparisonBindingResolver itself uses (structured-comparison-resolver.ts): `binding_${contract.id}_${resolverName}`.
  assert.equal(declaration.execution!.bindingId, `binding_${capabilityId}_structured-comparison-resolver`);
});

test('input schema comes from the real contract/binding data when available: one required numeric property per rule input key', () => {
  const { graph, capabilityId } = graphWithResolvableCapability('exec5');
  const result = lowerCapabilitiesToManifest(graph);
  const declaration = result.declarations.find((d) => d.id === capabilityId)!;
  const schema = declaration.execution!.inputSchema;
  assert.ok(schema, 'expected an inputSchema to be derived from the resolved binding');
  assert.equal(schema!.type, 'object');
  // "the claimed loss amount" -> normalizeToFallbackKey -> "claimed_loss_amount" (StructuredComparisonBindingResolver's own convention; no declared contract inputs on this fixture).
  assert.deepEqual(schema!.required, ['claimed_loss_amount']);
  assert.deepEqual(schema!.properties, { claimed_loss_amount: { type: 'number' } });
});

test('required permissions are preserved from the real contract (verbatim, not fabricated)', () => {
  const { graph, capabilityId } = graphWithResolvableCapabilityAndPermissions('exec6');
  const result = lowerCapabilitiesToManifest(graph);
  const declaration = result.declarations.find((d) => d.id === capabilityId)!;
  assert.deepEqual(declaration.execution!.requiredPermissionIds, ['runtime.execute']);
});

test('requiredPermissionIds is omitted (not an empty array) when the contract declares no required permissions', () => {
  const { graph, capabilityId } = graphWithResolvableCapability('exec7');
  const result = lowerCapabilitiesToManifest(graph);
  const declaration = result.declarations.find((d) => d.id === capabilityId)!;
  assert.equal('requiredPermissionIds' in declaration.execution!, false);
});

// ---------------------------------------------------------------------------
// 7-9: unresolved / ambiguous / denied never produce an executable declaration
// ---------------------------------------------------------------------------

test('an unresolved capability produces no manifest declaration at all (so no execution field either)', () => {
  const { graph, capabilityId } = graphWithUnresolvedCapability('unres1');
  const result = lowerCapabilitiesToManifest(graph);
  assert.equal(result.declarations.length, 0);
  const outcome = result.outcomes.find((o) => o.contractId === capabilityId);
  assert.ok(outcome);
  assert.equal(outcome!.status, 'unresolved');
  assert.equal(outcome!.declaration, undefined);
});

test('an ambiguous capability produces no manifest declaration at all (so no execution field either)', () => {
  const { graph, capabilityId } = graphWithResolvableCapability('amb1');
  const secondResolver = {
    name: 'always-agrees',
    resolve: (contract: { readonly id: string }) => ({
      status: 'resolved' as const,
      binding: { id: `binding_${contract.id}_second`, contractId: contract.id, implementationClass: 'deterministic_rule' as const, resolverName: 'always-agrees', description: 'test double', derivation: {} },
    }),
  };
  const result = lowerCapabilitiesToManifest(graph, { resolvers: [new StructuredComparisonBindingResolver(), secondResolver] });
  assert.equal(result.declarations.length, 0);
  const outcome = result.outcomes.find((o) => o.contractId === capabilityId);
  assert.ok(outcome);
  assert.equal(outcome!.status, 'ambiguous');
  assert.equal(outcome!.declaration, undefined);
});

test('a denied capability (explicitly non_deterministic) produces no manifest declaration at all (so no execution field either)', () => {
  const { graph, capabilityId } = graphWithDeniedCapability('den1');
  const result = lowerCapabilitiesToManifest(graph);
  assert.equal(result.declarations.length, 0);
  const outcome = result.outcomes.find((o) => o.contractId === capabilityId);
  assert.ok(outcome);
  assert.equal(outcome!.status, 'denied');
  assert.equal(outcome!.declaration, undefined);
});

// ---------------------------------------------------------------------------
// Robustness: a binding whose derivation doesn't match the documented
// {rules: [{inputKey, ...}]} shape yields no inputSchema, not a crash or a
// fabricated one.
// ---------------------------------------------------------------------------

test('a resolved deterministic_rule binding with an unrecognized derivation shape omits inputSchema rather than fabricating one', () => {
  const { graph, capabilityId } = graphWithResolvableCapability('deriv1');
  const oddResolver = {
    name: 'odd-derivation',
    resolve: (contract: { readonly id: string }) => ({
      status: 'resolved' as const,
      binding: {
        id: `binding_${contract.id}_odd`,
        contractId: contract.id,
        implementationClass: 'deterministic_rule' as const,
        resolverName: 'odd-derivation',
        description: 'test double with a non-standard derivation shape',
        derivation: { somethingElse: true },
      },
    }),
  };
  const result = lowerCapabilitiesToManifest(graph, { resolvers: [oddResolver] });
  const declaration = result.declarations.find((d) => d.id === capabilityId);
  assert.ok(declaration);
  assert.equal(declaration!.execution!.mode, 'deterministic_rule');
  assert.equal('inputSchema' in declaration!.execution!, false);
});

test('deterministic: same graph, same resolvers -> byte-identical execution fields across two independent lowering runs', () => {
  const { graph: graphA, capabilityId } = graphWithResolvableCapability('det1');
  const { graph: graphB } = graphWithResolvableCapability('det1'); // same suffix -> same ids/content, independently constructed
  const resultA = lowerCapabilitiesToManifest(graphA);
  const resultB = lowerCapabilitiesToManifest(graphB);
  const declA = resultA.declarations.find((d) => d.id === capabilityId)!;
  const declB = resultB.declarations.find((d) => d.id === capabilityId)!;
  assert.deepEqual(declA.execution, declB.execution);
});

// ---------------------------------------------------------------------------
// Phase 3: a capability must not cross the executable-binding boundary
// (mode: 'deterministic_rule') carrying malformed/unvalidated
// contract-declared permission metadata. See capability-lowering.ts's
// `findInvalidRequiredPermission`.
// ---------------------------------------------------------------------------

test('Phase 3 (1): a single valid required permission still lowers to a deterministic_rule declaration, unchanged', () => {
  const { graph, capabilityId } = graphWithResolvableCapabilityAndCustomPermissions('p3-valid1', ['runtime.execute']);
  const result = lowerCapabilitiesToManifest(graph);
  const declaration = result.declarations.find((d) => d.id === capabilityId);
  assert.ok(declaration, 'expected the capability to still be lowered');
  assert.equal(declaration!.execution!.mode, 'deterministic_rule');
  assert.deepEqual(declaration!.execution!.requiredPermissionIds, ['runtime.execute']);
});

test('Phase 3 (2): multiple valid required permissions all lower unchanged', () => {
  const { graph, capabilityId } = graphWithResolvableCapabilityAndCustomPermissions('p3-valid2', ['runtime.execute', 'data.read', 'network.fetch']);
  const result = lowerCapabilitiesToManifest(graph);
  const declaration = result.declarations.find((d) => d.id === capabilityId);
  assert.ok(declaration, 'expected the capability to still be lowered');
  assert.equal(declaration!.execution!.mode, 'deterministic_rule');
  assert.deepEqual(declaration!.execution!.requiredPermissionIds, ['runtime.execute', 'data.read', 'network.fetch']);
});

test('Phase 3 (3): an invalid required permission prevents the capability from being lowered at all', () => {
  const { graph, capabilityId } = graphWithResolvableCapabilityAndCustomPermissions('p3-invalid1', ['not_a_valid_permission_id']);
  const result = lowerCapabilitiesToManifest(graph);
  assert.equal(result.declarations.find((d) => d.id === capabilityId), undefined);
  const outcome = result.outcomes.find((o) => o.contractId === capabilityId);
  assert.ok(outcome);
  assert.equal(outcome!.status, 'resolved'); // binding still resolved -- the contract itself is fine, only its permission metadata is malformed
  assert.equal(outcome!.declaration, undefined);
  assert.match(outcome!.reason ?? '', /invalid required permission/i);
  assert.match(outcome!.reason ?? '', /not_a_valid_permission_id/);
});

test('Phase 3 (4): a mixture of valid and invalid required permissions still prevents lowering (one bad entry is enough)', () => {
  const { graph, capabilityId } = graphWithResolvableCapabilityAndCustomPermissions('p3-mixed1', ['runtime.execute', 'totally-bogus', 'data.read']);
  const result = lowerCapabilitiesToManifest(graph);
  assert.equal(result.declarations.find((d) => d.id === capabilityId), undefined);
  const outcome = result.outcomes.find((o) => o.contractId === capabilityId);
  assert.ok(outcome);
  assert.equal(outcome!.status, 'resolved');
  assert.equal(outcome!.declaration, undefined);
  assert.match(outcome!.reason ?? '', /totally-bogus/);
});

test('Phase 3 (4b): an unrecognized permission domain (well-formed shape, unknown domain) is also rejected, not just malformed syntax', () => {
  const { graph, capabilityId } = graphWithResolvableCapabilityAndCustomPermissions('p3-baddomain1', ['spaceship.launch']);
  const result = lowerCapabilitiesToManifest(graph);
  assert.equal(result.declarations.find((d) => d.id === capabilityId), undefined);
  const outcome = result.outcomes.find((o) => o.contractId === capabilityId);
  assert.ok(outcome);
  assert.equal(outcome!.declaration, undefined);
  assert.match(outcome!.reason ?? '', /spaceship\.launch/);
});

test('Phase 3 (5): empty requiredPermissions is unaffected -- behaves exactly as before', () => {
  const { graph, capabilityId } = graphWithResolvableCapability('p3-empty1');
  const result = lowerCapabilitiesToManifest(graph);
  const declaration = result.declarations.find((d) => d.id === capabilityId);
  assert.ok(declaration, 'expected the capability to lower -- no required permissions were declared at all');
  assert.equal('requiredPermissionIds' in declaration!.execution!, false);
});

test('Phase 3 (6a): an unresolved capability is unaffected by the permission gate (it never reaches it)', () => {
  const { graph, capabilityId } = graphWithUnresolvedCapability('p3-unres1');
  const result = lowerCapabilitiesToManifest(graph);
  const outcome = result.outcomes.find((o) => o.contractId === capabilityId);
  assert.ok(outcome);
  assert.equal(outcome!.status, 'unresolved');
  assert.equal(outcome!.declaration, undefined);
  assert.doesNotMatch(outcome!.reason ?? '', /permission/i);
});

test('Phase 3 (6b): a denied (explicitly non_deterministic) capability is unaffected by the permission gate', () => {
  const { graph, capabilityId } = graphWithDeniedCapability('p3-den1');
  const result = lowerCapabilitiesToManifest(graph);
  const outcome = result.outcomes.find((o) => o.contractId === capabilityId);
  assert.ok(outcome);
  assert.equal(outcome!.status, 'denied');
  assert.equal(outcome!.declaration, undefined);
  assert.doesNotMatch(outcome!.reason ?? '', /permission/i);
});

test('Phase 3 (7): an invalid-permission capability never sneaks through as a model-mode declaration -- it produces no declaration at all', () => {
  const { graph, capabilityId } = graphWithResolvableCapabilityAndCustomPermissions('p3-nomodel1', ['definitely not valid']);
  const result = lowerCapabilitiesToManifest(graph);
  assert.equal(result.declarations.find((d) => d.id === capabilityId), undefined);
  // Assert over every declaration this run produced, not just the one
  // matching capabilityId, so a hidden second/fallback declaration for
  // the same capability (under any id) would still be caught.
  for (const declaration of result.declarations) {
    assert.notEqual(declaration.execution?.mode, undefined, 'no declaration in this result should exist without an execution field');
  }
  assert.equal(result.declarations.length, 0);
});

// ---------------------------------------------------------------------------
// Human-in-the-Loop Execution Class Lowering milestone: a resolved
// `human_in_the_loop` binding (Action Capability Binding v1's
// `ActionEscalationBindingResolver`, unmodified) now lowers into a
// manifest `CapabilityDeclaration` too, using this module's default
// resolver list (no options.resolvers override needed) -- mirroring
// exactly what `apps`/CLI-less production callers of
// `lowerCapabilitiesToManifest`/`packageXoirGraph` get out of the box.
// ---------------------------------------------------------------------------

/** A capability with NO linked rules (no `decision_node`/`heuristic`), but ONE linked `concept` node carrying `subtype: 'action'` -- the exact shape `ActionEscalationBindingResolver` requires (`contract.rules.length === 0 && actionKnowledgeRefs.length > 0`). Mirrors `contract-builder-action-refs.test.ts`'s own fixture conventions. */
function graphWithHumanInTheLoopCapability(suffix = 'hitl'): { readonly graph: XoirGraph; readonly capabilityId: string; readonly actionConceptId: string } {
  const graph = XoirGraph.create(XoirGraphId(`g-${suffix}`));
  const capabilityId = `capability:reconcile-invoice-${suffix}`;
  const actionConceptId = `concept:reconcile-action-${suffix}`;
  graph.createAndAddNode({
    id: XoirNodeId(capabilityId),
    kind: 'capability',
    properties: { name: 'Reconcile the invoice balance', description: 'Reconciles the invoice balance against payments received.' },
    confidence: 0.65,
    now,
  });
  graph.createAndAddNode({
    id: XoirNodeId(actionConceptId),
    kind: 'concept',
    properties: { definition: 'Reconcile the invoice balance against payments received' },
    subtype: 'action',
    confidence: 0.8,
    now,
  });
  graph.createAndAddEdge({ id: XoirEdgeId(`req-${suffix}`), kind: 'REQUIRES', fromId: XoirNodeId(actionConceptId), toId: XoirNodeId(capabilityId), now });
  return { graph, capabilityId, actionConceptId };
}

/** Same shape, but the capability node also carries `requiredPermissions` -- exercises `requiredPermissionIds` passthrough for the `human_in_the_loop` path exactly as `graphWithResolvableCapabilityAndPermissions` does for `deterministic_rule`. */
function graphWithHumanInTheLoopCapabilityAndPermissions(suffix = 'hitl-perm'): { readonly graph: XoirGraph; readonly capabilityId: string } {
  const graph = XoirGraph.create(XoirGraphId(`g-${suffix}`));
  const capabilityId = `capability:reconcile-invoice-${suffix}`;
  const actionConceptId = `concept:reconcile-action-${suffix}`;
  graph.createAndAddNode({
    id: XoirNodeId(capabilityId),
    kind: 'capability',
    properties: { name: 'Reconcile the invoice balance', description: 'Reconciles the invoice balance against payments received.', requiredPermissions: ['runtime.execute'] },
    confidence: 0.65,
    now,
  });
  graph.createAndAddNode({
    id: XoirNodeId(actionConceptId),
    kind: 'concept',
    properties: { definition: 'Reconcile the invoice balance against payments received' },
    subtype: 'action',
    confidence: 0.8,
    now,
  });
  graph.createAndAddEdge({ id: XoirEdgeId(`req-${suffix}`), kind: 'REQUIRES', fromId: XoirNodeId(actionConceptId), toId: XoirNodeId(capabilityId), now });
  return { graph, capabilityId };
}

test('HITL (1): a resolved human_in_the_loop binding is lowered into a manifest declaration using the DEFAULT resolver list (no options.resolvers override)', () => {
  const { graph, capabilityId } = graphWithHumanInTheLoopCapability('hitl1');
  const result = lowerCapabilitiesToManifest(graph); // no options -- exercises the production default
  assert.equal(result.discoveredCount, 1);
  assert.equal(result.resolvedCount, 1);
  const declaration = result.declarations.find((d) => d.id === capabilityId);
  assert.ok(declaration, 'expected the human_in_the_loop binding to be promoted to a manifest declaration');
});

test('HITL (2): execution.mode is human_in_the_loop', () => {
  const { graph, capabilityId } = graphWithHumanInTheLoopCapability('hitl2');
  const result = lowerCapabilitiesToManifest(graph);
  const declaration = result.declarations.find((d) => d.id === capabilityId)!;
  assert.equal(declaration.execution!.mode, 'human_in_the_loop');
});

test('HITL (3): execution.contractId/bindingId match the real contract/binding ids ActionEscalationBindingResolver actually produced (nothing fabricated)', () => {
  const { graph, capabilityId } = graphWithHumanInTheLoopCapability('hitl3');
  const result = lowerCapabilitiesToManifest(graph);
  const declaration = result.declarations.find((d) => d.id === capabilityId)!;
  assert.equal(declaration.execution!.contractId, capabilityId);
  // Same id convention ActionEscalationBindingResolver itself uses (action-escalation-resolver.ts): `binding_${contract.id}_${resolverName}`.
  assert.equal(declaration.execution!.bindingId, `binding_${capabilityId}_action-escalation-resolver`);
});

test('HITL (4): inputSchema is omitted, never fabricated -- a human_in_the_loop binding\'s derivation carries actionKnowledgeRefs, not a {rules:[...]} shape', () => {
  const { graph, capabilityId } = graphWithHumanInTheLoopCapability('hitl4');
  const result = lowerCapabilitiesToManifest(graph);
  const declaration = result.declarations.find((d) => d.id === capabilityId)!;
  assert.equal('inputSchema' in declaration.execution!, false);
});

test('HITL (5): required permissions are preserved verbatim from the real contract, exactly as for deterministic_rule', () => {
  const { graph, capabilityId } = graphWithHumanInTheLoopCapabilityAndPermissions('hitl5');
  const result = lowerCapabilitiesToManifest(graph);
  const declaration = result.declarations.find((d) => d.id === capabilityId)!;
  assert.deepEqual(declaration.execution!.requiredPermissionIds, ['runtime.execute']);
});

test('HITL (6): a capability with no linked rules AND no action/process knowledge stays unresolved -- ActionEscalationBindingResolver does not turn every ruleless capability into human_in_the_loop', () => {
  const { graph, capabilityId } = graphWithUnresolvedCapability('hitl6-bare');
  const result = lowerCapabilitiesToManifest(graph);
  const outcome = result.outcomes.find((o) => o.contractId === capabilityId);
  assert.ok(outcome);
  assert.equal(outcome!.status, 'unresolved');
  assert.equal(outcome!.declaration, undefined);
});

test('HITL (7): a resolved deterministic_rule capability is completely unaffected by the wider default resolver list -- identical mode/bindingId/inputSchema to before this milestone', () => {
  const { graph, capabilityId } = graphWithResolvableCapability('hitl7-det');
  const result = lowerCapabilitiesToManifest(graph); // default resolvers now include ActionEscalationBindingResolver too
  const declaration = result.declarations.find((d) => d.id === capabilityId)!;
  assert.equal(declaration.execution!.mode, 'deterministic_rule');
  assert.equal(declaration.execution!.bindingId, `binding_${capabilityId}_structured-comparison-resolver`);
  assert.ok(declaration.execution!.inputSchema, 'deterministic_rule inputSchema derivation is unaffected');
});

test('HITL (8): the two default resolvers never produce ambiguous for the same contract -- they partition disjointly by rules.length, per ActionEscalationBindingResolver\'s own documented invariant', () => {
  const { graph: detGraph, capabilityId: detId } = graphWithResolvableCapability('hitl8-det');
  const { graph: hitlGraph, capabilityId: hitlId } = graphWithHumanInTheLoopCapability('hitl8-hitl');
  const detResult = lowerCapabilitiesToManifest(detGraph);
  const hitlResult = lowerCapabilitiesToManifest(hitlGraph);
  assert.equal(detResult.outcomes.find((o) => o.contractId === detId)!.status, 'resolved');
  assert.equal(hitlResult.outcomes.find((o) => o.contractId === hitlId)!.status, 'resolved');
});

test('HITL (9): deterministic: same graph, same default resolvers -> byte-identical execution fields across two independent lowering runs, for the human_in_the_loop path too', () => {
  const { graph: graphA, capabilityId } = graphWithHumanInTheLoopCapability('hitl9');
  const { graph: graphB } = graphWithHumanInTheLoopCapability('hitl9');
  const resultA = lowerCapabilitiesToManifest(graphA);
  const resultB = lowerCapabilitiesToManifest(graphB);
  const declA = resultA.declarations.find((d) => d.id === capabilityId)!;
  const declB = resultB.declarations.find((d) => d.id === capabilityId)!;
  assert.deepEqual(declA.execution, declB.execution);
});
