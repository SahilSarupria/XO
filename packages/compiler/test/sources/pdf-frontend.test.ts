import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PdfSourceFrontend } from '../../src/sources/pdf-frontend.js';
import { NodePdfLoader } from '../../src/pdf/pdf-loader.js';
import { parseDocument } from '../../src/document/document-parser.js';
import { buildTestPdf } from '../pdf/fixtures/build-test-pdf.js';

const frontend = new PdfSourceFrontend();

function samplePdf(): Uint8Array {
  return buildTestPdf({
    title: 'Mutual NDA',
    pages: [
      {
        contentOps:
          '/F1 24 Tf 72 700 Td (Mutual Non-Disclosure Agreement) Tj ' +
          '/F1 12 Tf 0 -40 Td (This Agreement is entered into by the parties below.) Tj',
      },
    ],
  });
}

test('canHandle accepts explicitly-tagged pdf input', () => {
  assert.equal(frontend.canHandle({ kind: 'pdf', bytes: samplePdf(), sourcePath: 'nda.pdf' }), true);
});

test('canHandle detects untagged bytes via the %PDF- magic header', () => {
  assert.equal(frontend.canHandle({ bytes: samplePdf(), sourcePath: 'nda.pdf' }), true);
});

test('canHandle rejects non-PDF bytes and non-object input', () => {
  assert.equal(frontend.canHandle({ bytes: new TextEncoder().encode('not a pdf'), sourcePath: 'x' }), false);
  assert.equal(frontend.canHandle('a string'), false);
  assert.equal(frontend.canHandle(null), false);
});

test('ingest produces a CanonicalSource whose parsed structure exactly matches direct NodePdfLoader + parseDocument (behavior preserved)', () => {
  const bytes = samplePdf();
  const direct = new NodePdfLoader().load(bytes, 'nda.pdf');
  assert.ok(direct.ok);
  if (!direct.ok) return;
  const directParsed = parseDocument(direct.value);

  const result = frontend.ingest({ kind: 'pdf', bytes, sourcePath: 'nda.pdf' });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.sourceType, 'pdf');
  assert.equal(result.value.semanticExtractionAvailable, true);
  assert.equal(result.value.content.kind, 'document');
  if (result.value.content.kind === 'document') {
    assert.deepEqual(result.value.content.parsed, directParsed);
    assert.equal(result.value.content.documentTitle, 'Mutual NDA');
  }
});

test('ingest carries real page-based provenance through unchanged', () => {
  const bytes = samplePdf();
  const result = frontend.ingest({ kind: 'pdf', bytes, sourcePath: 'nda.pdf' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  if (result.value.content.kind !== 'document') return;
  const heading = result.value.content.parsed.root.subsections[0]!.heading!;
  assert.equal(heading.provenance.page, 1);
  assert.equal(typeof heading.provenance.yRange[0], 'number');
});

test('sourceId is deterministic for identical PDF bytes and path', () => {
  const bytes = samplePdf();
  const a = frontend.ingest({ kind: 'pdf', bytes, sourcePath: 'nda.pdf' });
  const b = frontend.ingest({ kind: 'pdf', bytes, sourcePath: 'nda.pdf' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (a.ok && b.ok) assert.equal(a.value.sourceId, b.value.sourceId);
});

test('malformed PDF bytes fail ingest with SOURCE_PARSE_FAILED, not a thrown exception', () => {
  const bytes = new TextEncoder().encode('%PDF-1.7\nnot actually a valid pdf body');
  const result = frontend.ingest({ kind: 'pdf', bytes, sourcePath: 'broken.pdf' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'XO_SERIALIZATION_PARSE_FAILED');
});
