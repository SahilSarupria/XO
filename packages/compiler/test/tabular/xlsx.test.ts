// UW-3: typed XLSX cells (stored values, dates only where the format declares one, formulas never evaluated) and hostile input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { isDateFormatCode, readXlsxWorkbook, serialToIso, tabularFromXlsx } from '../../src/tabular/index.js';
import { workbook, texts } from './workbook-builder.js';
import { zip } from '../sources/zip-builder.js';

const read = (bytes: Uint8Array) => {
  const r = readXlsxWorkbook(bytes);
  assert.ok(r.ok, r.ok ? undefined : r.error.message);
  return r.value;
};

test('every cell keeps what was stored, with its sheet-qualified reference', () => {
  const wb = read(
    workbook([
      {
        name: 'Clients',
        rows: {
          1: texts('ABCDEF', 'Name', 'Inline', 'Amount', 'Active', 'Check', 'Label'),
          2: {
            A: { s: 'Asha' },
            B: { is: 'R&D <team>' },
            C: { n: '1500.50' },
            D: { b: true },
            E: { e: '#N/A' },
            F: { str: 'gold', f: 'IF(C2>1000,"gold","std")' },
          },
        },
      },
    ]),
  );
  const cells = wb.sheets[0]!.rows[1]!.cells;
  assert.deepEqual(
    cells.map((c) => [c.ref, c.kind, c.raw]),
    [
      ['Clients!A2', 'string', 'Asha'],
      ['Clients!B2', 'string', 'R&D <team>'],
      ['Clients!C2', 'number', '1500.50'],
      ['Clients!D2', 'boolean', '1'],
      ['Clients!E2', 'error', '#N/A'],
      ['Clients!F2', 'string', 'gold'],
    ],
  );
  assert.equal(cells[5]!.formula, 'IF(C2>1000,"gold","std")', 'the formula is recorded; its cached result is the value');
});

test('dates: only cells whose own format declares a date are dates, read in the workbook date system with the serial kept', () => {
  const wb = read(
    workbook([
      {
        name: 'D',
        rows: {
          1: texts('ABCDE', 'builtin', 'custom', 'percent', 'locale', 'time'),
          2: {
            A: { n: 45291, style: 1 },
            B: { n: 45292, style: 2 },
            C: { n: 0.125, style: 3 },
            D: { n: 45293, style: 4 },
            E: { n: 45291.75, style: 5 },
          },
        },
      },
    ]),
  );
  const [a, b, c, d, e] = wb.sheets[0]!.rows[1]!.cells;
  assert.deepEqual([a!.kind, a!.raw, a!.date], ['date', '45291', { serial: 45291, system: 1900, iso: '2023-12-31' }]);
  assert.equal(b!.date?.iso, '2024-01-01');
  assert.equal(b!.numberFormat, 'dd/mm/yyyy');
  assert.equal(c!.kind, 'number', 'a percentage format is not a date');
  assert.equal(d!.date?.iso, '2024-01-02', 'a locale-prefixed date format is a date');
  assert.equal(e!.date?.iso, '2023-12-31T18:00:00');
  const b1904 = read(workbook([{ name: 'D', rows: { 1: { A: { n: 0, style: 1 } } } }], { date1904: true }));
  assert.deepEqual(b1904.sheets[0]!.rows[0]!.cells[0]!.date, { serial: 0, system: 1904, iso: '1904-01-01' });
});

test('serial reading and format detection are exact at the edges', () => {
  assert.equal(serialToIso(1, 1900), '1900-01-01');
  assert.equal(serialToIso(59, 1900), '1900-02-28');
  assert.equal(serialToIso(61, 1900), '1900-03-01');
  assert.equal(serialToIso(1461, 1904), '1908-01-01');
  assert.equal(serialToIso(45291 - 1462, 1904), '2023-12-31', 'the same day is 1462 lower in the 1904 system');
  for (const code of ['dd/mm/yyyy', 'yyyy-mm-dd hh:mm', '[$-409]mmmm d, yyyy', 'h:mm AM/PM', '[h]:mm:ss'])
    assert.equal(isDateFormatCode(code), true, code);
  for (const code of ['General', '0.00%', '#,##0.00', '"Total: "0', '[Red]#,##0;[Blue]-#,##0', '0.0E+00'])
    assert.equal(isDateFormatCode(code), false, code);
});

