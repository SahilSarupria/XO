import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId } from '@xo/xoir';
import { composeWorkflows, auditWorkflowExecutability } from '../../src/index.js';
import { buildReconciliationSectionFixtureGraph } from './reconciliation-fixture.js';
import { buildCorporateLawyerFixtureGraph } from './corporate-lawyer-fixture.js';

function buildAasthaFullGraph(): XoirGraph {
  const graph = buildReconciliationSectionFixtureGraph();

  // Add the 2 additional steps for Aastha Section 3 ("Brokerage Reconciliation"):
  // 1. Verify Expected Brokerage (decision node with calculation rule)
  // 2. Reconcile invoice amounts (action concept ref)
  // 3. Validate TDS and GST (decision node with tax rule)
  // 4. Identify discrepancies (decision node with discrepancy rule)
  // 5. Brokerage Validation (action concept ref)

  const sectionPath = ['Reconciliation Operations Manual', '3. Brokerage Reconciliation'] as const;

  // Add Step 1 (Verify Expected Brokerage - rule node)
  const capVerify = XoirNodeId('cap_verify_expected_brokerage');
  const ruleVerify = XoirNodeId('rule_verify_brokerage');
  graph.createAndAddNode({
    id: capVerify,
    kind: 'capability',
    properties: { name: 'Verify Expected Brokerage', description: 'Calculates and verifies expected brokerage against rate card' },
    sourceRefs: [{ documentPath: 'Aastha.pdf', sectionPath: [...sectionPath], pages: [3] }],
  });
  graph.createAndAddNode({
    id: ruleVerify,
    kind: 'decision_node',
    properties: {
      question: 'expected_brokerage == calculated_amount',
      outcome: 'verified',
      structuredCondition: {
        type: 'comparison',
        field: 'expected_brokerage',
        operator: '==',
        value: 100,
      },
    },
  });
  graph.createAndAddEdge({ id: XoirEdgeId('e_v1'), kind: 'REQUIRES', fromId: capVerify, toId: ruleVerify });

  // Add Step 5 (Brokerage Validation - action concept node)
  const capVal = XoirNodeId('cap_brokerage_validation');
  const actionVal = XoirNodeId('kn_validation_action');
  graph.createAndAddNode({
    id: capVal,
    kind: 'capability',
    properties: { name: 'Brokerage Validation', description: 'Final operational validation of brokerage entries' },
    sourceRefs: [{ documentPath: 'Aastha.pdf', sectionPath: [...sectionPath], pages: [3] }],
  });
  graph.createAndAddNode({
    id: actionVal,
    kind: 'concept',
    properties: { definition: 'Final validation of monthly brokerage statements' },
    subtype: 'action',
    sourceRefs: [{ documentPath: 'Aastha.pdf', sectionPath: [...sectionPath], pages: [3] }],
  });
  graph.createAndAddEdge({ id: XoirEdgeId('e_v5'), kind: 'REQUIRES', fromId: capVal, toId: actionVal });

  // Sequence evidence
  graph.createAndAddEdge({ id: XoirEdgeId('c_v1_s1'), kind: 'COMPLEMENTS', fromId: XoirNodeId('cap_obtain_statement'), toId: capVerify });
  graph.createAndAddEdge({ id: XoirEdgeId('c_s3_val'), kind: 'COMPLEMENTS', fromId: capVal, toId: XoirNodeId('cap_compare_expected_actual') });

  return graph;
}

