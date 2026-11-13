// UW-3: header detection, multi-sheet and multi-table record sets, declared types, and the findings that replace guessing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabularFromCsv, tabularFromXlsx } from '../../src/tabular/index.js';
import { workbook, texts } from './workbook-builder.js';

test('multi-sheet workbook: title rows are skipped, the header is found per sheet, columns are typed, every value cites its cell', () => {
  const r = tabularFromXlsx(
    workbook([
      {
        name: 'Clients',
        rows: {
          1: { A: { s: 'Client register, March 2026' } },
          2: { A: { s: 'Prepared by operations' } },
          4: texts('ABCD', 'Client ID', 'Name', 'Renewal', 'Premium'),
          5: { A: { s: 'C-001' }, B: { s: 'Asha Rao' }, C: { n: 46112, style: 2 }, D: { n: 12000 } },
          6: { A: { s: 'C-002' }, B: { s: 'Ravi Iyer' }, C: { n: 46120, style: 2 }, D: { n: 8450.5 } },
        },
      },
      {
        name: 'Policies',
        rows: { 1: texts('AB', 'Policy', 'Client ID'), 2: texts('AB', 'P-9', 'C-001') },
      },
    ]),
  );
  assert.ok(r.ok, r.ok ? undefined : r.error.message);
  const [clients, policies] = r.value.recordSets;
  assert.equal(clients!.id, 'Clients#1');
  assert.equal(clients!.headerRow, 4);
  assert.match(clients!.headerEvidence!, /row 4 is the first row of 4 distinct text values with typed data below it/);
  assert.deepEqual(
    clients!.titles.map((t) => t.raw),
    ['Client register, March 2026', 'Prepared by operations'],
  );
  assert.deepEqual(
    clients!.columns.map((c) => [c.header, c.headerRef, c.declaredType]),
    [
      ['Client ID', 'Clients!A4', 'string'],
      ['Name', 'Clients!B4', 'string'],
      ['Renewal', 'Clients!C4', 'date'],
      ['Premium', 'Clients!D4', 'decimal'],
    ],
  );
  const renewal = clients!.records[0]!.cells[3]!;
  assert.deepEqual([renewal.ref, renewal.raw, renewal.date?.iso], ['Clients!C5', '46112', '2026-03-31']);
  assert.equal(clients!.records[1]!.cells[4]!.raw, '8450.5');
  assert.equal(policies!.sheet, 'Policies');
  assert.equal(policies!.records.length, 1);
});

test('two tables on one sheet, separated by two blank rows, become two record sets', () => {
  const r = tabularFromXlsx(
    workbook([
      {
        name: 'Summary',
        rows: {
          1: texts('AB', 'Metric', 'Value'),
          2: { A: { s: 'Clients' }, B: { n: 2 } },
          5: texts('ABC', 'Branch', 'Manager', 'Staff'),
          6: { A: { s: 'Pune' }, B: { s: 'Meera' }, C: { n: 12 } },
        },
      },
    ]),
  );
  assert.ok(r.ok);
  assert.deepEqual(
    r.value.recordSets.map((s) => [s.id, s.headerRow, s.records.length]),
    [
      ['Summary#1', 1, 1],
      ['Summary#2', 5, 1],
    ],
  );
});

test('no qualifying header: columns are named by letter and the table says so, rather than mislabelling every value', () => {
  const r = tabularFromCsv('101,2024-01-05,400\n102,2024-01-06,410\n103,2024-01-07,390');
  assert.ok(r.ok);
  const [set] = r.value.recordSets;
  assert.equal(set!.headerRow, undefined);
  assert.deepEqual(
    set!.columns.map((c) => [c.header, c.declaredType]),
    [
      ['Column A', 'integer'],
      ['Column B', 'date'],
      ['Column C', 'integer'],
    ],
  );
  assert.equal(set!.records.length, 3);
  assert.ok(set!.findings.some((f) => f.code === 'HEADER_NOT_FOUND'));
});

test('findings instead of guesses: ambiguous dates, separated numbers, mixed columns, duplicate and missing headers, stray columns', () => {
  const r = tabularFromCsv(
    [
      'name,due,amount,code,name,,',
      'A,03/04/2026,"1,200.50",7,x,,',
      'B,04/05/2026,300,N/A,y,stray,',
      'C,05/06/2026,"2,000",9,z,,more',
    ].join('\n'),
  );
  assert.ok(r.ok);
  const [set] = r.value.recordSets;
  const codes = set!.findings.map((f) => f.code);
  for (const c of [
    'AMBIGUOUS_DATE_FORMAT',
    'NUMBER_WITH_SEPARATORS',
    'MIXED_TYPES',
    'DUPLICATE_HEADER',
    'VALUES_OUTSIDE_HEADER',
  ] as const) {
    assert.ok(codes.includes(c), `${c} in ${codes.join(', ')}`);
  }
  const due = set!.columns.find((c) => c.header === 'due')!;
  assert.equal(due.declaredType, 'string', 'day-first and month-first readings differ, so these stay text');
  const code = set!.columns.find((c) => c.header === 'code')!;
  assert.equal(code.declaredType, 'mixed');
  assert.deepEqual(code.counts, { integer: 2, string: 1 });
});

test('integers and decimals together declare decimal; a header-only table has a header and no records', () => {
  const r = tabularFromCsv('qty,price\n1,2\n3,4.5');
  assert.ok(r.ok);
  assert.deepEqual(
    r.value.recordSets[0]!.columns.map((c) => c.declaredType),
    ['integer', 'decimal'],
  );
  const empty = tabularFromCsv('name,email');
  assert.ok(empty.ok);
  assert.deepEqual([empty.value.recordSets[0]!.headerRow, empty.value.recordSets[0]!.records.length], [1, 0]);
});

test('a text-only table takes its first full-width row as the header, and says why', () => {
  const r = tabularFromCsv('name,city\nAsha,Pune\nRavi,Mumbai');
  assert.ok(r.ok);
  assert.match(r.value.recordSets[0]!.headerEvidence!, /every value in this table is text/);
});
