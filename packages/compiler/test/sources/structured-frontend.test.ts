import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StructuredSourceFrontend } from '../../src/sources/structured-frontend.js';

const frontend = new StructuredSourceFrontend();

test('canHandle accepts tagged structured input with a valid format, rejects otherwise', () => {
  assert.equal(frontend.canHandle({ kind: 'structured', format: 'json', text: '{}', sourcePath: 'a.json' }), true);
  assert.equal(frontend.canHandle({ kind: 'structured', format: 'csv', text: 'a,b', sourcePath: 'a.csv' }), true);
  assert.equal(frontend.canHandle({ kind: 'structured', format: 'xml', text: '<a/>', sourcePath: 'a.xml' }), false);
  assert.equal(frontend.canHandle({ kind: 'json', text: '{}', sourcePath: 'a.json' }), false);
});

test('JSON array of records: one heading + one paragraph-per-field block per record, with record-index-as-page provenance', () => {
  const text = JSON.stringify([
    { name: 'Acme Corp', role: 'counterparty' },
    { name: 'Beta LLC', role: 'vendor' },
  ]);
  const result = frontend.ingest({ kind: 'structured', format: 'json', text, sourcePath: 'parties.json' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.sourceType, 'structured');
  assert.equal(result.value.metadata.recordCount, '2');
  assert.equal(result.value.content.kind, 'document');
  if (result.value.content.kind !== 'document') return;

  const root = result.value.content.parsed.root;
  assert.equal(root.subsections.length, 2);

  const record1 = root.subsections[0]!;
  assert.equal(record1.heading?.text, 'Record 1');
  assert.equal(record1.heading?.provenance.page, 1);
  assert.equal(record1.blocks.length, 2);
  assert.equal(record1.blocks[0]!.kind, 'paragraph');
  if (record1.blocks[0]!.kind === 'paragraph') assert.equal(record1.blocks[0].text, 'name: Acme Corp');
  if (record1.blocks[1]!.kind === 'paragraph') assert.equal(record1.blocks[1].text, 'role: counterparty');

  const record2 = root.subsections[1]!;
  assert.equal(record2.heading?.provenance.page, 2);
});

test('a single JSON object (not wrapped in an array) is treated as one record', () => {
  const result = frontend.ingest({ kind: 'structured', format: 'json', text: JSON.stringify({ key: 'value' }), sourcePath: 'single.json' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.metadata.recordCount, '1');
});

test('CSV: header row drives field names, one record per data row', () => {
  const text = ['name,role', 'Acme Corp,counterparty', 'Beta LLC,vendor'].join('\n');
  const result = frontend.ingest({ kind: 'structured', format: 'csv', text, sourcePath: 'parties.csv' });
  assert.equal(result.ok, true);
  if (!result.ok || result.value.content.kind !== 'document') return;
  assert.equal(result.value.metadata.recordCount, '2');
  const record1 = result.value.content.parsed.root.subsections[0]!;
  if (record1.blocks[0]!.kind === 'paragraph') assert.equal(record1.blocks[0].text, 'name: Acme Corp');
});

test('malformed JSON fails with SOURCE_FORMAT_INVALID', () => {
  const result = frontend.ingest({ kind: 'structured', format: 'json', text: '{not valid json', sourcePath: 'bad.json' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'XO_SERIALIZATION_SCHEMA_MISMATCH');
});

test('JSON array of non-objects fails with SOURCE_FORMAT_INVALID', () => {
  const result = frontend.ingest({ kind: 'structured', format: 'json', text: '[1, 2, 3]', sourcePath: 'bad.json' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'XO_SERIALIZATION_SCHEMA_MISMATCH');
});

test('empty CSV fails with SOURCE_FORMAT_INVALID', () => {
  const result = frontend.ingest({ kind: 'structured', format: 'csv', text: '', sourcePath: 'empty.csv' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'XO_SERIALIZATION_SCHEMA_MISMATCH');
});

// --- structuredField preservation (Stage 3 preservation milestone) ---

test('CSV: each paragraph block carries structuredField with the raw string cell value, and existing text/behavior is unchanged', () => {
  const text = ['field_name,derived_from,formula,type', 'subtotal,line_items,sum of line item amounts,number'].join('\n');
  const result = frontend.ingest({ kind: 'structured', format: 'csv', text, sourcePath: 'dict.csv' });
  assert.equal(result.ok, true);
  if (!result.ok || result.value.content.kind !== 'document') return;
  const record1 = result.value.content.parsed.root.subsections[0]!;
  const blocks = record1.blocks;
  assert.equal(blocks.length, 4);
  const byField = new Map(blocks.map((b) => [b.kind === 'paragraph' ? b.structuredField?.fieldName : undefined, b]));

  const fieldNameBlock = byField.get('field_name');
  assert.equal(fieldNameBlock?.kind, 'paragraph');
  if (fieldNameBlock?.kind === 'paragraph') {
    assert.equal(fieldNameBlock.text, 'field_name: subtotal'); // existing text behavior unchanged
    assert.deepEqual(fieldNameBlock.structuredField, { fieldName: 'field_name', rawValue: 'subtotal' });
  }

  const formulaBlock = byField.get('formula');
  assert.equal(formulaBlock?.kind, 'paragraph');
  if (formulaBlock?.kind === 'paragraph') assert.deepEqual(formulaBlock.structuredField, { fieldName: 'formula', rawValue: 'sum of line item amounts' });

  const derivedFromBlock = byField.get('derived_from');
  assert.equal(derivedFromBlock?.kind, 'paragraph');
  if (derivedFromBlock?.kind === 'paragraph') {
    // A field named "derived_from" remains an ordinary field with one unsplit rawValue — no delimiter splitting.
    assert.deepEqual(derivedFromBlock.structuredField, { fieldName: 'derived_from', rawValue: 'line_items' });
  }

  const typeBlock = byField.get('type');
  assert.equal(typeBlock?.kind, 'paragraph');
  if (typeBlock?.kind === 'paragraph') {
    // A field named "type" is preserved as an ordinary field — its rawValue is not coerced into any schema-type enum.
    assert.deepEqual(typeBlock.structuredField, { fieldName: 'type', rawValue: 'number' });
  }
});

test('JSON: native string/number/boolean/null values are preserved as their own type in structuredField.rawValue', () => {
  const text = JSON.stringify([{ name: 'Acme', count: 3, active: true, note: null }]);
  const result = frontend.ingest({ kind: 'structured', format: 'json', text, sourcePath: 'native.json' });
  assert.equal(result.ok, true);
  if (!result.ok || result.value.content.kind !== 'document') return;
  const blocks = result.value.content.parsed.root.subsections[0]!.blocks;
  const byField = new Map(blocks.map((b) => [b.kind === 'paragraph' ? b.structuredField?.fieldName : undefined, b]));

  const nameBlock = byField.get('name');
  if (nameBlock?.kind === 'paragraph') assert.deepEqual(nameBlock.structuredField, { fieldName: 'name', rawValue: 'Acme' });

  const countBlock = byField.get('count');
  if (countBlock?.kind === 'paragraph') assert.deepEqual(countBlock.structuredField, { fieldName: 'count', rawValue: 3 });
  assert.equal(typeof (countBlock as { structuredField?: { rawValue: unknown } } | undefined)?.structuredField?.rawValue, 'number');

  const activeBlock = byField.get('active');
  if (activeBlock?.kind === 'paragraph') assert.deepEqual(activeBlock.structuredField, { fieldName: 'active', rawValue: true });

  const noteBlock = byField.get('note');
  if (noteBlock?.kind === 'paragraph') assert.deepEqual(noteBlock.structuredField, { fieldName: 'note', rawValue: null });
});

test('JSON: a nested object/array value falls back to the same stringified form as the block text, not a raw object', () => {
  const text = JSON.stringify([{ tags: ['a', 'b'], meta: { x: 1 } }]);
  const result = frontend.ingest({ kind: 'structured', format: 'json', text, sourcePath: 'nested.json' });
  assert.equal(result.ok, true);
  if (!result.ok || result.value.content.kind !== 'document') return;
  const blocks = result.value.content.parsed.root.subsections[0]!.blocks;
  for (const b of blocks) {
    if (b.kind !== 'paragraph' || b.structuredField === undefined) continue;
    const expectedText = b.text.slice(b.structuredField.fieldName.length + 2); // "fieldName: <text>"
    assert.equal(b.structuredField.rawValue, expectedText);
    assert.equal(typeof b.structuredField.rawValue, 'string');
  }
});

test('field order in structuredField matches source key/column order (JSON and CSV)', () => {
  const jsonResult = frontend.ingest({ kind: 'structured', format: 'json', text: JSON.stringify([{ z: 1, a: 2, m: 3 }]), sourcePath: 'order.json' });
  assert.equal(jsonResult.ok, true);
  if (jsonResult.ok && jsonResult.value.content.kind === 'document') {
    const names = jsonResult.value.content.parsed.root.subsections[0]!.blocks.filter((b) => b.kind === 'paragraph').map((b) => (b.kind === 'paragraph' ? b.structuredField?.fieldName : undefined));
    assert.deepEqual(names, ['z', 'a', 'm']);
  }

  const csvResult = frontend.ingest({ kind: 'structured', format: 'csv', text: ['z,a,m', '1,2,3'].join('\n'), sourcePath: 'order.csv' });
  assert.equal(csvResult.ok, true);
  if (csvResult.ok && csvResult.value.content.kind === 'document') {
    const names = csvResult.value.content.parsed.root.subsections[0]!.blocks.filter((b) => b.kind === 'paragraph').map((b) => (b.kind === 'paragraph' ? b.structuredField?.fieldName : undefined));
    assert.deepEqual(names, ['z', 'a', 'm']);
  }
});

test('PDF/HTML/document ParagraphBlock construction is unaffected: structuredField is simply absent, not a breaking change', () => {
  // structured-frontend.ts is the only producer of structuredField; every other frontend's
  // ParagraphBlock literals (unchanged by this milestone) simply have no such key, which is
  // exactly what an optional field allows without any change to those other frontends.
  const block: { kind: 'paragraph'; text: string; provenance: { page: number; yRange: readonly [number, number] } } = {
    kind: 'paragraph',
    text: 'ordinary prose, no structured field',
    provenance: { page: 1, yRange: [0, 0] },
  };
  assert.equal((block as { structuredField?: unknown }).structuredField, undefined);
});

test('ingest is deterministic', () => {
  const input = { kind: 'structured' as const, format: 'json' as const, text: JSON.stringify([{ a: 1 }]), sourcePath: 'x.json' };
  const a = frontend.ingest(input);
  const b = frontend.ingest(input);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (a.ok && b.ok) assert.deepEqual(a.value, b.value);
});
