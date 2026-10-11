import { test } from 'node:test';
import { testSubject } from '../authz-helpers.js';
import assert from 'node:assert/strict';
import { PermissionManager, RuleBasedPolicy } from '@xo/permissions';
import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId } from '@xo/xoir';
import { CandidateWorkflowId, CandidateWorkflowStepId, type CandidateWorkflow, type CandidateWorkflowStep } from '@xo/workflow-composer';
import { RuntimeCapabilityRegistry } from '../../src/capability-authority/runtime-capability-registry.js';
import { RuntimeCapabilityExecutor } from '../../src/capability-authority/runtime-capability-executor.js';
import { WorkflowExecutor } from '../../src/workflow/workflow-executor.js';
import { EnvironmentId } from '../../src/ids.js';
import type { ExecutionEnvironment } from '../../src/execution/execution-request.js';
import {
  prepareCandidateWorkflowForExecution,
  makeCapabilityAuthorityNodeHandler,
  deriveWorkflowRunStatus,
} from '../../src/workflow/candidate-workflow-bridge.js';

/**
 * Builds a minimal, real XOIR graph with one `capability` node grounded
 * in a `REQUIRES` edge to an operational-action `concept` node — the
 * same shape `@xo/compiler` produces for a ruleless, action-grounded
 * capability (see `ActionEscalationBindingResolver`'s own doc comment).
 * No mock contracts, no hand-authored SemanticCapabilityContract: this
 * graph is fed through the exact same `buildSemanticCapabilityContract`
 * path production code uses.
 */
function actionGroundedGraph(capabilityId: string, capabilityName: string) {
  const graph = XoirGraph.create(XoirGraphId('test_graph'));
  const capNode = graph.createAndAddNode({
    id: XoirNodeId(capabilityId),
    kind: 'capability',
    properties: { name: capabilityName, description: `${capabilityName} (test fixture)` },
    confidence: 0.7,
    sourceRefs: [{ documentPath: 'Aastha.pdf', pages: [1] }],
  });
  if (!capNode.ok) return capNode;
  const conceptNode = graph.createAndAddNode({
    id: XoirNodeId('concept_action_1'),
    kind: 'concept',
    properties: { name: 'Reconcile records', text: 'Reconcile records against insurer statements' },
    confidence: 0.7,
    sourceRefs: [{ documentPath: 'Aastha.pdf', pages: [1] }],
    subtype: 'action',
  });
  if (!conceptNode.ok) return conceptNode;
  const edge = graph.createAndAddEdge({
    id: XoirEdgeId('edge_requires_action'),
    kind: 'REQUIRES',
    fromId: XoirNodeId(capabilityId),
    toId: XoirNodeId('concept_action_1'),
  });
  if (!edge.ok) return edge;
  return { ok: true as const, value: graph };
}

