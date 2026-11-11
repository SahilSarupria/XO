import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PdfSourceFrontend } from '../../src/sources/pdf-frontend.js';
import type { LoadedPdfDocument, PdfLoader } from '../../src/pdf/pdf-loader.js';
import { compileSources } from '../../src/pipeline/compile-sources.js';

const scanned = new Uint8Array(readFileSync(fileURLToPath(new URL('../fixtures/scanned-image-only.pdf', import.meta.url))));

test('image-only PDF: compile reports an ocr-required ERROR diagnostic instead of silently yielding nothing', async () => {
  const result = await compileSources([{ kind: 'pdf', bytes: scanned, sourcePath: 'scan.pdf' }], {});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const ocr = result.value.diagnostics.filter((d) => d.code === 'source-quality/ocr-required');
  assert.equal(ocr.length, 1);
  assert.equal(ocr[0]!.severity, 'error'); // every page lacks text => nothing was compiled
  assert.match(ocr[0]!.message, /NOT compiled/);
  assert.equal(result.value.sources[0]!.unitCount, 0);
});

function stubLoader(pages: { plainText: string; requiresOcr: boolean }[]): PdfLoader {
  const doc = { pageCount: pages.length, metadata: {}, pages: pages.map((p, i) => ({ pageNumber: i + 1, sourceObjectNumber: i + 1, mediaBox: [0, 0, 612, 792], rotate: 0, textRuns: [], resolveFontEncoding: () => ({}), ...p })) } as unknown as LoadedPdfDocument;
  return { load: () => ({ ok: true, value: doc }) } as unknown as PdfLoader;
}

test('PdfSourceFrontend records which pages need OCR (partial scan => listed pages only)', () => {
  const fe = new PdfSourceFrontend(stubLoader([{ plainText: 'text page', requiresOcr: false }, { plainText: '', requiresOcr: true }, { plainText: '', requiresOcr: true }]));
  const r = fe.ingest({ kind: 'pdf', bytes: new Uint8Array([1]), sourcePath: 'p.pdf' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.metadata['ocrRequiredPages'], '2,3');
});

test('PdfSourceFrontend adds no OCR metadata when every page has a text layer', () => {
  const fe = new PdfSourceFrontend(stubLoader([{ plainText: 'text', requiresOcr: false }]));
  const r = fe.ingest({ kind: 'pdf', bytes: new Uint8Array([1]), sourcePath: 'p.pdf' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal('ocrRequiredPages' in r.value.metadata, false);
});
