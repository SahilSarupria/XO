import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zip } from './zip-builder.js';
import { nodesOfKind } from '@xo/xoir';
import { extractDocxText } from '../../src/sources/docx-text.js';
import { DocxSourceFrontend } from '../../src/sources/docx-frontend.js';
import { compileSources } from '../../src/pipeline/compile-sources.js';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docx = (body: string, extra: { name: string; data: string }[] = []) =>
  zip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: `<w:document ${W}><w:body>${body}</w:body></w:document>` },
    ...extra,
  ]);
const p = (text: string, style?: string, numbered = false) =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${numbered ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : ''}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

test('paragraphs, headings and list items become structured text lines', () => {
  const r = extractDocxText(
    docx(p('Equipment Policy', 'Heading1') + p('Staff may borrow equipment.') + p('Return it on time.', undefined, true)),
  );
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, '# Equipment Policy\nStaff may borrow equipment.\n- Return it on time.');
});

test('runs inside one paragraph are joined; tabs and breaks become whitespace; XML entities are decoded', () => {
  const body =
    '<w:p><w:r><w:t>If A </w:t></w:r><w:r><w:t>&amp; B</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>&lt;ok&gt;</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>next</w:t></w:r></w:p>';
  const r = extractDocxText(docx(body));
  assert.equal(r.ok && r.value, 'If A & B <ok> next');
});

test('a table becomes one pipe-separated line per row (reading order preserved, cells never fused)', () => {
  const cell = (t: string) => `<w:tc>${p(t)}</w:tc>`;
  const tbl = `<w:tbl><w:tr>${cell('Clause')}${cell('Requirement')}</w:tr><w:tr>${cell('1.1')}${cell('Staff may borrow equipment.')}</w:tr></w:tbl>`;
  const r = extractDocxText(docx(p('Intro text here.') + tbl + p('After table.')));
  assert.equal(r.ok && r.value, 'Intro text here.\nClause | Requirement\n1.1 | Staff may borrow equipment.\nAfter table.');
});

test('footnotes and endnotes are appended under their own labelled sections, never silently dropped', () => {
  const fn = `<w:footnotes ${W}><w:footnote w:type="separator" w:id="0"><w:p><w:r><w:t>separator</w:t></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:r><w:t>Applies only to contractors.</w:t></w:r></w:p></w:footnote></w:footnotes>`;
  const r = extractDocxText(docx(p('Main text here.'), [{ name: 'word/footnotes.xml', data: fn }]));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.value, /Main text here\./);
    assert.match(r.value, /Footnotes:\n- Applies only to contractors\./);
    assert.equal(r.value.includes('separator'), false);
  }
});

test('stored (uncompressed) entries are read as well as deflated ones', () => {
  const bytes = zip([
    { name: 'word/document.xml', data: `<w:document ${W}><w:body>${p('Plain stored text.')}</w:body></w:document>`, method: 0 },
  ]);
  const r = extractDocxText(bytes);
  assert.equal(r.ok && r.value, 'Plain stored text.');
});

test('invalid inputs fail with a specific, honest error (never garbage text)', () => {
  assert.equal(extractDocxText(new Uint8Array([1, 2, 3, 4, 5])).ok, false);
  assert.equal(extractDocxText(zip([{ name: 'readme.txt', data: 'hi' }])).ok, false);
  const corrupt = Buffer.from(docx(p('Hello there.')));
  corrupt[corrupt.indexOf(Buffer.from('word/document.xml')) + 40] ^= 0xff; // damage the compressed body
  assert.equal(extractDocxText(new Uint8Array(corrupt)).ok, false);
});

test('a decompression bomb is refused by the size limit', () => {
  const huge = 'a'.repeat(60 * 1024 * 1024);
  const r = extractDocxText(zip([{ name: 'word/document.xml', data: huge }]));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error.message, /too large|limit/i);
});

test('a real python-docx generated file extracts its clauses', () => {
  const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL('../fixtures/loan-python-docx.docx', import.meta.url))));
  const r = extractDocxText(bytes);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.value, /Staff may borrow equipment for up to 30 days\./);
    assert.match(r.value, /1\.2 If the equipment value exceeds 2000 USD, department head approval is required\./);
  }
});

test('DocxSourceFrontend + compile: a DOCX yields the same rule nodes as the same text supplied as a document', async () => {
  const text = 'If the widget count exceeds 5, approve the request.';
  const a = await compileSources([{ kind: 'docx', bytes: docx(p(text)), sourcePath: 'r.docx' }], {});
  const b = await compileSources([{ kind: 'document', text, sourcePath: 'r.md' }], {});
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  const view = (g: Parameters<typeof nodesOfKind>[0]) =>
    [...nodesOfKind(g, 'heuristic'), ...nodesOfKind(g, 'decision_node')].map((n) => JSON.stringify(n.properties)).sort();
  assert.deepEqual(view(a.value.graph), view(b.value.graph));
  assert.equal(a.value.sources[0]!.sourceType, 'docx');
});

test('the frontend only claims docx-tagged input', () => {
  const fe = new DocxSourceFrontend();
  assert.equal(fe.canHandle({ kind: 'docx', bytes: new Uint8Array(), sourcePath: 'a.docx' }), true);
  assert.equal(fe.canHandle({ kind: 'pdf', bytes: new Uint8Array(), sourcePath: 'a.pdf' }), false);
});
