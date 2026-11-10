import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NodePdfLoader } from '../../src/pdf/pdf-loader.js';
import { computePdfCoverage } from '../../src/pdf/pdf-coverage.js';
import { summarizeCoverage } from '../../src/document/page-coverage.js';
import { buildTestPdf } from './fixtures/build-test-pdf.js';

const loader = new NodePdfLoader();
const TEXT = '/F1 12 Tf 72 700 Td (Claims must be reported within 30 days of the loss.) Tj';

function coverageOf(spec: Parameters<typeof buildTestPdf>[0]) {
  const loaded = loader.load(buildTestPdf(spec), 'cov.pdf');
  assert.ok(loaded.ok, loaded.ok ? undefined : loaded.error.message);
  if (!loaded.ok) throw new Error('unreachable');
  return { loaded: loaded.value, report: computePdfCoverage(loaded.value) };
}

test('an all-text PDF is fully extracted and complete', () => {
  const { report } = coverageOf({ pages: [{ contentOps: TEXT }, { contentOps: TEXT }] });
  assert.equal(report.totalPages, 2);
  assert.equal(report.extractedPages, 2);
  assert.equal(report.unaccountedPages, 0);
  assert.equal(report.complete, true);
});

test('an image-only (scanned) page is unaccounted: requires_ocr_unavailable, never silently dropped', () => {
  const { report } = coverageOf({
    pages: [{ contentOps: TEXT }, { contentOps: '', rawContent: 'q 612 0 0 792 0 0 cm /Im1 Do Q', image: true }],
  });
  assert.equal(report.extractedPages, 1);
  assert.equal(report.unaccountedPages, 1);
  assert.equal(report.complete, false);
  const scanned = report.entries.find((e) => e.page === 2)!;
  assert.equal(scanned.status, 'unaccounted');
  assert.equal(scanned.reason, 'requires_ocr_unavailable');
});

test('a genuinely blank page (no content, no image) is excluded with a recorded reason and does not make the document partial', () => {
  const { report } = coverageOf({ pages: [{ contentOps: TEXT }, { contentOps: '', rawContent: '' }] });
  const blank = report.entries.find((e) => e.page === 2)!;
  assert.equal(blank.status, 'excluded');
  assert.equal(blank.reason, 'blank_page');
  assert.equal(report.complete, true);
  assert.equal(report.excludedPages, 1);
});

test('a page that draws content but yields no text stays unaccounted (could be outlined text), not blank', () => {
  const { report } = coverageOf({ pages: [{ contentOps: TEXT }, { contentOps: '', rawContent: '1 0 0 RG 0 0 100 100 re S' }] });
  const drawn = report.entries.find((e) => e.page === 2)!;
  assert.equal(drawn.status, 'unaccounted');
  assert.equal(drawn.reason, 'no_extractable_text');
});

test('WS1-02: a page with an unsupported stream filter fails alone; the rest of the document still loads', () => {
  const { loaded, report } = coverageOf({
    pages: [{ contentOps: TEXT }, { contentOps: '', rawContent: 'BT (hidden) Tj ET', contentFilter: 'LZWDecode' }, { contentOps: TEXT }],
  });
  assert.equal(loaded.pageCount, 3);
  assert.match(loaded.pages[0]!.plainText, /Claims must be reported/);
  assert.match(loaded.pages[2]!.plainText, /Claims must be reported/);
  assert.ok(loaded.pages[1]!.loadFailure, 'page 2 records its own failure');
  assert.match(loaded.pages[1]!.loadFailure!.message, /Unsupported stream filter/);
  const failed = report.entries.find((e) => e.page === 2)!;
  assert.equal(failed.status, 'unaccounted');
  assert.equal(failed.reason, 'page_load_failed');
  assert.equal(report.extractedPages, 2);
  assert.equal(report.complete, false);
});

test('summarizeCoverage rejects an exclusion without an excludable reason and a duplicated page', () => {
  assert.throws(() => summarizeCoverage([{ page: 1, status: 'excluded' }]), /excluded without a valid exclusion reason/);
  assert.throws(() => summarizeCoverage([{ page: 1, status: 'excluded', reason: 'requires_ocr_unavailable' }]), /valid exclusion reason/);
  assert.throws(
    () =>
      summarizeCoverage([
        { page: 1, status: 'extracted' },
        { page: 1, status: 'extracted' },
      ]),
    /more than once/,
  );
});

test('coverage is deterministic: same bytes, same ledger', () => {
  const spec = { pages: [{ contentOps: TEXT }, { contentOps: '', rawContent: 'q /Im1 Do Q', image: true }] };
  assert.deepEqual(coverageOf(spec).report, coverageOf(spec).report);
});
