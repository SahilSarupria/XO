// UW-3 — photos and scanned images are read by the same recovery tiers as scanned PDF pages, and their text is marked as recovered.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileSources } from '../../src/pipeline/compile-sources.js';
import { extractDimensions } from '../../src/sources/image-frontend.js';
import type { PageTier } from '../../src/extraction/types.js';
import { createTesseractTier, isTesseractAvailable, shutdownTesseract } from '../../src/extraction/adapters/index.js';
import { isPdfiumAvailable, renderPageGray, shutdownPdfium } from '../../src/extraction/adapters/pdfium.js';
import { cropToContent, encodeGrayPng } from '../../src/extraction/adapters/png.js';

const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x04, 0xb0, 0, 0, 0x06, 0x40, 8, 0, 0, 0, 0,
]);

function stubTier(opts: { acceptsImages: boolean; lines?: string[]; confidence?: number }): PageTier & { calls: number } {
  const t = {
    name: 'stub-photo-ocr',
    version: '1',
    costClass: 'local' as const,
    acceptsImages: opts.acceptsImages,
    calls: 0,
    handles: () => true,
    async recover({ document }: Parameters<PageTier['recover']>[0]) {
      t.calls++;
      assert.equal(document.sourceImage?.mimeType, 'image/png', 'the tier is told it is reading an image');
      return {
        lines: (opts.lines ?? []).map((text, i) => ({ text, x: 40, y: 1500 - i * 40, fontSizePt: i === 0 ? 18 : 11 })),
        confidence: opts.confidence ?? 0.88,
      };
    },
  };
  return t;
}

test('a photographed certificate is read by an image-capable tier and compiles as a document marked as recovered text', async () => {
  const tier = stubTier({
    acceptsImages: true,
    lines: [
      'Certificate of Insurance',
      'This is to certify that Asha Rao holds policy P-9.',
      'If the claim amount exceeds 10000, then refer the claim.',
    ],
  });
  const r = await compileSources([{ kind: 'image', bytes: PNG_1x1, sourcePath: 'IMG_2041.png' }], { pageTiers: [tier] });
  assert.ok(r.ok, r.ok ? undefined : r.error.message);
  const src = r.value.sources[0]!;
  assert.equal(tier.calls, 1);
  assert.equal(src.semanticExtractionAvailable, true);
  assert.ok(src.unitCount > 0);
  assert.deepEqual([src.coverage?.ocrPages, src.coverage?.unaccountedPages], [1, 0]);
  assert.equal(src.recovery?.pagesRecovered, 1);
  assert.equal(src.kindProposals?.[0]?.kind, 'certificate', 'the kind is proposed from the text read off the photo, not the file name');
  assert.ok(
    r.value.graph.allNodes().some((n) => JSON.stringify(n.properties).includes('exceeds 10000')),
    'the rule on the photo was extracted',
  );
});

test('tiers that cannot read images are never offered one; with nothing able to read it the image stays a binary source', async () => {
  // A text document rides along: a run whose only input yields no text is (rightly) refused as producing nothing.
  const companion = { kind: 'document', text: 'The handler must verify policy status.', sourcePath: 'note.txt' };
  const pdfOnly = stubTier({ acceptsImages: false, lines: ['never'] });
  const r = await compileSources([{ kind: 'image', bytes: PNG_1x1, sourcePath: 'IMG_2042.png' }, companion], { pageTiers: [pdfOnly] });
  assert.ok(r.ok, r.ok ? undefined : r.error.message);
  assert.equal(pdfOnly.calls, 0);
  assert.equal(r.value.sources[0]!.semanticExtractionAvailable, false);
  const unreadable = stubTier({ acceptsImages: true, lines: [] });
  const r2 = await compileSources([{ kind: 'image', bytes: PNG_1x1, sourcePath: 'blurry.png' }, companion], { pageTiers: [unreadable] });
  assert.ok(r2.ok, r2.ok ? undefined : r2.error.message);
  assert.equal(unreadable.calls, 1);
  assert.equal(r2.value.sources[0]!.semanticExtractionAvailable, false, 'no text is invented when nothing could be read');
});

test('JPEG dimensions are read from the frame header of a camera photo', () => {
  // SOI, APP1 (EXIF, 16 bytes), SOF0 with height 3024 and width 4032 (a 12 MP phone photo)
  const jpeg = new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe1,
    0x00,
    0x10,
    ...new Array(14).fill(0),
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    0x0b,
    0xd0,
    0x0f,
    0xc0,
    0x03,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ]);
  assert.deepEqual(extractDimensions(jpeg, 'image/jpeg'), { width: 4032, height: 3024 });
  assert.equal(
    extractDimensions(new Uint8Array([0xff, 0xd8, 0x00]), 'image/jpeg'),
    undefined,
    'a broken header yields nothing, not a guess',
  );
});

// Real engines (optionalDependencies): a page image rendered to PNG stands in for a photo of a document.
const engines = (await isPdfiumAvailable()) && (await isTesseractAvailable());
after(async () => {
  await shutdownTesseract();
  await shutdownPdfium();
});

test(
  'local OCR (tesseract) reads text off an image end to end',
  { skip: engines ? false : 'pdfium/tesseract not installed', timeout: 120_000 },
  async () => {
    const pdf = new Uint8Array(readFileSync(fileURLToPath(new URL('../fixtures/scanned-and-mixed.pdf', import.meta.url))));
    const page = await renderPageGray(pdf, 1, { dpi: 150 });
    assert.ok(page !== undefined);
    const img = cropToContent(page);
    const png = new Uint8Array(encodeGrayPng(img.width, img.height, img.data));
    const r = await compileSources([{ kind: 'image', bytes: png, sourcePath: 'photo-of-guide.png' }], {
      pageTiers: [createTesseractTier({ workers: 1 })],
    });
    assert.ok(r.ok, r.ok ? undefined : r.error.message);
    const src = r.value.sources[0]!;
    assert.equal(src.semanticExtractionAvailable, true);
    assert.equal(src.recovery?.entries[0]?.tier, 'tesseract-ocr');
    assert.ok(
      r.value.graph.allNodes().some((n) => /verify policy status/i.test(JSON.stringify(n.properties))),
      'the sentence on the image reached the compiled graph',
    );
  },
);
