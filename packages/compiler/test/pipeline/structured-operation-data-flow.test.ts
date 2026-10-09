import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSources } from '../../src/pipeline/compile-sources.js';
import { auditWorkflowDataFlow, composeWorkflows } from '@xo/workflow-composer';
import { extractContractFromPropertyBag, buildSemanticCapabilityContract } from '@xo/capability-contract';

async function compileOperationJson(records: unknown) {
  const text = JSON.stringify(records);
  const result = await compileSources([{ kind: 'structured', format: 'json', text, sourcePath: 'op.json' }], {});
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('compile failed');
  return result.value.graph;
}

function contractFor(graph: Awaited<ReturnType<typeof compileOperationJson>>, name: string) {
  const node = graph.allNodes().find((n) => n.kind === 'capability' && n.properties.name === name);
  assert.ok(node, `expected a capability node named "${name}"`);
  const extracted = extractContractFromPropertyBag(node!.properties);
  if (extracted.ok) return extracted.value;
  const built = buildSemanticCapabilityContract(graph, node!.id);
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error('contract build failed');
  return built.value;
}

// --- Real source output preservation ------------------------------------

test('an explicitly declared operation output reaches CandidateCapability -> XOIR -> SemanticCapabilityContract as derivedFrom "declared"', async () => {
  const graph = await compileOperationJson([{ type: 'operation', name: 'calculate_brokerage', inputs: { premium: { type: 'number' }, rate: { type: 'number' } }, outputs: { brokerage: { type: 'number' } } }]);

  const node = graph.allNodes().find((n) => n.kind === 'capability' && n.properties.name === 'calculate_brokerage');
  assert.ok(node);
  assert.deepEqual(node!.properties.outputs, ['brokerage: number']);
  assert.deepEqual(node!.properties.inputs, ['premium: number', 'rate: number']);

  const contract = contractFor(graph, 'calculate_brokerage');
  assert.equal(contract.outputs.length, 1);
  assert.equal(contract.outputs[0]?.name, 'brokerage');
  assert.equal(contract.outputs[0]?.derivedFrom, 'declared');
});

// --- Contract propagation + data flow ------------------------------------

test('end-to-end: a real declared producer output and consumer input are marked "proven" by the unmodified auditWorkflowDataFlow', async () => {
  const graph = await compileOperationJson([
    { type: 'operation', name: 'calculate_brokerage', inputs: { premium: { type: 'number' }, rate: { type: 'number' } }, outputs: { brokerage: { type: 'number' } } },
    { type: 'operation', name: 'record_brokerage', requires: ['calculate_brokerage'], inputs: { brokerage: { type: 'number' } }, outputs: {} },
  ]);

  const composed = composeWorkflows(graph, { now: () => new Date().toISOString() });
  assert.equal(composed.ok, true);
  if (!composed.ok) return;
  const workflow = composed.value.find((w) => w.steps.some((s) => s.capabilityName === 'calculate_brokerage') && w.steps.some((s) => s.capabilityName === 'record_brokerage'));
  assert.ok(workflow, 'expected a workflow containing both operations');

  const dataFlow = auditWorkflowDataFlow(workflow!, graph);
  const proven = dataFlow.bindings.filter((b) => b.status === 'proven');
  assert.equal(proven.length, 1);
  assert.equal(proven[0]?.outputParameterName, 'brokerage');
  assert.equal(proven[0]?.inputParameterName, 'brokerage');
  assert.equal(proven[0]?.evidenceKind, 'explicit_contract_match');
});

test('without the explicit "requires" structural evidence, the same name/type match is only "suggestive", never "proven"', async () => {
  // Identical operations, but no independent structural fact connecting
  // them — proves the structural corroboration requirement is doing
  // real work, not just rubber-stamping every name match.
  const graph = await compileOperationJson([
    { type: 'operation', name: 'calculate_brokerage', inputs: { premium: { type: 'number' }, rate: { type: 'number' } }, outputs: { brokerage: { type: 'number' } } },
    { type: 'operation', name: 'record_brokerage', inputs: { brokerage: { type: 'number' } }, outputs: {} },
  ]);
  const composed = composeWorkflows(graph, { now: () => new Date().toISOString() });
  assert.equal(composed.ok, true);
  if (!composed.ok) return;
  const workflow = composed.value.find((w) => w.steps.some((s) => s.capabilityName === 'calculate_brokerage') && w.steps.some((s) => s.capabilityName === 'record_brokerage'));
  assert.ok(workflow);
  const dataFlow = auditWorkflowDataFlow(workflow!, graph);
  assert.equal(dataFlow.bindings.filter((b) => b.status === 'proven').length, 0);
  assert.ok(dataFlow.bindings.some((b) => b.status === 'suggestive'));
});

// --- Refusal: non-authoritative signals never create a declared output ---

test('rejection: an ordinary JSON field (no operation marker at all) never becomes a capability output', async () => {
  const graph = await compileOperationJson([{ customer_name: 'Acme Corp', claim_amount: 15000 }]);
  const capNodes = graph.allNodes().filter((n) => n.kind === 'capability');
  for (const n of capNodes) assert.deepEqual(n.properties.outputs, []);
});

test('rejection: a field literally named "formula" or "derived_from" does not become authoritative merely because of its name', async () => {
  const graph = await compileOperationJson([{ field_name: 'brokerage', derived_from: 'premium,rate', formula: 'premium * rate', type: 'number' }]);
  const capNodes = graph.allNodes().filter((n) => n.kind === 'capability');
  for (const n of capNodes) assert.deepEqual(n.properties.outputs, []);
});

test('rejection: the operation name alone, without an explicit "outputs" map, produces zero outputs — never inferred from the name', async () => {
  const graph = await compileOperationJson([{ type: 'operation', name: 'calculate_brokerage', inputs: { premium: { type: 'number' } } }]);
  const node = graph.allNodes().find((n) => n.kind === 'capability' && n.properties.name === 'calculate_brokerage');
  assert.ok(node);
  assert.deepEqual(node!.properties.outputs, []);
});

test('rejection: an empty "outputs": {} is honestly empty, not a signal to infer something else', async () => {
  const graph = await compileOperationJson([{ type: 'operation', name: 'record_brokerage', inputs: { brokerage: { type: 'number' } }, outputs: {} }]);
  const node = graph.allNodes().find((n) => n.kind === 'capability' && n.properties.name === 'record_brokerage');
  assert.ok(node);
  assert.deepEqual(node!.properties.outputs, []);
});