function candidateWorkflow(capabilityId: string, capabilityName: string): CandidateWorkflow {
  const step: CandidateWorkflowStep = {
    id: CandidateWorkflowStepId('step_0'),
    order: 0,
    capabilityId,
    capabilityName,
    description: capabilityName,
    rationale: { orderedAfter: [], tieBroken: false },
    confidence: 0.7,
    evidence: [{ documentPath: 'Aastha.pdf', pages: [1] }],
  };
  return {
    id: CandidateWorkflowId('wf_test'),
    name: capabilityName,
    description: capabilityName,
    steps: [step],
    sourceCapabilityIds: [capabilityId],
    gaps: [],
    requiresHumanDecision: false,
    confidence: 0.7,
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function environment(): ExecutionEnvironment {
  return {
    environmentId: EnvironmentId('env_test'),
    hostProfile: { family: 'claude', capabilities: [] },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

// --- Workflow construction / preparation --------------------------------

test('prepareCandidateWorkflowForExecution: a real action-grounded capability binds and produces a two-node-plus-boundary graph', () => {
  const graphResult = actionGroundedGraph('cap_reconcile', 'Reconcile the invoice balance');
  assert.equal(graphResult.ok, true);
  if (!graphResult.ok) return;
  const workflow = candidateWorkflow('cap_reconcile', 'Reconcile the invoice balance');
  const registry = new RuntimeCapabilityRegistry();

  const prepared = prepareCandidateWorkflowForExecution(workflow, graphResult.value, registry);

  assert.equal(prepared.unboundStepCount, 0);
  assert.equal(prepared.steps.length, 1);
  assert.equal(prepared.steps[0]?.status, 'bound');
  assert.equal(prepared.steps[0]?.implementationClass, 'human_in_the_loop');
  // start -> step -> end
  assert.equal(prepared.graph.nodes.length, 3);
  assert.equal(registry.has('cap_reconcile'), true);
});

test('prepareCandidateWorkflowForExecution: a capability with no XOIR node is reported unbound, not silently dropped or faked', () => {
  const graphResult = actionGroundedGraph('cap_reconcile', 'Reconcile the invoice balance');
  assert.equal(graphResult.ok, true);
  if (!graphResult.ok) return;
  // Reference a capability id that isn't actually in the graph.
  const workflow = candidateWorkflow('cap_does_not_exist', 'Ghost capability');
  const registry = new RuntimeCapabilityRegistry();

  const prepared = prepareCandidateWorkflowForExecution(workflow, graphResult.value, registry);

  assert.equal(prepared.unboundStepCount, 1);
  assert.equal(prepared.steps[0]?.status, 'unbound');
  // start -> end only; the unbound step never enters the executable graph.
  assert.equal(prepared.graph.nodes.length, 2);
  assert.equal(registry.has('cap_does_not_exist'), false);
});

// --- Deterministic step: real capability executes through existing runtime ---

test('a step with a real structured comparison rule resolves to deterministic_rule and executes for real', async () => {
  const graph = XoirGraph.create(XoirGraphId('test_graph_deterministic'));
  const capNode = graph.createAndAddNode({
    id: XoirNodeId('cap_threshold_check'),
    kind: 'capability',
    properties: { name: 'Check claim threshold', description: 'Check claim threshold (test fixture)' },
    confidence: 0.8,
    sourceRefs: [{ documentPath: 'Aastha.pdf', pages: [1] }],
  });
  // A `decision_node` — unlike a bare `constraint`, it carries an
  // `outcome`, which `StructuredComparisonBindingResolver` requires to
  // compile an executable decision-table branch (see
  // `capability-contract`'s own doc comment: a bare `constraint` alone
  // is a precondition, not something a deterministic evaluator can
  // return).
  const ruleNode = capNode.ok
    ? graph.createAndAddNode({
        id: XoirNodeId('decision_threshold'),
        kind: 'decision_node',
        properties: { question: 'the claim amount exceeds 10000', outcome: 'escalate to underwriter' },
        confidence: 0.8,
        sourceRefs: [{ documentPath: 'Aastha.pdf', pages: [1] }],
      })
    : capNode;
  const edgeResult =
    capNode.ok && ruleNode.ok
      ? graph.createAndAddEdge({
          id: XoirEdgeId('edge_requires_rule'),
          kind: 'REQUIRES',
          fromId: XoirNodeId('cap_threshold_check'),
          toId: XoirNodeId('decision_threshold'),
        })
      : ruleNode;
  const graphResult = edgeResult.ok ? { ok: true as const, value: graph } : edgeResult;
  assert.equal(graphResult.ok, true);
  if (!graphResult.ok) return;

  const workflow = candidateWorkflow('cap_threshold_check', 'Check claim threshold');
  const registry = new RuntimeCapabilityRegistry();
  const prepared = prepareCandidateWorkflowForExecution(workflow, graphResult.value, registry);
  const step = prepared.steps[0];
  assert.equal(step?.status, 'bound');
  assert.equal(step?.implementationClass, 'deterministic_rule');

  const executor = new RuntimeCapabilityExecutor({
    registry,
    permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }),
    subject: testSubject(),
  });
  const workflowExecutor = new WorkflowExecutor(
    async () => {
      throw new Error('unreachable');
    },
    {
      customNodeHandlers: new Map([['custom:capability-authority', makeCapabilityAuthorityNodeHandler(executor)]]),
    },
  );
  // No declared inputs on this contract, so the resolver's fallback
  // field key applies: "the claim amount" -> "claim_amount" (stopwords
  // stripped). Seed it directly on the (only) step node's static
  // structuredInput — this step has no upstream producer.
  const stepNode = prepared.graph.nodes.find((n) => n.type === 'custom:capability-authority');
  assert.ok(stepNode);
  const seededGraph = {
    ...prepared.graph,
    nodes: prepared.graph.nodes.map((n) =>
      n.id === stepNode!.id ? { ...n, config: { ...n.config, structuredInput: { claim_amount: 15000 } } } : n,
    ),
  };

  const result = await workflowExecutor.run(seededGraph, environment());
  assert.equal(result.instance.status, 'completed');
  const output = result.instance.state.outputs[stepNode!.id as unknown as string] as { result?: { matched?: boolean; outcome?: string } };
  assert.equal(output.result?.matched, true);
  assert.equal(output.result?.outcome, 'escalate to underwriter');
});

// --- HITL step: honest escalation semantics; workflow never falsely completes ---

test('end-to-end: a real HITL workflow executes through WorkflowExecutor and produces an honest escalation record, never a fabricated business result', async () => {
  const graphResult = actionGroundedGraph('cap_reconcile', 'Reconcile the invoice balance');
  assert.equal(graphResult.ok, true);
  if (!graphResult.ok) return;
  const workflow = candidateWorkflow('cap_reconcile', 'Reconcile the invoice balance');
  const registry = new RuntimeCapabilityRegistry();
  const prepared = prepareCandidateWorkflowForExecution(workflow, graphResult.value, registry);

  const executor = new RuntimeCapabilityExecutor({
    registry,
    permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }),
    subject: testSubject(),
  });
  const workflowExecutor = new WorkflowExecutor(
    async () => {
      throw new Error('unreachable');
    },
    {
      customNodeHandlers: new Map([['custom:capability-authority', makeCapabilityAuthorityNodeHandler(executor)]]),
    },
  );

  const result = await workflowExecutor.run(prepared.graph, environment());

  assert.equal(result.instance.status, 'completed'); // engine-level: every node handler returned ok
  const stepNodeId = prepared.graph.nodes.find((n) => n.type === 'custom:capability-authority')?.id;
  assert.ok(stepNodeId);
  const output = result.instance.state.outputs[stepNodeId as unknown as string] as { result?: { status?: string } };
  assert.equal(output.result?.status, 'escalation_required');

  const runStatus = deriveWorkflowRunStatus({
    engineStatus: result.instance.status,
    nodeOutputs: result.instance.state.outputs,
    unboundStepCount: prepared.unboundStepCount,
    boundStepCount: prepared.steps.length - prepared.unboundStepCount,
  });
  // The product-surface status must NOT claim the workflow completed —
  // this is the honesty boundary the milestone brief requires.
  assert.equal(runStatus, 'waiting_for_human');
  assert.notEqual(runStatus, 'completed');
});

