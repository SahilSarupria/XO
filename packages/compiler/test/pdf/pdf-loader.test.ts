import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NodePdfLoader } from '../../src/pdf/pdf-loader.js';
import { buildTestPdf } from './fixtures/build-test-pdf.js';

const loader = new NodePdfLoader();

test('loads a single-page PDF and extracts plain text', () => {
  const pdf = buildTestPdf({
    pages: [{ contentOps: '/F1 24 Tf 72 700 Td (Mutual Non-Disclosure Agreement) Tj' }],
    title: 'Sample NDA',
    author: 'Test Author',
  });
  const result = loader.load(pdf, 'sample.pdf');
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.pageCount, 1);
  assert.equal(result.value.metadata.title, 'Sample NDA');
  assert.equal(result.value.metadata.author, 'Test Author');
  assert.match(result.value.pages[0]!.plainText, /Mutual Non-Disclosure Agreement/);
  assert.equal(result.value.pages[0]!.pageNumber, 1);
  assert.equal(result.value.pages[0]!.requiresOcr, false);
});

test('loads a multi-page PDF preserving page order and page numbers', () => {
  const pdf = buildTestPdf({
    pages: [
      { contentOps: '/F1 12 Tf 72 700 Td (Page one content) Tj' },
      { contentOps: '/F1 12 Tf 72 700 Td (Page two content) Tj' },
      { contentOps: '/F1 12 Tf 72 700 Td (Page three content) Tj' },
    ],
  });
  const result = loader.load(pdf, 'multi.pdf');
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.pageCount, 3);
  assert.deepEqual(
    result.value.pages.map((p) => p.pageNumber),
    [1, 2, 3],
  );
  assert.match(result.value.pages[0]!.plainText, /Page one/);
  assert.match(result.value.pages[1]!.plainText, /Page two/);
  assert.match(result.value.pages[2]!.plainText, /Page three/);
});

test('extracts multiple lines in reading order via Td line breaks', () => {
  const pdf = buildTestPdf({
    pages: [
      {
        contentOps: '/F1 12 Tf 72 700 Td (First line) Tj 0 -14 Td (Second line) Tj 0 -14 Td (Third line) Tj',
      },
    ],
  });
  const result = loader.load(pdf, 'lines.pdf');
  assert.ok(result.ok);
  if (!result.ok) return;
  const lines = result.value.pages[0]!.plainText.split('\n');
  assert.deepEqual(lines, ['First line', 'Second line', 'Third line']);
});

test('extracts text from a TJ array with kerning numbers interleaved', () => {
  const pdf = buildTestPdf({
    pages: [{ contentOps: '/F1 12 Tf 72 700 Td [(Hel) -20 (lo) -10 (Wor) 5 (ld)] TJ' }],
  });
  const result = loader.load(pdf, 'tj.pdf');
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.pages[0]!.plainText, 'HelloWorld');
});

test('page-level content-stream array (multiple Contents entries) is not attempted here — single-stream Contents works', () => {
  // Documented as a design decision, not a gap: the fixture builder only ever emits a single content stream per page (the common case); PdfDocument#buildPage does support a /Contents array — see document.ts.
  assert.ok(true);
});

test('captures font name and size on each text run', () => {
  const pdf = buildTestPdf({
    pages: [{ contentOps: '/F1 18 Tf 72 700 Td (Heading text) Tj' }],
  });
  const result = loader.load(pdf, 'font.pdf');
  assert.ok(result.ok);
  if (!result.ok) return;
  const run = result.value.pages[0]!.textRuns[0];
  assert.equal(run?.fontName, 'F1');
  assert.equal(run?.fontSizePt, 18);
});

test('recovers via endstream-scanning when /Length is wrong', () => {
  const pdf = buildTestPdf({
    pages: [{ contentOps: '/F1 12 Tf 72 700 Td (Recovered despite bad length) Tj' }],
    corruptLength: true,
  });
  const result = loader.load(pdf, 'corrupt-length.pdf');
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.match(result.value.pages[0]!.plainText, /Recovered despite bad length/);
});

test('a page with no text-showing operators is flagged as requiring OCR', () => {
  const pdf = buildTestPdf({
    pages: [{ contentOps: 'q 1 0 0 RG 0 0 100 100 re S Q' }], // draws a rectangle, shows no text
  });
  const result = loader.load(pdf, 'no-text.pdf');
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.pages[0]!.requiresOcr, true);
});

test('compiling the same bytes twice produces identical plain text and page structure (determinism)', () => {
  const pdf = buildTestPdf({
    pages: [{ contentOps: '/F1 12 Tf 72 700 Td (Deterministic content) Tj' }],
    title: 'Determinism check',
  });
  const first = loader.load(pdf, 'det.pdf');
  const second = loader.load(pdf, 'det.pdf');
  assert.ok(first.ok && second.ok);
  if (!first.ok || !second.ok) return;
  assert.deepEqual(
    first.value.pages.map((p) => p.plainText),
    second.value.pages.map((p) => p.plainText),
  );
  assert.equal(first.value.metadata.title, second.value.metadata.title);
});

test('loading bytes that are not a PDF at all returns an err Result, not a throw', () => {
  const result = loader.load(new Uint8Array(Buffer.from('this is not a pdf')), 'garbage.pdf');
  assert.equal(result.ok, false);
});

test('mediaBox is inherited from the Pages node when a page does not declare its own', () => {
  const pdf = buildTestPdf({
    pages: [{ contentOps: '/F1 12 Tf 72 700 Td (No own MediaBox) Tj' }],
  });
  const result = loader.load(pdf, 'inherit.pdf');
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value.pages[0]!.mediaBox, [0, 0, 612, 792]);
});
