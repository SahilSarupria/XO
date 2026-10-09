import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessDocumentQuality } from '../../src/document/document-quality.js';
import type { ParsedDocument, ParagraphBlock } from '../../src/document/types.js';

function paragraph(text: string, page = 1): ParagraphBlock {
  return { kind: 'paragraph', text, provenance: { page, yRange: [0, 10] } };
}

function doc(blocks: ParagraphBlock[]): ParsedDocument {
  return { root: { heading: undefined, blocks, subsections: [] }, bodyFontSizePt: 10 };
}

test('a document with no suspicious tokens is trusted, with no findings', () => {
  const report = assessDocumentQuality(doc([paragraph('Contact the claims department within 30 days of any loss event.')]), 'clean.txt');
  assert.equal(report.state, 'trusted');
  assert.equal(report.suspiciousTokens, 0);
  assert.deepEqual(report.diagnostics, []);
});

test('a document with a small fraction of suspicious tokens is degraded, not blocked, and still reports diagnostics', () => {
  // One planted artifact among ~40 ordinary words puts the ratio just above the 2% degraded threshold but nowhere near the 15% blocked threshold.
  const filler = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
  const report = assessDocumentQuality(doc([paragraph(`${filler} and8827461093 ${filler}`)]), 'mostly-clean.txt');
  assert.equal(report.state, 'degraded');
  assert.ok(report.diagnostics.some((d) => d.code === 'source-quality/digit_letter_mash'));
  assert.ok(report.diagnostics.some((d) => d.code === 'source-quality/degraded'));
});

test('a document where most tokens are corrupted is blocked, and the blocked diagnostic is an error, not a warning', () => {
  const report = assessDocumentQuality(doc([paragraph('and8827461093 PlanOpted NameOpted xyz9999999 abc8888888 ContactNoEmail')]), 'corrupted.pdf');
  assert.equal(report.state, 'blocked');
  const summary = report.diagnostics.find((d) => d.code === 'source-quality/blocked');
  assert.ok(summary);
  assert.equal(summary!.severity, 'error');
});

test('every diagnostic identifies the source id, so a caller can trace a finding back to which source produced it', () => {
  const report = assessDocumentQuality(doc([paragraph('and8827461093 is a planted artifact')]), 'my-source-id.pdf');
  assert.ok(report.diagnostics.length > 0);
  for (const d of report.diagnostics) {
    assert.ok(d.message.includes('my-source-id.pdf'), `diagnostic message should mention the source id: ${d.message}`);
    assert.equal(d.passName, 'source-quality');
  }
});

test('table_row blocks are scanned via their cells, not skipped (a table is a common carrier of concatenation artifacts)', () => {
  const tableDoc: ParsedDocument = {
    root: { heading: undefined, blocks: [{ kind: 'table_row', cells: ['and8827461093', 'ordinary cell'], provenance: { page: 2, yRange: [0, 10] } }], subsections: [] },
    bodyFontSizePt: 10,
  };
  const report = assessDocumentQuality(tableDoc, 'table.pdf');
  assert.equal(report.suspiciousTokens, 1);
  assert.ok(report.diagnostics.some((d) => d.message.includes('page 2')));
});

test('blocks nested under subsections are included, not just the root section\u2019s own blocks', () => {
  const nested: ParsedDocument = {
    root: {
      heading: undefined,
      blocks: [],
      subsections: [{ heading: { kind: 'heading', level: 1, text: 'Section', provenance: { page: 1, yRange: [0, 10] } }, blocks: [paragraph('and8827461093')], subsections: [] }],
    },
    bodyFontSizePt: 10,
  };
  const report = assessDocumentQuality(nested, 'nested.pdf');
  assert.equal(report.suspiciousTokens, 1);
});

test('is deterministic: assessing the same document twice produces an identical report', () => {
  const d = doc([paragraph('and8827461093 PlanOpted ordinary text here')]);
  const first = assessDocumentQuality(d, 'src');
  const second = assessDocumentQuality(d, 'src');
  assert.deepEqual(first, second);
});

test('an empty document is vacuously trusted (nothing to distrust)', () => {
  const report = assessDocumentQuality(doc([]), 'empty.txt');
  assert.equal(report.state, 'trusted');
  assert.equal(report.totalTokens, 0);
  assert.equal(report.suspiciousTokenRatio, 0);
});