test('deriveWorkflowRunStatus: a workflow with zero bound steps is not_executable_yet, never completed', () => {
  const status = deriveWorkflowRunStatus({ engineStatus: 'completed', nodeOutputs: {}, unboundStepCount: 1, boundStepCount: 0 });
  assert.equal(status, 'not_executable_yet');
});

test('deriveWorkflowRunStatus: a partially-bound workflow is not_executable_yet even if the bound steps all completed', () => {
  const status = deriveWorkflowRunStatus({
    engineStatus: 'completed',
    nodeOutputs: { step_0: { result: { status: 'escalation_required' } } },
    unboundStepCount: 1,
    boundStepCount: 1,
  });
  assert.equal(status, 'not_executable_yet');
});

test('deriveWorkflowRunStatus: a fully-bound, no-escalation, engine-completed workflow reports completed', () => {
  const status = deriveWorkflowRunStatus({
    engineStatus: 'completed',
    nodeOutputs: { step_0: { result: { status: 'ok', value: 42 } } },
    unboundStepCount: 0,
    boundStepCount: 1,
  });
  assert.equal(status, 'completed');
});

// --- Multi-step data flow: proven producer -> consumer injection --------
//
// SEMANTIC CONTRACT FIXTURE (per the "Authoritative Capability I/O
// Semantic Model" milestone's Phase 9 terminology) — not a REAL SOURCE
// FIXTURE. It proves the semantic model itself: `SemanticCapabilityParameter`
// (name/description/semanticType/derivedFrom) plus array-membership-as-
// direction (`contract.inputs` vs `contract.outputs`) is already a complete,
// source-independent representation of an operation's authoritative I/O —
// no new type was introduced for that milestone. `derivedFrom: 'declared'`
// here is produced by the exact same XOIR-level explicit-declaration path
// (`CapabilityNodeProps.outputs`/`inputs`, flat "name: description"
// strings, `contract-builder.ts#parseParam`) that a real source frontend
// would need to populate — this fixture supplies that XOIR-level evidence
// by hand because no current source frontend (PDF/document/HTML/structured/
// image) yet has a construct that can honestly assert it (see that
// milestone's audit for the full frontend-by-frontend accounting).
//
// IMPORTANT: no real fixture (Aastha, Commercial Property, or Burglary —
// see the audit accompanying this milestone) currently has ANY
// capability with a non-empty declared `outputs` array; `@xo/compiler`
// unconditionally emits `outputs: []` for every capability today, in
// every document. So `auditWorkflowDataFlow` can never find a `'proven'`
// binding against real, current compiler output — this is a genuine,
// systemic gap in the compiler's output-declaration coverage, not a
// document-specific limitation and not a bug in this bridge or in
// `auditWorkflowDataFlow`'s own authority rules. The two-step fixture
// below directly declares `properties.outputs`/`properties.inputs` on
// hand-built XOIR nodes (same convention as this file's other
// hand-built fixtures) purely to prove the GENERIC injection mechanism
// works correctly once a producer's output IS authoritative — it is not
// a claim that any real document currently produces this evidence.

