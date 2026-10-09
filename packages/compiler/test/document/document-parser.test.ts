import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NodePdfLoader } from '../../src/pdf/pdf-loader.js';
import { parseDocument } from '../../src/document/document-parser.js';
import { buildTestPdf } from '../pdf/fixtures/build-test-pdf.js';

const loader = new NodePdfLoader();

test('parses a heading followed by body paragraphs into a nested section', () => {
  const pdf = buildTestPdf({
    pages: [
      {
        contentOps:
          '/F1 24 Tf 72 700 Td (Mutual Non-Disclosure Agreement) Tj ' +
          '/F1 12 Tf 0 -40 Td (This Agreement is entered into by the parties below.) Tj ' +
          '0 -14 Td (It governs the exchange of confidential information.) Tj',
      },
    ],
  });
  const loaded = loader.load(pdf, 'nda.pdf');
  assert.ok(loaded.ok);
  if (!loaded.ok) return;

  const parsed = parseDocument(loaded.value);
  assert.equal(parsed.bodyFontSizePt, 12);
  assert.equal(parsed.root.subsections.length, 1);
  const section = parsed.root.subsections[0]!;
  assert.equal(section.heading?.text, 'Mutual Non-Disclosure Agreement');
  assert.equal(section.heading?.level, 1);
  assert.equal(section.blocks.length, 1);
  assert.equal(section.blocks[0]!.kind, 'paragraph');
  if (section.blocks[0]!.kind === 'paragraph') {
    assert.match(section.blocks[0].text, /This Agreement is entered into/);
    assert.match(section.blocks[0].text, /exchange of confidential information/);
  }
});

test('parses multi-level headings into nested sections', () => {
  const pdf = buildTestPdf({
    pages: [
      {
        contentOps:
          '/F1 20 Tf 72 750 Td (Article 1: Definitions) Tj ' +
          '/F1 16 Tf 0 -50 Td (1.1 Confidential Information) Tj ' +
          '/F1 12 Tf 0 -40 Td (Means any information disclosed under this agreement.) Tj',
      },
    ],
  });
  const loaded = loader.load(pdf, 'nested.pdf');
  assert.ok(loaded.ok);
  if (!loaded.ok) return;

  const parsed = parseDocument(loaded.value);
  const article = parsed.root.subsections[0]!;
  assert.equal(article.heading?.text, 'Article 1: Definitions');
  assert.equal(article.subsections.length, 1);
  assert.equal(article.subsections[0]!.heading?.text, '1.1 Confidential Information');
  assert.equal(article.subsections[0]!.blocks.length, 1);
});

test('parses list items under a heading', () => {
  const pdf = buildTestPdf({
    pages: [
      {
        contentOps:
          '/F1 18 Tf 72 750 Td (Obligations) Tj ' +
          '/F1 12 Tf 0 -50 Td (1. Maintain confidentiality) Tj ' +
          '0 -20 Td (2. Return all materials upon request) Tj',
      },
    ],
  });
  const loaded = loader.load(pdf, 'list.pdf');
  assert.ok(loaded.ok);
  if (!loaded.ok) return;

  const parsed = parseDocument(loaded.value);
  const section = parsed.root.subsections[0]!;
  assert.equal(section.blocks.length, 2);
  assert.equal(section.blocks[0]!.kind, 'list_item');
  assert.equal(section.blocks[1]!.kind, 'list_item');
  if (section.blocks[0]!.kind === 'list_item') assert.equal(section.blocks[0].marker, '1.');
});

test('a page with no extractable text (requiresOcr) contributes no blocks', () => {
  const pdf = buildTestPdf({ pages: [{ contentOps: 'q 1 0 0 RG 0 0 100 100 re S Q' }] });
  const loaded = loader.load(pdf, 'scanned.pdf');
  assert.ok(loaded.ok);
  if (!loaded.ok) return;
  assert.equal(loaded.value.pages[0]!.requiresOcr, true);

  const parsed = parseDocument(loaded.value);
  assert.equal(parsed.root.blocks.length, 0);
  assert.equal(parsed.root.subsections.length, 0);
});

test('parsing the same document twice produces identical structure (determinism)', () => {
  const pdf = buildTestPdf({
    pages: [{ contentOps: '/F1 18 Tf 72 750 Td (Title) Tj /F1 12 Tf 0 -50 Td (Body text here.) Tj' }],
  });
  const loaded1 = loader.load(pdf, 'det.pdf');
  const loaded2 = loader.load(pdf, 'det.pdf');
  assert.ok(loaded1.ok && loaded2.ok);
  if (!loaded1.ok || !loaded2.ok) return;
  assert.deepEqual(parseDocument(loaded1.value), parseDocument(loaded2.value));
});
