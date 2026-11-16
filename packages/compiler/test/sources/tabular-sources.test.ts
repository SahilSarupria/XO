// UW-3: XLSX and CSV sources carry their record sets (with cell provenance) next to the text the semantic pipeline reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XlsxSourceFrontend } from '../../src/sources/xlsx-frontend.js';
import { StructuredSourceFrontend } from '../../src/sources/structured-frontend.js';
import { workbook, texts } from '../tabular/workbook-builder.js';

test('an XLSX source carries typed record sets from the same parse as its text, and counts them in its metadata', () => {
  const bytes = workbook([
    {
      name: 'Clients',
      rows: { 1: texts('AB', 'Name', 'Premium'), 2: { A: { s: 'Asha' }, B: { n: 1200 } }, 3: { A: { s: 'Ravi' }, B: { n: 900 } } },
    },
  ]);
  const r = new XlsxSourceFrontend().ingest({ kind: 'xlsx', bytes, sourcePath: 'clients.xlsx' });
  assert.ok(r.ok, r.ok ? undefined : r.error.message);
  if (r.value.content.kind !== 'document') return assert.fail('document content expected');
  assert.match(r.value.content.plainText, /## Clients\nName \| Premium\nAsha \| 1200/);
  const set = r.value.content.tables!.recordSets[0]!;
  assert.deepEqual(
    set.records.map((rec) => rec.cells[2]!.ref),
    ['Clients!B2', 'Clients!B3'],
  );
  assert.deepEqual([r.value.metadata.sheetCount, r.value.metadata.recordSetCount, r.value.metadata.recordCount], ['1', '1', '2']);
});

test('a CSV source carries its record sets, and each field block names its cell', () => {
  const r = new StructuredSourceFrontend().ingest({
    kind: 'structured',
    format: 'csv',
    text: 'name,city\n"Rao, Asha",Pune',
    sourcePath: 'c.csv',
  });
  assert.ok(r.ok);
  if (r.value.content.kind !== 'document') return assert.fail('document content expected');
  assert.equal(r.value.content.tables!.recordSets[0]!.records[0]!.cells[1]!.raw, 'Rao, Asha', 'a quoted comma is part of the value');
  const blocks = r.value.content.parsed.root.subsections[0]!.blocks;
  const city = blocks.find((b) => b.kind === 'paragraph' && b.structuredField?.fieldName === 'city');
  assert.ok(city !== undefined && city.kind === 'paragraph');
  assert.equal(city.structuredField?.cellRef, 'B2');
});