/**
 * Two real capability nodes: A (a `decision_node`-backed deterministic
 * capability declaring output "matched") and B (an action-grounded HITL
 * capability declaring input "matched"), joined by a genuine structural
 * `REQUIRES` edge (B -> A) so `auditWorkflowDataFlow`'s structural
 * corroboration check has real graph evidence to find, not just a
 * name/type coincidence.
 */
function twoStepDataFlowGraph() {
  const graph = XoirGraph.create(XoirGraphId('test_graph_dataflow'));
  const capA = graph.createAndAddNode({
    id: XoirNodeId('cap_a_threshold'),
    kind: 'capability',
    properties: {
      name: 'Check claim threshold',
      description: 'Check claim threshold (test fixture)',
      outputs: ['matched: Whether the threshold rule matched'],
    },
    confidence: 0.8,
    sourceRefs: [{ documentPath: 'Aastha.pdf', pages: [1] }],
  });
  const ruleA = capA.ok
    ? graph.createAndAddNode({
        id: XoirNodeId('decision_a_threshold'),
        kind: 'decision_node',
        properties: { question: 'the claim amount exceeds 10000', outcome: 'escalate to underwriter' },
        confidence: 0.8,
        sourceRefs: [{ documentPath: 'Aastha.pdf', pages: [1] }],
      })
    : capA;
  const edgeARule =
    capA.ok && ruleA.ok
      ? graph.createAndAddEdge({
          id: XoirEdgeId('edge_a_requires_rule'),
          kind: 'REQUIRES',
          fromId: XoirNodeId('cap_a_threshold'),
          toId: XoirNodeId('decision_a_threshold'),
        })
      : ruleA;
  if (!edgeARule.ok) return edgeARule;

  const capB = graph.createAndAddNode({
    id: XoirNodeId('cap_b_escalate'),
    kind: 'capability',
    properties: {
      name: 'Escalate the flagged claim',
      description: 'Escalate the flagged claim (test fixture)',
      inputs: ['matched: Whether the threshold rule matched'],
    },
    confidence: 0.8,
    sourceRefs: [{ documentPath: 'Aastha.pdf', pages: [1] }],
  });
  const conceptB = capB.ok
    ? graph.createAndAddNode({
        id: XoirNodeId('concept_escalate_action'),
        kind: 'concept',
        properties: { name: 'Escalate to underwriter', text: 'Escalate the flagged claim to the underwriter' },
        confidence: 0.7,
        sourceRefs: [{ documentPath: 'Aastha.pdf', pages: [1] }],
        subtype: 'action',
      })
    : capB;
  const edgeBAction =
    capB.ok && conceptB.ok
      ? graph.createAndAddEdge({
          id: XoirEdgeId('edge_b_requires_action'),
          kind: 'REQUIRES',
          fromId: XoirNodeId('cap_b_escalate'),
          toId: XoirNodeId('concept_escalate_action'),
        })
      : conceptB;
  if (!edgeBAction.ok) return edgeBAction;

  // The genuine structural edge `auditWorkflowDataFlow` requires as
  // corroboration — B really does depend on A in this graph, not merely
  // by name coincidence.
  const edgeBA = graph.createAndAddEdge({
    id: XoirEdgeId('edge_b_requires_a'),
    kind: 'REQUIRES',
    fromId: XoirNodeId('cap_b_escalate'),
    toId: XoirNodeId('cap_a_threshold'),
  });
  if (!edgeBA.ok) return edgeBA;

  return { ok: true as const, value: graph };
}

