import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId } from '@xo/xoir';
import { buildSemanticCapabilityContract, buildAllSemanticCapabilityContracts } from '../src/contract-builder.js';
function buildGraphWithCapability() {
    const graph = XoirGraph.create(XoirGraphId('g1'));
    graph.createAndAddNode({
        id: XoirNodeId('capability:claim-evaluation'),
        kind: 'capability',
        properties: { name: 'Evaluate Claim', description: 'Evaluates a submitted claim against policy rules', category: 'evaluation', determinism: 'deterministic' },
    });
    graph.createAndAddNode({
        id: XoirNodeId('decision:deny-large-claim'),
        kind: 'decision_node',
        properties: { question: 'the claimed loss amount exceeds 10000', outcome: 'deny the claim', rationale: 'Large claims require manual review' },
    });
    graph.createAndAddNode({
        id: XoirNodeId('knowledge:unrelated'),
        kind: 'knowledge',
        properties: { statement: 'Policies renew annually', domain: 'general' },
    });
    graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'REQUIRES', fromId: XoirNodeId('decision:deny-large-claim'), toId: XoirNodeId('capability:claim-evaluation') });
    return graph;
}
test('builds a contract from a capability node with one linked decision_node', () => {
    const graph = buildGraphWithCapability();
    const result = buildSemanticCapabilityContract(graph, XoirNodeId('capability:claim-evaluation'));
    assert.equal(result.ok, true);
    if (!result.ok)
        return;
    assert.equal(result.value.id, 'capability:claim-evaluation');
    assert.equal(result.value.name, 'Evaluate Claim');
    assert.equal(result.value.determinism, 'deterministic');
    assert.equal(result.value.rules.length, 1);
    assert.equal(result.value.rules[0].condition, 'the claimed loss amount exceeds 10000');
    assert.equal(result.value.rules[0].outcome, 'deny the claim');
    assert.deepEqual(result.value.sourceXoirNodeIds, ['capability:claim-evaluation', 'decision:deny-large-claim']);
});
test('a capability with no linked rule nodes gets an empty rules array, not an error', () => {
    const graph = XoirGraph.create(XoirGraphId('g2'));
    graph.createAndAddNode({ id: XoirNodeId('capability:bare'), kind: 'capability', properties: { name: 'Bare', description: 'No linked rules' } });
    const result = buildSemanticCapabilityContract(graph, XoirNodeId('capability:bare'));
    assert.equal(result.ok, true);
    if (!result.ok)
        return;
    assert.deepEqual(result.value.rules, []);
});
test('fails with CONTRACT_SOURCE_NODE_NOT_FOUND for a missing node id', () => {
    const graph = buildGraphWithCapability();
    const result = buildSemanticCapabilityContract(graph, XoirNodeId('capability:does-not-exist'));
    assert.equal(result.ok, false);
    if (result.ok)
        return;
    assert.equal(result.error.code, 'XO_CONTRACT_SOURCE_NODE_NOT_FOUND');
});
test('fails with CONTRACT_SOURCE_NODE_INVALID for a non-capability node id', () => {
    const graph = buildGraphWithCapability();
    const result = buildSemanticCapabilityContract(graph, XoirNodeId('knowledge:unrelated'));
    assert.equal(result.ok, false);
    if (result.ok)
        return;
    assert.equal(result.error.code, 'XO_CONTRACT_SOURCE_NODE_INVALID');
});
test('is deterministic: building twice from the same graph produces deep-equal contracts', () => {
    const graph = buildGraphWithCapability();
    const first = buildSemanticCapabilityContract(graph, XoirNodeId('capability:claim-evaluation'));
    const second = buildSemanticCapabilityContract(graph, XoirNodeId('capability:claim-evaluation'));
    assert.deepEqual(first, second);
});
test('buildAllSemanticCapabilityContracts finds every capability node in deterministic id order', () => {
    const graph = XoirGraph.create(XoirGraphId('g3'));
    graph.createAndAddNode({ id: XoirNodeId('capability:z'), kind: 'capability', properties: { name: 'Z', description: 'd' } });
    graph.createAndAddNode({ id: XoirNodeId('capability:a'), kind: 'capability', properties: { name: 'A', description: 'd' } });
    const results = buildAllSemanticCapabilityContracts(graph);
    assert.equal(results.length, 2);
    assert.equal(results[0].ok && results[0].value.id, 'capability:a');
    assert.equal(results[1].ok && results[1].value.id, 'capability:z');
});
// ---------------------------------------------------------------------------
// Outgoing REQUIRES (Capability.requiredKnowledgeNodeIds): a capability node
// can reach a rule-kind node via an edge it is itself the *source* of, not
// only via an incoming edge from best-effort content-mention linking. See
// BuildContractOptions.linkEdgeKind's doc comment.
// ---------------------------------------------------------------------------
test('a constraint node reachable only via an OUTGOING REQUIRES edge (capability -> constraint, as capability-to-xoir.ts produces from requiredKnowledgeNodeIds) is still picked up as a linked rule', () => {
    const graph = XoirGraph.create(XoirGraphId('g4'));
    graph.createAndAddNode({
        id: XoirNodeId('capability:file-claim'),
        kind: 'capability',
        properties: { name: 'File Claim', description: 'Files an insurance claim' },
    });
    graph.createAndAddNode({
        id: XoirNodeId('constraint:30-day-rule'),
        kind: 'constraint',
        properties: { rule: 'Claims must be submitted within 30 days of loss', severity: 'blocking' },
    });
    // Deliberately outgoing: capability --REQUIRES--> constraint, exactly the direction
    // capability-to-xoir.ts's requiredKnowledgeNodeIds pass produces — never the incoming
    // direction content-mention linking produces.
    graph.createAndAddEdge({ id: XoirEdgeId('e-outgoing'), kind: 'REQUIRES', fromId: XoirNodeId('capability:file-claim'), toId: XoirNodeId('constraint:30-day-rule') });
    const result = buildSemanticCapabilityContract(graph, XoirNodeId('capability:file-claim'));
    assert.equal(result.ok, true);
    if (!result.ok)
        return;
    assert.equal(result.value.rules.length, 1);
    assert.equal(result.value.rules[0].sourceNodeId, 'constraint:30-day-rule');
    assert.equal(result.value.rules[0].kind, 'constraint');
    assert.equal(result.value.rules[0].condition, 'Claims must be submitted within 30 days of loss');
});
test('a rule node reachable via BOTH an incoming and an outgoing REQUIRES edge is counted exactly once, not duplicated', () => {
    const graph = XoirGraph.create(XoirGraphId('g5'));
    graph.createAndAddNode({ id: XoirNodeId('capability:file-claim'), kind: 'capability', properties: { name: 'File Claim', description: 'Files a claim' } });
    graph.createAndAddNode({ id: XoirNodeId('constraint:30-day-rule'), kind: 'constraint', properties: { rule: 'Must file within 30 days', severity: 'blocking' } });
    graph.createAndAddEdge({ id: XoirEdgeId('e-outgoing'), kind: 'REQUIRES', fromId: XoirNodeId('capability:file-claim'), toId: XoirNodeId('constraint:30-day-rule') });
    graph.createAndAddEdge({ id: XoirEdgeId('e-incoming'), kind: 'REQUIRES', fromId: XoirNodeId('constraint:30-day-rule'), toId: XoirNodeId('capability:file-claim') });
    const result = buildSemanticCapabilityContract(graph, XoirNodeId('capability:file-claim'));
    assert.equal(result.ok, true);
    if (!result.ok)
        return;
    assert.equal(result.value.rules.length, 1);
    assert.deepEqual(result.value.sourceXoirNodeIds, ['capability:file-claim', 'constraint:30-day-rule']);
});
test('an outgoing REQUIRES edge to a non-rule-kind node (e.g. a concept, or another capability dependency) is not treated as a rule', () => {
    const graph = XoirGraph.create(XoirGraphId('g6'));
    graph.createAndAddNode({ id: XoirNodeId('capability:file-claim'), kind: 'capability', properties: { name: 'File Claim', description: 'Files a claim' } });
    graph.createAndAddNode({ id: XoirNodeId('concept:policyholder'), kind: 'concept', properties: { definition: 'Policyholder' } });
    graph.createAndAddNode({ id: XoirNodeId('capability:notify-adjuster'), kind: 'capability', properties: { name: 'Notify Adjuster', description: 'Notifies the adjuster' } });
    graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'REQUIRES', fromId: XoirNodeId('capability:file-claim'), toId: XoirNodeId('concept:policyholder') });
    graph.createAndAddEdge({ id: XoirEdgeId('e2'), kind: 'REQUIRES', fromId: XoirNodeId('capability:file-claim'), toId: XoirNodeId('capability:notify-adjuster') });
    const result = buildSemanticCapabilityContract(graph, XoirNodeId('capability:file-claim'));
    assert.equal(result.ok, true);
    if (!result.ok)
        return;
    assert.deepEqual(result.value.rules, []);
});
//# sourceMappingURL=contract-builder.test.js.map