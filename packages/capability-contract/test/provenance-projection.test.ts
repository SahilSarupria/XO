import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId, type XoirSourceRef } from '@xo/xoir';
import { buildSemanticCapabilityContract } from '../src/contract-builder.js';
import { computeContractContentHash } from '../src/contract-hash.js';
import {
  capabilitiesFromSource,
  projectAllCapabilityProvenance,
  projectCapabilityProvenance,
  projectExecutionProvenance,
  projectWorkflowProvenance,
} from '../src/provenance-projection.js';

/** P0.9B Step 6 — the projection answers the provenance chain from existing ids/hashes only. */

const now = () => '2026-01-01T00:00:00.000Z';
const ref = (documentPath: string) => ({ documentPath }) as unknown as XoirSourceRef;

function graph(): XoirGraph {
  const g = XoirGraph.create(XoirGraphId('g'));
  g.createAndAddNode({ id: XoirNodeId('capability:evaluate-claim'), kind: 'capability', properties: { name: 'Evaluate Claim', description: 'd', determinism: 'deterministic' }, confidence: 0.7, sourceRefs: [ref('policy.pdf')], now });
  g.createAndAddNode({ id: XoirNodeId('decision:deny-large'), kind: 'decision_node', properties: { question: 'the claimed loss amount exceeds 10000', outcome: 'deny the claim' }, confidence: 0.9, sourceRefs: [ref('policy.pdf')], now });
  g.createAndAddEdge({ id: XoirEdgeId('r1'), kind: 'REQUIRES', fromId: XoirNodeId('decision:deny-large'), toId: XoirNodeId('capability:evaluate-claim'), now });
  g.createAndAddNode({ id: XoirNodeId('capability:other'), kind: 'capability', properties: { name: 'Other', description: 'd', determinism: 'deterministic' }, confidence: 0.7, sourceRefs: [ref('handbook.pdf')], now });
  return g;
}

test('capability provenance: source -> capability -> XOIR nodes -> contract -> binding, all from existing ids/hashes', () => {
  const g = graph();
  const p = projectCapabilityProvenance(g, 'capability:evaluate-claim');
  assert.ok(p.ok);
  const built = buildSemanticCapabilityContract(g, XoirNodeId('capability:evaluate-claim'));
  assert.ok(built.ok);
  assert.equal(p.value.contractId, 'capability:evaluate-claim');
  assert.equal(p.value.contractContentHash, computeContractContentHash(built.value));
  assert.deepEqual([...p.value.sourceXoirNodeIds], ['capability:evaluate-claim', 'decision:deny-large']);
  assert.ok(p.value.sourceRefs.some((r) => r.documentPath === 'policy.pdf'));
  assert.equal(p.value.binding.status, 'resolved');
  assert.equal(p.value.binding.bindingId, 'binding_capability:evaluate-claim_structured-comparison-resolver');
  assert.equal(p.value.graphHash, g.contentHash());
});

test('a capability that does not resolve reports its honest status and no bindingId', () => {
  const p = projectCapabilityProvenance(graph(), 'capability:other');
  assert.ok(p.ok);
  assert.notEqual(p.value.binding.status, 'resolved');
  assert.equal(p.value.binding.bindingId, undefined);
});

test('an unknown capability id is an error, not a fabricated projection', () => {
  assert.equal(projectCapabilityProvenance(graph(), 'capability:nope').ok, false);
});

test('projectAll is sorted by id; capabilitiesFromSource answers "which capabilities came from this source"', () => {
  const all = projectAllCapabilityProvenance(graph());
  assert.deepEqual(all.map((c) => c.capabilityId), ['capability:evaluate-claim', 'capability:other']);
  assert.deepEqual(capabilitiesFromSource(all, 'policy.pdf').map((c) => c.capabilityId), ['capability:evaluate-claim']);
  assert.deepEqual(capabilitiesFromSource(all, 'nothing.pdf'), []);
});

test('execution provenance: matching execution facts agree on every field', () => {
  const cap = projectCapabilityProvenance(graph(), 'capability:evaluate-claim');
  assert.ok(cap.ok);
  const e = projectExecutionProvenance({ executionId: 'exec_1', capabilityId: cap.value.capabilityId, contractId: cap.value.contractId, bindingId: cap.value.binding.bindingId!, graphHash: cap.value.graphHash, contractContentHash: cap.value.contractContentHash }, cap.value);
  assert.deepEqual(e.agreement, { graphHash: 'match', contractContentHash: 'match', bindingId: 'match', contractId: 'match' });
});

test('execution provenance: a divergent hash is reported as mismatch; an absent recorded value is unknown (installed-package: no graphHash)', () => {
  const cap = projectCapabilityProvenance(graph(), 'capability:evaluate-claim');
  assert.ok(cap.ok);
  const diverged = projectExecutionProvenance({ capabilityId: cap.value.capabilityId, graphHash: 'sha256:' + '0'.repeat(64), contractContentHash: cap.value.contractContentHash }, cap.value);
  assert.equal(diverged.agreement.graphHash, 'mismatch');
  assert.equal(diverged.agreement.contractContentHash, 'match');
  const installed = projectExecutionProvenance({ capabilityId: cap.value.capabilityId, contractContentHash: cap.value.contractContentHash }, cap.value);
  assert.equal(installed.agreement.graphHash, 'unknown');
  const noGraphView = projectExecutionProvenance({ capabilityId: 'c', graphHash: 'x' });
  assert.equal(noGraphView.agreement.graphHash, 'unknown');
});

test('workflow provenance: steps sorted by order and joined to capability views and execution records; execution -> workflow step', () => {
  const g = graph();
  const caps = projectAllCapabilityProvenance(g);
  const cap = caps.find((c) => c.capabilityId === 'capability:evaluate-claim')!;
  const executions = new Map([['exec_2', { capabilityId: cap.capabilityId, contractId: cap.contractId, bindingId: cap.binding.bindingId!, graphHash: cap.graphHash, contractContentHash: cap.contractContentHash, sourceXoirNodeIds: cap.sourceXoirNodeIds }]]);
  const w = projectWorkflowProvenance(
    {
      workflowId: 'wf_1',
      compilationId: 'cmp_1',
      graphHash: cap.graphHash,
      steps: [
        { order: 1, capabilityId: 'capability:other' },
        { order: 0, capabilityId: 'capability:evaluate-claim', contractId: cap.contractId, bindingId: cap.binding.bindingId!, sourceXoirNodeIds: cap.sourceXoirNodeIds, executionId: 'exec_2' },
      ],
    },
    { capabilities: caps, executions },
  );
  assert.deepEqual(w.steps.map((s) => s.order), [0, 1]);
  assert.equal(w.graphHash, cap.graphHash);
  const first = w.steps[0]!;
  assert.equal(first.capability?.contractId, cap.contractId);
  assert.equal(first.execution?.workflowId, 'wf_1');
  assert.equal(first.execution?.workflowStepOrder, 0);
  assert.equal(first.execution?.agreement.graphHash, 'match');
  assert.equal(w.steps[1]!.execution, undefined, 'a step with no execution record carries no fabricated one');
});