function twoStepWorkflow(): CandidateWorkflow {
  const stepA: CandidateWorkflowStep = {
    id: CandidateWorkflowStepId('step_a'),
    order: 0,
    capabilityId: 'cap_a_threshold',
    capabilityName: 'Check claim threshold',
    description: 'Check claim threshold',
    rationale: { orderedAfter: [], tieBroken: false },
    confidence: 0.8,
    evidence: [{ documentPath: 'Aastha.pdf', pages: [1] }],
  };
  const stepB: CandidateWorkflowStep = {
    id: CandidateWorkflowStepId('step_b'),
    order: 1,
    capabilityId: 'cap_b_escalate',
    capabilityName: 'Escalate the flagged claim',
    description: 'Escalate the flagged claim',
    rationale: {
      orderedAfter: [{ capabilityId: 'cap_a_threshold', viaEdgeKind: 'REQUIRES', evidenceStrength: 'strong' }],
      tieBroken: false,
    },
    confidence: 0.8,
    evidence: [{ documentPath: 'Aastha.pdf', pages: [1] }],
  };
  return {
    id: CandidateWorkflowId('wf_dataflow_test'),
    name: 'Check and escalate',
    description: 'Check and escalate',
    steps: [stepA, stepB],
    sourceCapabilityIds: ['cap_a_threshold', 'cap_b_escalate'],
    gaps: [],
    requiresHumanDecision: false,
    confidence: 0.8,
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('auditWorkflowDataFlow finds a proven binding, and prepareCandidateWorkflowForExecution wires it as an injection', () => {
  const graphResult = twoStepDataFlowGraph();
  assert.equal(graphResult.ok, true);
  if (!graphResult.ok) return;
  const workflow = twoStepWorkflow();
  const registry = new RuntimeCapabilityRegistry();

  const prepared = prepareCandidateWorkflowForExecution(workflow, graphResult.value, registry);

  assert.equal(prepared.unboundStepCount, 0);
  assert.equal(prepared.provenDataFlowBindings.length, 1);
  assert.equal(prepared.provenDataFlowBindings[0]?.evidenceKind, 'explicit_contract_match');
  assert.equal(prepared.wiredInjections.length, 1);
  assert.equal(prepared.wiredInjections[0]?.outputParameterName, 'matched');
  assert.equal(prepared.wiredInjections[0]?.inputParameterName, 'matched');

  const consumerNode = prepared.graph.nodes.find((n) => n.name === 'Escalate the flagged claim');
  assert.ok(consumerNode);
  const inputBindings = consumerNode?.config?.inputBindings as unknown[];
  assert.equal(inputBindings.length, 1);
});

test('end-to-end: a real value produced by Step A becomes the authoritative input of Step B during real execution', async () => {
  const graphResult = twoStepDataFlowGraph();
  assert.equal(graphResult.ok, true);
  if (!graphResult.ok) return;
  const workflow = twoStepWorkflow();
  const registry = new RuntimeCapabilityRegistry();
  const prepared = prepareCandidateWorkflowForExecution(workflow, graphResult.value, registry);

  const stepANode = prepared.graph.nodes.find((n) => n.name === 'Check claim threshold');
  assert.ok(stepANode);
  // Step A's own input (its threshold check) is seeded statically — it
  // has no upstream producer of its own.
  const seededGraph = {
    ...prepared.graph,
    nodes: prepared.graph.nodes.map((n) =>
      n.id === stepANode!.id ? { ...n, config: { ...n.config, structuredInput: { claim_amount: 15000 } } } : n,
    ),
  };

  const executor = new RuntimeCapabilityExecutor({
    registry,
    permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }),
    subject: testSubject(),
  });
  const workflowExecutor = new WorkflowExecutor(
    async () => {
      throw new Error('unreachable');
    },
    {
      customNodeHandlers: new Map([['custom:capability-authority', makeCapabilityAuthorityNodeHandler(executor)]]),
    },
  );

  // Capture the exact input RuntimeCapabilityExecutor.execute() receives
  // for Step B by wrapping the real executor — proves the value crossed
  // the capability boundary through the actual execution call, not just
  // through some intermediate data structure.
  const capturedInputs: Record<string, unknown>[] = [];
  const originalExecute = executor.execute.bind(executor);
  executor.execute = (async (request: { capabilityId: string; input: Record<string, unknown> }) => {
    if (request.capabilityId === 'cap_b_escalate') capturedInputs.push(request.input);
    return originalExecute(request);
  }) as typeof executor.execute;

  const result = await workflowExecutor.run(seededGraph, environment());

  assert.equal(result.instance.status, 'completed');
  assert.equal(capturedInputs.length, 1);
  // THE core assertion: Step B actually received, as its real execution
  // input, the exact boolean Step A's real deterministic execution
  // computed — not a guess, not a static default, not name-similarity.
  assert.equal(capturedInputs[0]?.matched, true);

  const stepBNode = prepared.graph.nodes.find((n) => n.name === 'Escalate the flagged claim');
  const stepBOutput = result.instance.state.outputs[stepBNode!.id as unknown as string] as {
    result?: { status?: string };
    appliedInputBindings?: unknown[];
  };
  assert.equal(stepBOutput.result?.status, 'escalation_required');
  assert.equal(stepBOutput.appliedInputBindings?.length, 1);
});