test('serial 60 (the non-existent 29 February 1900) is reported, not silently shifted', () => {
  const r = tabularFromXlsx(workbook([{ name: 'S', rows: { 1: texts('A', 'd'), 2: { A: { n: 60, style: 1 } } } }]));
  assert.ok(r.ok);
  assert.ok(r.value.findings.some((f) => f.code === 'FICTITIOUS_DATE'));
});

test('hidden sheets are read and marked; merged ranges are reported, never filled', () => {
  const r = tabularFromXlsx(
    workbook([
      {
        name: 'Visible',
        rows: { 1: texts('AB', 'Region', 'Client'), 2: { A: { s: 'West' }, B: { s: 'Asha' } }, 3: { B: { s: 'Ravi' } } },
        merges: ['A2:A3'],
      },
      { name: 'Lookup', rows: { 1: texts('AB', 'code', 'label'), 2: texts('AB', 'W', 'West') }, hidden: true },
    ]),
  );
  assert.ok(r.ok);
  assert.equal(r.value.sheets[1]!.hidden, true);
  assert.ok(r.value.findings.some((f) => f.code === 'HIDDEN_SHEET' && f.ref === 'Lookup'));
  const visible = r.value.recordSets.find((s) => s.sheet === 'Visible')!;
  assert.equal(visible.records[1]!.cells[1], undefined, 'Ravi has no region of their own: the merged West is not copied down');
  assert.ok(visible.findings.some((f) => f.code === 'MERGED_CELLS' && f.ref === 'Visible!A2:A3'));
});

test('hostile or broken workbooks are refused loudly with the reason', () => {
  const refused = (bytes: Uint8Array, pattern: RegExp, limits?: Parameters<typeof readXlsxWorkbook>[1]) => {
    const r = readXlsxWorkbook(bytes, limits);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error.message, pattern);
  };
  // entity expansion / external entity attempt
  refused(
    zip([{ name: 'xl/workbook.xml', data: '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><workbook><sheets/></workbook>' }]),
    /DOCTYPE/,
  );
  refused(zip([{ name: 'docProps/app.xml', data: '<x/>' }]), /no xl\/workbook\.xml/);
  refused(new TextEncoder().encode('name,amount\n1,2'), /not a ZIP/);
  // a shared-string index that does not exist
  const patched = zip([
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>7</v></c></row></sheetData></worksheet>',
    },
  ]);
  refused(patched, /shared string 7, which does not exist/);
  // past the cell limit
  refused(workbook([{ name: 'S', rows: { 1: texts('ABC', 'a', 'b', 'c') } }]), /more than 2 values/, { limits: { maxCells: 2 } });
  // a sheet that points nowhere
  refused(
    zip([
      { name: 'xl/workbook.xml', data: '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId9"/></sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships/>' },
    ]),
    /no resolvable worksheet part/,
  );
});

test('a decompression bomb that lies about its size is stopped at the limit, not expanded', () => {
  const huge = Buffer.alloc(60 * 1024 * 1024, 0x20);
  const body = deflateRawSync(huge);
  const name = Buffer.from('xl/workbook.xml');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(100, 22); // lies: claims 100 bytes
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(100, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12);
  end.writeUInt32LE(30 + name.length + body.length, 16);
  const bomb = Buffer.concat([local, name, body, central, name, end]);
  const r = readXlsxWorkbook(new Uint8Array(bomb));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error.message, /too large after decompression/);
});
