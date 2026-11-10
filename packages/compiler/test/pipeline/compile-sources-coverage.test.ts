import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSources } from '../../src/pipeline/compile-sources.js';
import { buildTestPdf } from '../pdf/fixtures/build-test-pdf.js';

const RULE =
  '/F1 12 Tf 72 700 Td (Claims must be reported within 30 days of the loss event.) Tj 0 -14 Td (The insurer shall acknowledge each claim within 5 business days.) Tj';
const SCAN = { contentOps: '', rawContent: 'q 612 0 0 792 0 0 cm /Im1 Do Q', image: true } as const;

function pdf(spec: Parameters<typeof buildTestPdf>[0], sourcePath: string) {
  return { kind: 'pdf' as const, bytes: buildTestPdf(spec), sourcePath };
}

test('A1-01 regression: a fully scanned PDF is blocked, not vacuously trusted', async () => {
  const result = await compileSources([pdf({ pages: [SCAN, SCAN, SCAN] }, 'scan.pdf')]);
  assert.equal(result.ok, false, 'nothing readable means nothing to compile');
  if (result.ok) return;
  const sources = (
    result.error.context as { sources?: readonly { qualityState?: string; unitCount: number; coverage?: { unaccountedPages: number } }[] }
  ).sources!;
  assert.equal(sources[0]!.qualityState, 'blocked');
  assert.equal(sources[0]!.unitCount, 0);
  assert.equal(sources[0]!.coverage!.unaccountedPages, 3);
});

test('a mixed PDF is partial: readable pages compile, unread pages are listed, and the state reaches the manifest', async () => {
  const result = await compileSources([pdf({ pages: [{ contentOps: RULE }, SCAN, { contentOps: RULE }] }, 'mixed.pdf')]);
  assert.ok(result.ok, result.ok ? undefined : JSON.stringify(result.error));
  if (!result.ok) return;
  const report = result.value.sources[0]!;
  assert.equal(report.qualityState, 'partial');
  assert.ok(report.unitCount > 0, 'the readable pages still compile');
  assert.equal(report.coverage!.extractedPages, 2);
  assert.equal(report.coverage!.unaccountedPages, 1);
  assert.deepEqual(
    report.coverage!.entries.filter((e) => e.status === 'unaccounted').map((e) => [e.page, e.reason]),
    [[2, 'requires_ocr_unavailable']],
  );

  const perPage = result.value.diagnostics.filter((d) => d.code === 'source-coverage/requires_ocr_unavailable');
  assert.equal(perPage.length, 1);
  assert.match(perPage[0]!.message, /page 2/);
  assert.ok(result.value.diagnostics.some((d) => d.code === 'source-quality/partial' && d.severity === 'warning'));

  const quality = result.value.graph.manifest!.sourceQuality![report.sourceId]!;
  assert.equal(quality.state, 'partial');
  assert.deepEqual(quality.coverage, { totalPages: 3, extractedPages: 2, ocrPages: 0, excludedPages: 0, unaccountedPages: 1 });
});

test('a complete PDF with a blank separator page stays trusted and records the exclusion', async () => {
  const result = await compileSources([pdf({ pages: [{ contentOps: RULE }, { contentOps: '', rawContent: '' }] }, 'blank.pdf')]);
  assert.ok(result.ok, result.ok ? undefined : JSON.stringify(result.error));
  if (!result.ok) return;
  const report = result.value.sources[0]!;
  assert.equal(report.qualityState, 'trusted');
  assert.equal(report.coverage!.excludedPages, 1);
  assert.ok(!result.value.diagnostics.some((d) => d.passName === 'source-coverage'));
});

test('WS1-02 end to end: one page with an unsupported filter makes the document partial instead of rejecting it', async () => {
  const bad = { contentOps: '', rawContent: 'BT (x) Tj ET', contentFilter: 'LZWDecode' } as const;
  const result = await compileSources([pdf({ pages: [{ contentOps: RULE }, bad] }, 'oddpage.pdf')]);
  assert.ok(result.ok, result.ok ? undefined : JSON.stringify(result.error));
  if (!result.ok) return;
  const report = result.value.sources[0]!;
  assert.equal(report.qualityState, 'partial');
  assert.ok(result.value.diagnostics.some((d) => d.code === 'source-coverage/page_load_failed' && /page 2/.test(d.message)));
});

test('non-paginated sources are unaffected: no coverage, same trusted outcome as before', async () => {
  const result = await compileSources([
    { kind: 'document', text: '# Claims\nContact the claims department within 30 days of any loss event.', sourcePath: 'a.txt' },
  ]);
  assert.ok(result.ok, result.ok ? undefined : JSON.stringify(result.error));
  if (!result.ok) return;
  assert.equal(result.value.sources[0]!.qualityState, 'trusted');
  assert.equal(result.value.sources[0]!.coverage, undefined);
});

test('unread pages never alter what the readable pages compile to: same node kinds and properties as the complete-PDF compile', async () => {
  const opts = { now: () => '2026-01-01T00:00:00.000Z', graphId: 'g' };
  const complete = await compileSources([pdf({ pages: [{ contentOps: RULE }] }, 'same.pdf')], opts);
  const partial = await compileSources([pdf({ pages: [{ contentOps: RULE }, SCAN] }, 'same.pdf')], opts);
  assert.ok(complete.ok && partial.ok);
  if (!complete.ok || !partial.ok) return;
  assert.equal(complete.value.sources[0]!.qualityState, 'trusted');
  assert.equal(partial.value.sources[0]!.qualityState, 'partial');
  // Node ids and hashes embed the source id (which hashes the bytes), so compare what the nodes SAY.
  const content = (r: typeof complete): string[] =>
    r.ok
      ? r.value.graph
          .allNodes()
          .map((n) => `${n.kind}:${JSON.stringify(n.properties)}`)
          .sort()
      : [];
  assert.ok(content(complete).length > 0, 'the comparison must not be vacuous');
  assert.deepEqual(content(partial), content(complete));
});
