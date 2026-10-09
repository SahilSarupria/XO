import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileSources } from '../../src/pipeline/compile-sources.js';
import { auditWorkflowDataFlow, composeWorkflows } from '@xo/workflow-composer';
import { extractContractFromPropertyBag, buildSemanticCapabilityContract } from '@xo/capability-contract';

test('REAL SOURCE FIXTURE: the OpenAPI fixture compiles to authoritative declared I/O and a proven data-flow binding', async () => {
  const text = await readFile(new URL('../../../../examples/vertical-test/openapi-operation-data-flow.json', import.meta.url), 'utf8');
  const result = await compileSources([{ kind: 'openapi', text, sourcePath: 'openapi-operation-data-flow.json' }], {});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const { graph } = result.value;

  const producer = graph.allNodes().find((n) => n.kind === 'capability' && n.properties.name === 'calculate_brokerage');
  const consumer = graph.allNodes().find((n) => n.kind === 'capability' && n.properties.name === 'record_brokerage');
  assert.ok(producer && consumer);
  assert.deepEqual(producer!.properties.outputs, ['brokerage: number']);
  assert.deepEqual(consumer!.properties.inputs, ['brokerage: number']);

  const extracted = extractContractFromPropertyBag(producer!.properties);
  const contract = extracted.ok ? extracted : buildSemanticCapabilityContract(graph, producer!.id);
  assert.equal(contract.ok, true);
  if (contract.ok) {
    assert.equal(contract.value.outputs[0]?.name, 'brokerage');
    assert.equal(contract.value.outputs[0]?.derivedFrom, 'declared');
  }

  const composed = composeWorkflows(graph, { now: () => new Date().toISOString() });
  assert.equal(composed.ok, true);
  if (!composed.ok) return;
  const workflow = composed.value.find((w) => w.steps.some((s) => s.capabilityName === 'calculate_brokerage') && w.steps.some((s) => s.capabilityName === 'record_brokerage'));
  assert.ok(workflow);

  const dataFlow = auditWorkflowDataFlow(workflow!, graph);
  const proven = dataFlow.bindings.filter((b) => b.status === 'proven');
  assert.equal(proven.length, 1);
  assert.equal(proven[0]?.evidenceKind, 'explicit_contract_match');
});

// --- P0.9A area B: semantic I/O independence (structured/OpenAPI inputTypes) ---

test('REAL SOURCE FIXTURE: the OpenAPI-declared "brokerage: number" input type survives compiler -> XOIR -> capability-contract as a genuine semanticType, and workflow-composer\'s data-flow audit can consume it', async () => {
  const text = await readFile(new URL('../../../../examples/vertical-test/openapi-operation-data-flow.json', import.meta.url), 'utf8');
  const result = await compileSources([{ kind: 'openapi', text, sourcePath: 'openapi-operation-data-flow.json' }], {});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const { graph } = result.value;

  const producer = graph.allNodes().find((n) => n.kind === 'capability' && n.properties.name === 'calculate_brokerage');
  const consumer = graph.allNodes().find((n) => n.kind === 'capability' && n.properties.name === 'record_brokerage');
  assert.ok(producer && consumer);

  // B1/B4: the existing string-array wire shape is completely unchanged.
  assert.deepEqual(consumer!.properties.inputs, ['brokerage: number']);
  // B2/B3/B4: the same genuine type additionally survives, structured, on the node itself.
  assert.deepEqual(consumer!.properties.inputTypes, { brokerage: 'number' });

  // B5/B6: capability-contract reads inputTypes and populates semanticType — not by
  // re-parsing the "name: type" string (which would land in `description`, not `semanticType`).
  const contract = buildSemanticCapabilityContract(graph, consumer!.id);
  assert.equal(contract.ok, true);
  if (!contract.ok) return;
  const brokerageInput = contract.value.inputs.find((i) => i.name === 'brokerage');
  assert.ok(brokerageInput);
  assert.equal(brokerageInput!.semanticType, 'number');
  assert.equal(brokerageInput!.derivedFrom, 'declared');
  assert.equal(brokerageInput!.description, 'number', 'the flattened string is still parsed as before — inputTypes is additive, not a replacement');

  // B8: workflow-composer's own data-flow audit already reads semanticType for
  // producer/consumer type matching — confirm it now sees a real type, not undefined.
  const composed = composeWorkflows(graph, { now: () => new Date().toISOString() });
  assert.equal(composed.ok, true);
  if (!composed.ok) return;
  const workflow = composed.value.find((w) => w.steps.some((s) => s.capabilityName === 'calculate_brokerage') && w.steps.some((s) => s.capabilityName === 'record_brokerage'));
  assert.ok(workflow);
  const consumerContract = buildSemanticCapabilityContract(graph, consumer!.id);
  assert.ok(consumerContract.ok);
  if (consumerContract.ok) {
    const inputSemType = consumerContract.value.inputs.find((i) => i.name === 'brokerage')?.semanticType;
    assert.equal(inputSemType, 'number', 'this is exactly what @xo/workflow-composer/src/data-flow-audit.ts reads for producer/consumer type compatibility');
  }
});

test('a prose/PDF-derived capability never receives a fabricated semanticType: inputTypes stays absent and semanticType stays undefined', async () => {
  const text = 'The claims officer must review the claim file and approve or deny it within 5 business days.';
  const result = await compileSources([{ kind: 'document', text, sourcePath: 'prose.txt' }], {});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const capNodes = result.value.graph.allNodes().filter((n) => n.kind === 'capability');
  for (const n of capNodes) {
    assert.equal(n.properties.inputTypes, undefined, `expected no inputTypes on a prose-derived capability (${JSON.stringify(n.properties.name)})`);
    const contract = buildSemanticCapabilityContract(result.value.graph, n.id);
    if (contract.ok) {
      for (const input of contract.value.inputs) {
        assert.notEqual(input.semanticType, 'number', 'must never guess a type from a name/description');
        assert.notEqual(input.semanticType, 'string');
        assert.notEqual(input.semanticType, 'boolean');
      }
    }
  }
});