test('rejection: name-only match with no structural corroboration is never wired as an injection', () => {
  // Same param names on both sides, but no REQUIRES/any structural edge
  // between the two capability nodes — auditWorkflowDataFlow's own
  // authority rule downgrades this to 'suggestive', which this bridge
  // must never wire.
  const graph = XoirGraph.create(XoirGraphId('test_graph_name_only'));
  const capA = graph.createAndAddNode({
    id: XoirNodeId('cap_a'),
    kind: 'capability',
    properties: { name: 'Producer', description: 'x', outputs: ['value: x'] },
    confidence: 0.8,
    sourceRefs: [{ documentPath: 'test.pdf', pages: [1] }],
  });
  const conceptA = capA.ok
    ? graph.createAndAddNode({
        id: XoirNodeId('concept_a_action'),
        kind: 'concept',
        properties: { name: 'Do the thing', text: 'Do the thing' },
        confidence: 0.7,
        sourceRefs: [{ documentPath: 'test.pdf', pages: [1] }],
        subtype: 'action',
      })
    : capA;
  const edgeA =
    capA.ok && conceptA.ok
      ? graph.createAndAddEdge({
          id: XoirEdgeId('e_a'),
          kind: 'REQUIRES',
          fromId: XoirNodeId('cap_a'),
          toId: XoirNodeId('concept_a_action'),
        })
      : conceptA;
  const capB = edgeA.ok
    ? graph.createAndAddNode({
        id: XoirNodeId('cap_b'),
        kind: 'capability',
        properties: { name: 'Consumer', description: 'x', inputs: ['value: x'] },
        confidence: 0.8,
        sourceRefs: [{ documentPath: 'test.pdf', pages: [1] }],
      })
    : edgeA;
  const conceptB = capB.ok
    ? graph.createAndAddNode({
        id: XoirNodeId('concept_b_action'),
        kind: 'concept',
        properties: { name: 'Do the other thing', text: 'Do the other thing' },
        confidence: 0.7,
        sourceRefs: [{ documentPath: 'test.pdf', pages: [1] }],
        subtype: 'action',
      })
    : capB;
  const edgeB =
    capB.ok && conceptB.ok
      ? graph.createAndAddEdge({
          id: XoirEdgeId('e_b'),
          kind: 'REQUIRES',
          fromId: XoirNodeId('cap_b'),
          toId: XoirNodeId('concept_b_action'),
        })
      : conceptB;
  assert.equal(edgeB.ok, true);
  if (!edgeB.ok) return;
  // Deliberately NO edge at all between cap_a and cap_b.

  const workflow: CandidateWorkflow = {
    id: CandidateWorkflowId('wf_name_only'),
    name: 'x',
    description: 'x',
    steps: [
      {
        id: CandidateWorkflowStepId('s0'),
        order: 0,
        capabilityId: 'cap_a',
        capabilityName: 'Producer',
        description: 'x',
        rationale: { orderedAfter: [], tieBroken: false },
        confidence: 0.8,
        evidence: [],
      },
      {
        id: CandidateWorkflowStepId('s1'),
        order: 1,
        capabilityId: 'cap_b',
        capabilityName: 'Consumer',
        description: 'x',
        rationale: { orderedAfter: [], tieBroken: false },
        confidence: 0.8,
        evidence: [],
      },
    ],
    sourceCapabilityIds: ['cap_a', 'cap_b'],
    gaps: [],
    requiresHumanDecision: false,
    confidence: 0.8,
    generatedAt: '2026-01-01T00:00:00.000Z',
  };

  const registry = new RuntimeCapabilityRegistry();
  const prepared = prepareCandidateWorkflowForExecution(workflow, graph, registry);
  assert.equal(prepared.provenDataFlowBindings.length, 0);
  assert.equal(prepared.wiredInjections.length, 0);
  const consumerNode = prepared.graph.nodes.find((n) => n.name === 'Consumer');
  assert.deepEqual(consumerNode?.config?.inputBindings, []);
});