function buildBurglaryGraph(): XoirGraph {
  const graph = XoirGraph.create(XoirGraphId('burglary-policy-graph'));

  // Section 1: Exclusions (Terrorism Exclusion)
  const sectionExcl = ['Burglary Policy', 'Exclusions'] as const;
  const capExcl = XoirNodeId('cap_terrorism_exclusion');
  const ruleExcl = XoirNodeId('rule_terrorism_prohibition');
  graph.createAndAddNode({
    id: capExcl,
    kind: 'capability',
    properties: { name: 'Terrorism Exclusion Verification', description: 'Verifies terrorism risk exclusion' },
    sourceRefs: [{ documentPath: 'burglary-policy.pdf', sectionPath: [...sectionExcl], pages: [3] }],
  });
  graph.createAndAddNode({
    id: ruleExcl,
    kind: 'constraint',
    properties: {
      rule: 'terrorism_cover == 0',
      structuredCondition: {
        type: 'comparison',
        field: 'terrorism_cover',
        operator: '==',
        value: 0,
      },
    },
  });
  graph.createAndAddEdge({ id: XoirEdgeId('e_ex1'), kind: 'REQUIRES', fromId: capExcl, toId: ruleExcl });

  // Section 2: Warranties (Security Warranty - unparseable temporal)
  const sectionWarr = ['Burglary Policy', 'Warranties'] as const;
  const capWarr = XoirNodeId('cap_security_warranty');
  const ruleWarr = XoirNodeId('rule_security_unparsed');
  graph.createAndAddNode({
    id: capWarr,
    kind: 'capability',
    properties: { name: 'Security Warranty Verification', description: '24 hours security warranty throughout policy period' },
    sourceRefs: [{ documentPath: 'burglary-policy.pdf', sectionPath: [...sectionWarr], pages: [2] }],
  });
  graph.createAndAddNode({
    id: ruleWarr,
    kind: 'heuristic',
    properties: {
      condition: '24 hours security is maintained throughout policy period',
      action: 'policy_valid',
      exceptionConditions: ['unless premises are undergoing permitted maintenance'],
    },
  });
  graph.createAndAddEdge({ id: XoirEdgeId('e_w1'), kind: 'REQUIRES', fromId: capWarr, toId: ruleWarr });

  // Section 3: Claim Conditions (Incorrect Info - categorical rule)
  const sectionClaims = ['Burglary Policy', 'Claim Conditions'] as const;
  const capClaim = XoirNodeId('cap_claim_info_validation');
  const ruleClaim = XoirNodeId('rule_claim_info');
  graph.createAndAddNode({
    id: capClaim,
    kind: 'capability',
    properties: { name: 'Claim Information Accuracy', description: 'Validates correctness of claim form info' },
    sourceRefs: [{ documentPath: 'burglary-policy.pdf', sectionPath: [...sectionClaims], pages: [4] }],
  });
  graph.createAndAddNode({
    id: ruleClaim,
    kind: 'decision_node',
    properties: {
      question: 'incorrect_information == 0',
      outcome: 'claim_valid',
      structuredCondition: {
        type: 'comparison',
        field: 'incorrect_information',
        operator: '==',
        value: 0,
      },
    },
  });
  graph.createAndAddEdge({ id: XoirEdgeId('e_c1'), kind: 'REQUIRES', fromId: capClaim, toId: ruleClaim });

  return graph;
}

function runDomainAudit(domainName: string, graph: XoirGraph) {
  console.log(`\n==================================================`);
  console.log(`DOMAIN AUDIT: ${domainName}`);
  console.log(`==================================================`);

  const composeResult = composeWorkflows(graph);
  if (!composeResult.ok) {
    console.error(`Composition failed: ${composeResult.error.message}`);
    return;
  }

  const workflows = composeResult.value;
  console.log(`Workflow Count: ${workflows.length}`);

  let totalSteps = 0;
  workflows.forEach((wf, i) => {
    totalSteps += wf.steps.length;
    const report = auditWorkflowExecutability(wf, graph);

    console.log(`\n--- Workflow #${i + 1}: ${wf.name} (ID: ${wf.id}) ---`);
    console.log(`Status: ${report.status}`);
    console.log(`Step Count: ${wf.steps.length}`);
    console.log(`Proven Dependencies: ${report.provenDependencies.length}`);
    console.log(`Suggestive Ordering: ${report.suggestiveOrdering.length}`);
    console.log(`Blockers Count: ${report.blockers.length}`);

    report.steps.forEach((s) => {
      console.log(`  * Step: [${s.capabilityId}] "${s.capabilityName}"`);
      console.log(`    Category: ${s.strategyEvidence.category}`);
      console.log(`    Authority: ${s.authority}`);
      console.log(`    BindingID: ${s.bindingId ?? 'None'}`);
      console.log(`    Details: ${s.strategyEvidence.details}`);
      if (s.blockers.length > 0) {
        console.log(`    Blockers: ${s.blockers.map((b) => b.kind).join(', ')}`);
      }
    });
  });

  console.log(`Total Capabilities / Steps across ${domainName}: ${totalSteps}`);
}

runDomainAudit('Aastha Reconciliation', buildAasthaFullGraph());
runDomainAudit('Burglary Policy', buildBurglaryGraph());
runDomainAudit('Commercial Property / Corporate Lawyer', buildCorporateLawyerFixtureGraph());
