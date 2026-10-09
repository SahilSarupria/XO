import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StructuredSourceFrontend } from '../../src/sources/structured-frontend.js';
import { chunkDocument } from '../../src/semantic/semantic-chunker.js';

const frontend = new StructuredSourceFrontend();

async function chunkStructured(format: 'json' | 'csv', text: string, sourcePath: string) {
  const ingested = frontend.ingest({ kind: 'structured', format, text, sourcePath });
  assert.equal(ingested.ok, true);
  if (!ingested.ok || ingested.value.content.kind !== 'document') throw new Error('expected a document-shaped structured source');
  return chunkDocument(ingested.value.content.parsed, sourcePath, undefined);
}

test('structuredFields is correctly collected onto the ExperienceUnit built from a structured record', async () => {
  const csv = ['field_name,derived_from,formula,type', 'subtotal,line_items,sum of line item amounts,number'].join('\n');
  const doc = await chunkStructured('csv', csv, 'dict.csv');

  const unitsWithFields = doc.units.filter((u) => u.structuredFields !== undefined && u.structuredFields.length > 0);
  assert.ok(unitsWithFields.length > 0, 'at least one unit should carry structuredFields for a structured source');

  const allFields = unitsWithFields.flatMap((u) => u.structuredFields!);
  const byName = new Map(allFields.map((f) => [f.fieldName, f.rawValue]));
  assert.equal(byName.get('field_name'), 'subtotal');
  assert.equal(byName.get('derived_from'), 'line_items');
  assert.equal(byName.get('formula'), 'sum of line item amounts');
  assert.equal(byName.get('type'), 'number');
});

test('field order within a unit\u2019s structuredFields matches source column order', async () => {
  const csv = ['z,a,m', '1,2,3'].join('\n');
  const doc = await chunkStructured('csv', csv, 'order.csv');
  const allFields = doc.units.flatMap((u) => u.structuredFields ?? []);
  assert.deepEqual(
    allFields.map((f) => f.fieldName),
    ['z', 'a', 'm'],
  );
});

test('cross-record isolation: no unit\u2019s structuredFields mixes fields from two different structured records', async () => {
  const json = JSON.stringify([
    { field_name: 'subtotal', formula: 'sum of line item amounts' },
    { field_name: 'tax_amount', formula: 'subtotal * tax_rate' },
    { field_name: 'total', derived_from: 'subtotal;tax_amount', formula: 'subtotal + tax_amount' },
  ]);
  const doc = await chunkStructured('json', json, 'dict.json');

  const unitsWithFields = doc.units.filter((u) => u.structuredFields !== undefined && u.structuredFields.length > 0);
  assert.ok(unitsWithFields.length > 0);

  for (const unit of unitsWithFields) {
    // Every field on one unit must trace back to the same record (same sectionPath / record heading trail).
    const sectionPaths = new Set(unit.provenance.blockProvenance.map((p) => p.page));
    assert.equal(sectionPaths.size, 1, `unit ${unit.id} mixed provenance pages (records) within one unit's structuredFields`);
  }

  // Specifically: "total"'s record fields never appear on a unit that also carries "subtotal"'s or
  // "tax_amount"'s own field_name declaration.
  const totalRecordUnit = unitsWithFields.find((u) => u.structuredFields!.some((f) => f.fieldName === 'field_name' && f.rawValue === 'total'));
  assert.ok(totalRecordUnit);
  const namesOnThatUnit = totalRecordUnit!.structuredFields!.map((f) => f.rawValue);
  assert.ok(!namesOnThatUnit.includes('subtotal'));
  assert.ok(!namesOnThatUnit.includes('tax_amount'));
});

test('a "derived_from" field is never split into an array anywhere in the unit\u2019s structuredFields', async () => {
  const json = JSON.stringify([{ field_name: 'total', derived_from: 'subtotal;tax_amount' }]);
  const doc = await chunkStructured('json', json, 'dict.json');
  const allFields = doc.units.flatMap((u) => u.structuredFields ?? []);
  const derivedFromField = allFields.find((f) => f.fieldName === 'derived_from');
  assert.equal(derivedFromField?.rawValue, 'subtotal;tax_amount');
  assert.equal(typeof derivedFromField?.rawValue, 'string'); // not an array
});

test('a "required" field is preserved as an ordinary field, not coerced to a dedicated boolean', async () => {
  const json = JSON.stringify([{ field_name: 'total', required: true }]);
  const doc = await chunkStructured('json', json, 'dict.json');
  const allFields = doc.units.flatMap((u) => u.structuredFields ?? []);
  const requiredField = allFields.find((f) => f.fieldName === 'required');
  assert.equal(requiredField?.rawValue, true);
  assert.equal(typeof requiredField?.rawValue, 'boolean');
});

test('existing ExperienceUnit.content is unchanged by the presence of structuredFields', async () => {
  const csv = ['name,role', 'Acme Corp,counterparty'].join('\n');
  const doc = await chunkStructured('csv', csv, 'parties.csv');
  const unit = doc.units.find((u) => u.structuredFields !== undefined);
  assert.ok(unit);
  // content is still the joined block text, exactly as before this milestone.
  assert.ok(unit!.content.includes('name: Acme Corp') || unit!.content.includes('role: counterparty'));
});

test('a non-structured (no structuredField blocks) unit has structuredFields absent, not an empty array', async () => {
  // Reuses the document frontend indirectly by chunking a ParsedDocument with no structuredField
  // blocks at all - simplest way without importing the PDF/HTML frontends here is to check a
  // structured source's own heading-only "Record N" unit, which has no paragraph blocks.
  const csv = ['a', '1'].join('\n');
  const doc = await chunkStructured('csv', csv, 'single-field.csv');
  for (const unit of doc.units) {
    if (unit.structuredFields === undefined) continue;
    assert.ok(unit.structuredFields.length > 0, 'structuredFields should be omitted (undefined), never an empty array');
  }
});
