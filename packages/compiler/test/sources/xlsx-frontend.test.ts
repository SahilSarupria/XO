import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodesOfKind } from '@xo/xoir';
import { extractXlsxText } from '../../src/sources/xlsx-text.js';
import { XlsxSourceFrontend } from '../../src/sources/xlsx-frontend.js';
import { compileSources } from '../../src/pipeline/compile-sources.js';
import { zip } from './zip-builder.js';

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const workbook = (sheets: [string, string][]) =>
  `<workbook ${NS}><sheets>${sheets.map(([n, rid], i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="${rid}"/>`).join('')}</sheets></workbook>`;
const rels = (targets: [string, string][]) =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${targets.map(([id, t]) => `<Relationship Id="${id}" Type="x/worksheet" Target="${t}"/>`).join('')}</Relationships>`;
const sst = (items: string[]) => `<sst ${NS}>${items.map((t) => `<si><t xml:space="preserve">${t}</t></si>`).join('')}</sst>`;
const sheet = (rows: string) => `<worksheet ${NS}><sheetData>${rows}</sheetData></worksheet>`;
const row = (r: number, cells: string) => `<row r="${r}">${cells}</row>`;
const s = (ref: string, idx: number) => `<c r="${ref}" t="s"><v>${idx}</v></c>`;
const n = (ref: string, v: number | string) => `<c r="${ref}"><v>${v}</v></c>`;

function book(sheets: { name: string; xml: string }[], strings: string[] = []): Uint8Array {
  return zip([
    { name: 'xl/workbook.xml', data: workbook(sheets.map((x, i) => [x.name, `rId${i + 1}`])) },
    { name: 'xl/_rels/workbook.xml.rels', data: rels(sheets.map((_, i) => [`rId${i + 1}`, `worksheets/sheet${i + 1}.xml`])) },
    ...(strings.length > 0 ? [{ name: 'xl/sharedStrings.xml', data: sst(strings) }] : []),
    ...sheets.map((x, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: x.xml })),
  ]);
}

test('sheets become labelled sections; each non-empty row becomes one pipe-separated line, in order', () => {
  const strings = ['Clause', 'Requirement', '1.1', 'Staff may borrow equipment.'];
  const xml = sheet(row(1, s('A1', 0) + s('B1', 1)) + row(2, s('A2', 2) + s('B2', 3)));
  const r = extractXlsxText(book([{ name: 'Rules', xml }], strings));
  assert.equal(r.ok && r.value, '## Rules\nClause | Requirement\n1.1 | Staff may borrow equipment.');
});

test('numbers, booleans, inline strings and cached formula values are read; empty cells keep column alignment', () => {
  const xml = sheet(
    row(1, `<c r="A1" t="inlineStr"><is><t>Limit</t></is></c>` + n('C1', 2000) + `<c r="D1" t="b"><v>1</v></c>`) + row(2, `<c r="A2" t="str"><f>A1&amp;"x"</f><v>Limitx</v></c>`),
  );
  const r = extractXlsxText(book([{ name: 'S', xml }]));
  assert.equal(r.ok && r.value, '## S\nLimit |  | 2000 | TRUE\nLimitx');
});

test('multiple sheets are kept in workbook order; fully empty rows and sheets are skipped', () => {
  const a = sheet(row(1, n('A1', 1)) + row(2, '') + row(3, n('A3', 3)));
  const b = sheet('');
  const c = sheet(row(1, n('A1', 9)));
  const r = extractXlsxText(book([{ name: 'First', xml: a }, { name: 'Empty', xml: b }, { name: 'Third', xml: c }]));
  assert.equal(r.ok && r.value, '## First\n1\n3\n\n## Third\n9');
});

test('XML entities in strings are decoded and rich-text runs are joined', () => {
  const strings = ['A &amp; B &lt;ok&gt;'];
  const xml = sheet(row(1, s('A1', 0)));
  assert.equal(extractXlsxText(book([{ name: 'S', xml }], strings)).ok && (extractXlsxText(book([{ name: 'S', xml }], strings)) as { value: string }).value, '## S\nA & B <ok>');
  const rich = `<sst ${NS}><si><r><t>Hel</t></r><r><t>lo</t></r></si></sst>`;
  const bytes = zip([
    { name: 'xl/workbook.xml', data: workbook([['S', 'rId1']]) },
    { name: 'xl/_rels/workbook.xml.rels', data: rels([['rId1', 'worksheets/sheet1.xml']]) },
    { name: 'xl/sharedStrings.xml', data: rich },
    { name: 'xl/worksheets/sheet1.xml', data: sheet(row(1, s('A1', 0))) },
  ]);
  const r = extractXlsxText(bytes);
  assert.equal(r.ok && r.value, '## S\nHello');
});

test('invalid inputs fail honestly: not a zip, no workbook, a missing sheet part', () => {
  assert.equal(extractXlsxText(new Uint8Array([1, 2, 3])).ok, false);
  assert.equal(extractXlsxText(zip([{ name: 'readme.txt', data: 'x' }])).ok, false);
  const broken = zip([
    { name: 'xl/workbook.xml', data: workbook([['S', 'rId1']]) },
    { name: 'xl/_rels/workbook.xml.rels', data: rels([['rId1', 'worksheets/missing.xml']]) },
  ]);
  const r = extractXlsxText(broken);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error.message, /missing|sheet/i);
});

test('a workbook with no text at all is refused, not returned as empty success', () => {
  assert.equal(extractXlsxText(book([{ name: 'S', xml: sheet('') }])).ok, false);
});

test('XLSX compile: a rules table in a sheet yields the same rule nodes as the same sentence in a document', async () => {
  const text = 'If the widget count exceeds 5, approve the request.';
  const bytes = book([{ name: 'Rules', xml: sheet(row(1, s('A1', 0))) }], [text]);
  const a = await compileSources([{ kind: 'xlsx', bytes, sourcePath: 'r.xlsx' }], {});
  const b = await compileSources([{ kind: 'document', text: `## Rules\n${text}`, sourcePath: 'r.md' }], {});
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  const view = (g: Parameters<typeof nodesOfKind>[0]) => [...nodesOfKind(g, 'heuristic'), ...nodesOfKind(g, 'decision_node')].map((x) => JSON.stringify(x.properties)).sort();
  assert.deepEqual(view(a.value.graph), view(b.value.graph));
  assert.equal(a.value.sources[0]!.sourceType, 'xlsx');
});

test('the frontend only claims xlsx-tagged input', () => {
  assert.equal(new XlsxSourceFrontend().canHandle({ kind: 'xlsx', bytes: new Uint8Array(), sourcePath: 'a.xlsx' }), true);
  assert.equal(new XlsxSourceFrontend().canHandle({ kind: 'docx', bytes: new Uint8Array(), sourcePath: 'a.docx' }), false);
});