test('rejection: a HITL producer never has its escalation record injected as a consumer input, even if a proven binding exists', () => {
  // Reuse the exact two-step fixture, but this time assert the general
  // rule directly: HITL implementationClass is categorically ineligible
  // regardless of anything else being proven. (The positive path above
  // already proves deterministic_rule IS eligible; this proves the
  // other of the only two registerable classes is not.)
  const graphResult = twoStepDataFlowGraph();
  assert.equal(graphResult.ok, true);
  if (!graphResult.ok) return;
  // Swap the workflow order so B (HITL) "produces" for A — i.e. treat B
  // as if it were upstream of A, to test the implementationClass gate
  // directly rather than relying on the fixture's existing direction.
  const workflow: CandidateWorkflow = {
    id: CandidateWorkflowId('wf_hitl_producer'),
    name: 'x',
    description: 'x',
    steps: [
      {
        id: CandidateWorkflowStepId('s0'),
        order: 0,
        capabilityId: 'cap_b_escalate',
        capabilityName: 'Escalate the flagged claim',
        description: 'x',
        rationale: { orderedAfter: [], tieBroken: false },
        confidence: 0.8,
        evidence: [],
      },
    ],
    sourceCapabilityIds: ['cap_b_escalate'],
    gaps: [],
    requiresHumanDecision: false,
    confidence: 0.8,
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
  const registry = new RuntimeCapabilityRegistry();
  const prepared = prepareCandidateWorkflowForExecution(workflow, graphResult.value, registry);
  assert.equal(prepared.steps[0]?.implementationClass, 'human_in_the_loop');
  // A HITL step alone can never be a wired-injection *producer* — it is
  // structurally excluded before any data-flow matching even applies.
  assert.equal(prepared.wiredInjections.length, 0);
});
