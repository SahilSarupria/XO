import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSource, compileSources } from '../../src/pipeline/compile-sources.js';
import { StructuredSourceFrontend } from '../../src/sources/structured-frontend.js';
import { chunkDocument } from '../../src/semantic/semantic-chunker.js';
import { buildTestPdf } from '../pdf/fixtures/build-test-pdf.js';

function samplePdfBytes(): Uint8Array {
  return buildTestPdf({
    title: 'Mutual NDA',
    pages: [
      {
        contentOps:
          '/F1 24 Tf 72 700 Td (Mutual Non-Disclosure Agreement) Tj ' +
          '/F1 12 Tf 0 -40 Td (This Agreement is entered into by two parties for the exchange of confidential business information.) Tj ' +
          '0 -14 Td (Each party shall keep the confidential information secret and shall not disclose it to any third party.) Tj',
      },
    ],
  });
}

const htmlInput = {
  kind: 'html' as const,
  html: '<html><head><title>Confidentiality FAQ</title></head><body>' + '<h1>Confidentiality FAQ</h1>' + '<p>Confidential information must not be disclosed to third parties without prior written consent.</p>' + '</body></html>',
  sourcePath: 'faq.html',
};

const jsonInput = {
  kind: 'structured' as const,
  format: 'json' as const,
  text: JSON.stringify([{ party: 'Acme Corp', obligation: 'must keep all shared information confidential and secure' }]),
  sourcePath: 'parties.json',
};

test('compileSource: a single PDF compiles end-to-end to a valid XOIR graph', async () => {
  const result = await compileSource({ kind: 'pdf', bytes: samplePdfBytes(), sourcePath: 'nda.pdf' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.valid, true);
  assert.equal(result.value.sources.length, 1);
  assert.equal(result.value.sources[0]!.sourceType, 'pdf');
  assert.equal(result.value.sources[0]!.semanticExtractionAvailable, true);
  assert.ok(result.value.sources[0]!.unitCount > 0);
  assert.ok(result.value.stats.nodeCount > 0);
});

test('compileSources: heterogeneous PDF + HTML + JSON sources compile together into one XOIR graph via the shared pipeline', async () => {
  const result = await compileSources([{ kind: 'pdf', bytes: samplePdfBytes(), sourcePath: 'nda.pdf' }, htmlInput, jsonInput]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.sources.length, 3);
  assert.deepEqual(
    result.value.sources.map((s) => s.sourceType),
    ['pdf', 'html', 'structured'],
  );
  for (const source of result.value.sources) {
    assert.equal(source.semanticExtractionAvailable, true);
    assert.ok(source.unitCount > 0, `expected ${source.sourceType} to contribute units`);
  }
});

test('multi-source compilation does not collide unit ids across sources with identical text content', async () => {
  const identicalTextA = { kind: 'document' as const, text: 'The parties agree to keep all information confidential.', sourcePath: 'copy-a.txt' };
  const identicalTextB = { kind: 'document' as const, text: 'The parties agree to keep all information confidential.', sourcePath: 'copy-b.txt' };
  const result = await compileSources([identicalTextA, identicalTextB]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.sources.length, 2);
  assert.notEqual(result.value.sources[0]!.sourceId, result.value.sources[1]!.sourceId);
});

test('an image alongside a textual source is reported (not silently dropped) but contributes zero units', async () => {
  const pngBytes = new Uint8Array(24);
  pngBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const result = await compileSources([htmlInput, { kind: 'image', bytes: pngBytes, sourcePath: 'photo.png' }]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.sources.length, 2);
  const imageReport = result.value.sources.find((s) => s.sourceType === 'image')!;
  assert.equal(imageReport.semanticExtractionAvailable, false);
  assert.equal(imageReport.unitCount, 0);
  const htmlReport = result.value.sources.find((s) => s.sourceType === 'html')!;
  assert.ok(htmlReport.unitCount > 0);
});

test('a batch of only non-textual sources fails clearly with SOURCE_CONTENT_UNAVAILABLE rather than silently producing an empty graph', async () => {
  const pngBytes = new Uint8Array(24);
  pngBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const result = await compileSources([{ kind: 'image', bytes: pngBytes, sourcePath: 'photo.png' }]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'XO_PRECONDITION_FAILED');
});

test('an unsupported/unrecognized input fails fast with a clear SourceError, not a partial result', async () => {
  const result = await compileSources([htmlInput, { totally: 'unrecognized' }]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'XO_NOT_FOUND');
});

test('compileSources rejects an empty input array', async () => {
  const result = await compileSources([]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'XO_INVALID_ARGUMENT');
});

test('a structured source with derived_from/formula/type-named fields produces no DERIVED_FROM/PRODUCES/CONSUMES edges and no capability created from those fields (structuredFields is inert past Stage 3)', async () => {
  const structuredInput = {
    kind: 'structured' as const,
    format: 'json' as const,
    text: JSON.stringify([
      { field_name: 'subtotal', formula: 'sum of line item amounts', type: 'number' },
      { field_name: 'tax_amount', derived_from: 'subtotal', formula: 'subtotal * tax_rate', type: 'number' },
      { field_name: 'total', derived_from: 'subtotal;tax_amount', formula: 'subtotal + tax_amount', type: 'number', required: true },
    ]),
    sourcePath: 'data-dictionary.json',
  };

  // Sanity-check at Stage 3 first: structuredFields really is populated for this input (proves the
  // absence of downstream effects below isn't just because nothing was preserved in the first place).
  const frontend = new StructuredSourceFrontend();
  const ingested = frontend.ingest(structuredInput);
  assert.equal(ingested.ok, true);
  if (ingested.ok && ingested.value.content.kind === 'document') {
    const doc = await chunkDocument(ingested.value.content.parsed, structuredInput.sourcePath, undefined);
    const anyStructuredFields = doc.units.some((u) => u.structuredFields !== undefined && u.structuredFields.length > 0);
    assert.equal(anyStructuredFields, true);
  }

  const result = await compileSource(structuredInput);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const edgesByKind = result.value.stats.edgesByKind;
  assert.equal(edgesByKind['DERIVED_FROM'] ?? 0, 0);
  assert.equal(edgesByKind['PRODUCES'] ?? 0, 0);
  assert.equal(edgesByKind['CONSUMES'] ?? 0, 0);

  const nodesByKind = result.value.stats.nodesByKind;
  // The presence of formula/derived_from/type/required-named fields must not, on its own, mint
  // any capability node - capability discovery is entirely unrelated to this preservation milestone.
  assert.equal(nodesByKind['capability'] ?? 0, 0);
});

test('compiling the same multi-source batch twice is deterministic', async () => {
  const inputs = [{ kind: 'pdf', bytes: samplePdfBytes(), sourcePath: 'nda.pdf' }, htmlInput, jsonInput];
  const a = await compileSources(inputs);
  const b = await compileSources(inputs);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(a.value.stats.nodeCount, b.value.stats.nodeCount);
  assert.equal(a.value.stats.edgeCount, b.value.stats.edgeCount);
  assert.deepEqual(
    a.value.sources.map((s) => s.sourceId),
    b.value.sources.map((s) => s.sourceId),
  );
});
