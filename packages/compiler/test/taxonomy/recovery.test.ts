import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildCases } from './cases.js';
import { RECOVERY_TARGETS } from './targets.js';
import { measureCase, withRecovery } from './harness.js';
import {
  createPdfiumReaderTier,
  createTesseractTier,
  isPdfiumAvailable,
  isTesseractAvailable,
  shutdownPdfium,
  shutdownTesseract,
} from '../../src/extraction/index.js';

// Real engines. They are optionalDependencies: where a platform cannot install them these tests skip, and CI (which runs
// `npm ci` with network) is the environment that exercises them. SYNTHETIC scans: regression guards, not accuracy evidence.
const available = (await isPdfiumAvailable()) && (await isTesseractAvailable());
const tier = withRecovery('+pdfium+ocr', [createPdfiumReaderTier(), createTesseractTier({ workers: 2 })]);
after(async () => {
  await shutdownTesseract();
  await shutdownPdfium();
});

for (const c of buildCases().filter((x) => RECOVERY_TARGETS[x.id] !== undefined)) {
  test(`taxonomy[+pdfium+ocr]: ${c.id}`, { skip: available ? false : 'pdfium/tesseract not installed', timeout: 120_000 }, async () => {
    const t = RECOVERY_TARGETS[c.id]!;
    const r = await measureCase(c, tier, c.build());
    assert.equal(r.silentGarbage, false);
    const misses: string[] = [];
    if (t.minWordF1 !== undefined && (r.wordF1 ?? 0) < t.minWordF1) misses.push(`wordF1 ${r.wordF1} < ${t.minWordF1}`);
    if (t.minSequence !== undefined && (r.sequenceScore ?? 0) < t.minSequence)
      misses.push(`sequence ${r.sequenceScore} < ${t.minSequence}`);
    if (t.minPagesWithText !== undefined && r.pagesWithText + r.pagesRecoveredByTier < t.minPagesWithText)
      misses.push('too few pages recovered');
    if (t.allPagesFlagged === true && !(r.pagesRecoveredByTier === 0 && r.pagesFlaggedForRecovery === r.pages))
      misses.push(
        `recovered ${r.pagesRecoveredByTier}, flagged ${r.pagesFlaggedForRecovery}/${r.pages}: an unreadable page must stay unaccounted, never guessed`,
      );
    if (t.maxMs !== undefined && r.ms > t.maxMs) misses.push(`${Math.round(r.ms)} ms > ${t.maxMs}`);
    if (t.knownGap !== undefined) assert.ok(misses.length > 0, `KNOWN GAP FIXED: remove knownGap from ${c.id}`);
    else assert.deepEqual(misses, []);
  });
}

test(
  'ocr: a recovered scan is compiled with coverage complete and quality trusted (CRD-03)',
  { skip: available ? false : 'engines not installed', timeout: 60_000 },
  async () => {
    const c = buildCases().find((x) => x.id === 'scan-clean-3p')!;
    const r = await measureCase(c, tier, c.build());
    assert.equal(r.unaccountedPages, 0);
    assert.equal(r.qualityState, 'trusted');
    assert.equal(r.tokens, 0);
    assert.equal(r.usd, 0);
  },
);

test(
  'ocr: tier version changes with engine, language and resolution so stale cache entries cannot match',
  { skip: available ? false : 'engines not installed' },
  () => {
    assert.notEqual(createTesseractTier({ dpi: 150 }).version, createTesseractTier({ dpi: 200 }).version);
    assert.notEqual(createTesseractTier({ lang: 'deu' }).version, createTesseractTier().version);
  },
);
