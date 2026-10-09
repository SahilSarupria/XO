import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSources } from '../../src/pipeline/compile-sources.js';
import { buildSemanticCapabilityContract } from '@xo/capability-contract';

// --- P0.9A area B: semantic I/O independence, raw structured JSON (not OpenAPI) ---
// Mirrors packages/compiler/test/pipeline/openapi-data-flow.test.ts's OpenAPI case,
// exercising `structured-frontend.ts`'s `type: "operation"` shape directly, so
// inputTypes is proven to come from the compiler's general structured-operation
// path, not something specific to the OpenAPI adapter.

const OPERATION_RECORD = {
  type: 'operation',
  name: 'reconcile_brokerage',
  inputs: {
    brokerageAmount: { type: 'number' },
    policyId: { type: 'string' },
  },
  outputs: {
    reconciledAmount: { type: 'number' },
  },
} as const;

test('REAL STRUCTURED JSON: a directly-authored operation record preserves genuine input types through compileSources into a capability node and its contract', async () => {
  const text = JSON.stringify(OPERATION_RECORD);
  const result = await compileSources([{ kind: 'structured', format: 'json', text, sourcePath: 'reconcile-brokerage.json' }], {});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const { graph } = result.value;

  const capability = graph.allNodes().find((n) => n.kind === 'capability' && n.properties.name === 'reconcile_brokerage');
  assert.ok(capability);

  // B1: the existing string-array wire shape is unchanged.
  assert.deepEqual(capability!.properties.inputs, ['brokerageAmount: number', 'policyId: string']);
  // B2/B3: the genuine structured type map is additionally present.
  assert.deepEqual(capability!.properties.inputTypes, { brokerageAmount: 'number', policyId: 'string' });
  // B7: outputs deliberately has no equivalent field this pass.
  assert.equal((capability!.properties as Record<string, unknown>).outputTypes, undefined);

  const contract = buildSemanticCapabilityContract(graph, capability!.id);
  assert.equal(contract.ok, true);
  if (!contract.ok) return;
  const brokerageAmount = contract.value.inputs.find((i) => i.name === 'brokerageAmount');
  const policyId = contract.value.inputs.find((i) => i.name === 'policyId');
  assert.equal(brokerageAmount?.semanticType, 'number');
  assert.equal(brokerageAmount?.derivedFrom, 'declared');
  assert.equal(policyId?.semanticType, 'string');
  assert.equal(policyId?.derivedFrom, 'declared');
});

test('a structured JSON record with an unrecognized JSON-Schema-style type ("array") normalizes to \'unknown\', never a fabricated string/number/boolean', async () => {
  const record = { type: 'operation', name: 'ingest_batch', inputs: { items: { type: 'array' } } };
  const result = await compileSources([{ kind: 'structured', format: 'json', text: JSON.stringify(record), sourcePath: 'ingest-batch.json' }], {});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const capability = result.value.graph.allNodes().find((n) => n.kind === 'capability' && n.properties.name === 'ingest_batch');
  assert.ok(capability);
  const contract = buildSemanticCapabilityContract(result.value.graph, capability!.id);
  assert.equal(contract.ok, true);
  if (!contract.ok) return;
  assert.equal(contract.value.inputs.find((i) => i.name === 'items')?.semanticType, 'unknown');
});

test('legacy XOIR string-array fixtures (no inputTypes at all) still build a contract exactly as before', async () => {
  const text = 'The claims officer must review the file within 5 business days.';
  const result = await compileSources([{ kind: 'document', text, sourcePath: 'legacy.txt' }], {});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  for (const n of result.value.graph.allNodes().filter((n) => n.kind === 'capability')) {
    const contract = buildSemanticCapabilityContract(result.value.graph, n.id);
    assert.equal(contract.ok, true);
  }
});
