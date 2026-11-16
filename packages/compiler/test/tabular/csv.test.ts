// UW-3: RFC 4180 CSV reading, provenance and loud refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDelimiter, readCsv, tabularFromCsv } from '../../src/tabular/index.js';

const cellsOf = (text: string) => {
  const r = readCsv(text);
  assert.ok(r.ok, r.ok ? undefined : r.error.message);
  return r.value;
};

test('quoted fields keep delimiters, doubled quotes and line breaks; every cell records its record and starting line', () => {
  const { grid } = cellsOf('name,note,amount\r\n"Rao, Priya","said ""hold""\nuntil Friday",1200\r\nLee,,"3,400.50"\n');
  const [header, r2] = grid.rows;
  assert.deepEqual(
    header!.cells.map((c) => c.raw),
    ['name', 'note', 'amount'],
  );
  assert.deepEqual(
    r2!.cells.map((c) => [c.ref, c.raw, c.line]),
    [
      ['A2', 'Rao, Priya', 2],
      ['B2', 'said "hold"\nuntil Friday', 2],
      ['C2', '1200', 2],
    ],
  );
  const r3 = grid.rows[2]!;
  assert.deepEqual(
    r3.cells.map((c) => [c.ref, c.raw, c.line]),
    [
      ['A3', 'Lee', 4],
      ['C3', '3,400.50', 4],
    ],
    'an empty field is absent, the next keeps its column, and the record starts on physical line 4',
  );
});

test('a byte-order mark is dropped; CR-only and LF line endings both work; whitespace inside values is kept as written', () => {
  const { grid } = cellsOf('﻿a,b\r1, x \r2,y');
  assert.equal(grid.rows[0]!.cells[0]!.raw, 'a');
  assert.equal(grid.rows[1]!.cells[1]!.raw, ' x ');
  assert.equal(grid.rows.length, 3);
});

test('the delimiter is found from the file: semicolon, tab and pipe exports read correctly; quoted delimiters do not count', () => {
  assert.equal(detectDelimiter('name;amount\n"A;B";1\nC;2'), ';');
  assert.equal(detectDelimiter('name\tamount\nA\t1'), '\t');
  assert.equal(detectDelimiter('a|b|c\n1|2|3'), '|');
  assert.equal(detectDelimiter('"x, y",1\n"p, q",2'), ',');
  assert.equal(detectDelimiter('just one column\nanother'), ',');
  assert.deepEqual(
    cellsOf('name;amount\n"A;B";1').grid.rows[1]!.cells.map((c) => c.raw),
    ['A;B', '1'],
  );
});

test('a quote inside an unquoted field is kept as text and reported once', () => {
  const r = cellsOf('item,size\npipe,5" wide\nrod,2" long');
  assert.equal(r.grid.rows[1]!.cells[1]!.raw, '5" wide');
  assert.deepEqual(
    r.findings.map((f) => [f.code, f.ref]),
    [['STRAY_QUOTE', 'B2']],
  );
});

test('refused loudly: an unclosed quote, NUL bytes, an empty file, and anything past the limits', () => {
  const refusal = (text: string, pattern: RegExp, limits?: Parameters<typeof readCsv>[1]) => {
    const r = readCsv(text, limits);
    assert.equal(r.ok, false, text.slice(0, 30));
    if (!r.ok) {
      assert.match(r.error.message, pattern);
      assert.equal(r.error.code, 'XO_SERIALIZATION_SCHEMA_MISMATCH');
    }
  };
  refusal('a,b\n"open,1\n2,3', /never closed/);
  refusal('a,b\n1,\u00002', /NUL bytes/);
  refusal('  \n ', /empty/);
  refusal('a,b,c\n1,2,3', /more than 4 values/, { limits: { maxCells: 4 } });
  refusal('a\n' + 'x'.repeat(20), /longer than 10 characters/, { limits: { maxCellChars: 10 } });
  refusal('a,b,c', /more than 2 fields/, { limits: { maxColumns: 2 } });
});

test('CSV record sets: header, declared types without conversion, and per-cell provenance', () => {
  const t = tabularFromCsv(
    [
      'client_id,name,joined,balance,active,branch_code',
      '00123,Asha Rao,2024-03-01,1500,true,0042',
      '00124,Vikram Shah,2024-03-15,99.5,false,0043',
    ].join('\n'),
  );
  assert.ok(t.ok);
  const [set] = t.value.recordSets;
  assert.equal(set!.headerRow, 1);
  assert.deepEqual(
    set!.columns.map((c) => [c.header, c.declaredType]),
    [
      ['client_id', 'string'],
      ['name', 'string'],
      ['joined', 'date'],
      ['balance', 'decimal'],
      ['active', 'boolean'],
      ['branch_code', 'string'],
    ],
  );
  const first = set!.records[0]!;
  assert.equal(first.cells[1]!.raw, '00123', 'leading zeros survive: identifiers are never read as numbers');
  assert.equal(first.cells[3]!.raw, '2024-03-01', 'a date column keeps the text exactly as written');
  assert.equal(first.cells[4]!.ref, 'D2');
});
