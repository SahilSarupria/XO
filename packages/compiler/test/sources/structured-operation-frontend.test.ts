import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StructuredSourceFrontend } from '../../src/sources/structured-frontend.js';

const frontend = new StructuredSourceFrontend();

function paragraphBlocks(result: ReturnType<StructuredSourceFrontend['ingest']>) {
  if (!result.ok || result.value.content.kind !== 'document') throw new Error('expected ok document result');
  const record = result.value.content.parsed.root.subsections[0]!;
  return record.blocks.filter((b) => b.kind === 'paragraph');
}

test('an explicit "type": "operation" record produces operation:name/input/output structured fields, not ordinary flat fields', () => {
  const text = JSON.stringify({
    type: 'operation',
    name: 'calculate_brokerage',
    inputs: { premium: { type: 'number' }, rate: { type: 'number' } },
    outputs: { brokerage: { type: 'number' } },
  });
  const result = frontend.ingest({ kind: 'structured', format: 'json', text, sourcePath: 'op.json' });
  assert.equal(result.ok, true);
  const blocks = paragraphBlocks(result);
  const byField = new Map(blocks.map((b) => (b.kind === 'paragraph' ? [b.structuredField?.fieldName, b.structuredField?.rawValue] : [undefined, undefined])));

  assert.equal(byField.get('operation:name'), 'calculate_brokerage');
  assert.equal(byField.get('operation:input:premium'), 'number');
  assert.equal(byField.get('operation:input:rate'), 'number');
  assert.equal(byField.get('operation:output:brokerage'), 'number');
  // No ordinary flat "inputs"/"outputs" blob field is produced for a recognized operation record.
  assert.equal(byField.has('inputs'), false);
  assert.equal(byField.has('outputs'), false);
});

test('an explicit "requires" list becomes its own namespaced structured field, independent of input/output names', () => {
  const text = JSON.stringify({ type: 'operation', name: 'record_brokerage', requires: ['calculate_brokerage'], inputs: { brokerage: { type: 'number' } } });
  const result = frontend.ingest({ kind: 'structured', format: 'json', text, sourcePath: 'op.json' });
  const blocks = paragraphBlocks(result);
  const requiresBlock = blocks.find((b) => b.kind === 'paragraph' && b.structuredField?.fieldName.startsWith('operation:requires:'));
  assert.ok(requiresBlock);
  if (requiresBlock?.kind === 'paragraph') assert.equal(requiresBlock.structuredField?.rawValue, 'calculate_brokerage');
});

// --- Refusal: only the exact, explicit "type": "operation" discriminant qualifies ---

test('rejection: a record with an "inputs"/"outputs"-shaped payload but no "type": "operation" is treated as an ordinary flat record', () => {
  const text = JSON.stringify({ name: 'calculate_brokerage', inputs: { premium: { type: 'number' } }, outputs: { brokerage: { type: 'number' } } });
  const result = frontend.ingest({ kind: 'structured', format: 'json', text, sourcePath: 'op.json' });
  const blocks = paragraphBlocks(result);
  const fieldNames = blocks.map((b) => (b.kind === 'paragraph' ? b.structuredField?.fieldName : undefined));
  // Ordinary flat fields, verbatim field names — no "operation:" namespace at all.
  assert.deepEqual(new Set(fieldNames), new Set(['name', 'inputs', 'outputs']));
});

test('rejection: "type" set to anything other than the literal "operation" is never recognized', () => {
  for (const typeValue of ['Operation', 'OPERATION', 'formula', 'function', 'op']) {
    const text = JSON.stringify({ type: typeValue, name: 'x', inputs: {}, outputs: {} });
    const result = frontend.ingest({ kind: 'structured', format: 'json', text, sourcePath: 'op.json' });
    const blocks = paragraphBlocks(result);
    const fieldNames = blocks.map((b) => (b.kind === 'paragraph' ? b.structuredField?.fieldName : undefined));
    assert.ok(fieldNames.includes('type'), `expected ordinary "type" field for type="${typeValue}"`);
    assert.ok(!fieldNames.some((f) => f?.startsWith('operation:')), `did not expect operation: namespace for type="${typeValue}"`);
  }
});

test('rejection: "type": "operation" without a string "name" is treated as an ordinary flat record, not a malformed operation', () => {
  const text = JSON.stringify({ type: 'operation', inputs: { premium: { type: 'number' } } });
  const result = frontend.ingest({ kind: 'structured', format: 'json', text, sourcePath: 'op.json' });
  assert.equal(result.ok, true);
  const blocks = paragraphBlocks(result);
  const fieldNames = blocks.map((b) => (b.kind === 'paragraph' ? b.structuredField?.fieldName : undefined));
  assert.ok(!fieldNames.some((f) => f?.startsWith('operation:')));
});

test('an ordinary CSV data-dictionary record with "formula"/"derived_from"-named columns is unaffected (no "type" column at all)', () => {
  // Same fixture shape as the existing structured-field-preservation
  // suite — re-asserted here to make explicit that this milestone's new
  // recognition path does NOT change that pre-existing behavior at all.
  const text = ['field_name,derived_from,formula,type', 'subtotal,line_items,sum of line item amounts,number'].join('\n');
  const result = frontend.ingest({ kind: 'structured', format: 'csv', text, sourcePath: 'dict.csv' });
  const blocks = paragraphBlocks(result);
  const fieldNames = blocks.map((b) => (b.kind === 'paragraph' ? b.structuredField?.fieldName : undefined));
  assert.deepEqual(new Set(fieldNames), new Set(['field_name', 'derived_from', 'formula', 'type']));
});
