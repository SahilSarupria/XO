import { computePdfCoverage } from '../../src/pdf/pdf-coverage.js';
import { NodePdfLoader, type LoadedPdfDocument } from '../../src/pdf/pdf-loader.js';
import { groupRunsIntoLines } from '../../src/document/line-grouper.js';
import { recoverUnreadPages } from '../../src/extraction/router.js';
import type { ExtractionBudget, ExtractionLedger, PageTier } from '../../src/extraction/types.js';
import { parseDocument } from '../../src/document/document-parser.js';
import { assessDocumentQuality } from '../../src/document/document-quality.js';
import type { PageTruth, TaxonomyCase } from './cases.js';

// ---------------------------------------------------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------------------------------------------------

export const words = (s: string): string[] =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];

/** Bag-of-words F1: order-insensitive, so it measures whether the right words were recovered at all. */
export function wordF1(truth: readonly string[], got: readonly string[]): number {
  if (truth.length === 0 && got.length === 0) return 1;
  const remaining = new Map<string, number>();
  for (const w of truth) remaining.set(w, (remaining.get(w) ?? 0) + 1);
  let tp = 0;
  for (const w of got) {
    const c = remaining.get(w) ?? 0;
    if (c > 0) {
      tp++;
      remaining.set(w, c - 1);
    }
  }
  const p = got.length === 0 ? 0 : tp / got.length;
  const r = truth.length === 0 ? 0 : tp / truth.length;
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

/** Longest-common-subsequence ratio over words: measures reading ORDER (a two-column page read row-by-row scores low). Skipped for very large inputs. */
export function sequenceScore(truth: readonly string[], got: readonly string[], cap = 3000): number | undefined {
  if (truth.length === 0) return undefined;
  if (truth.length > cap || got.length > cap) return undefined;
  const prev = new Array<number>(got.length + 1).fill(0);
  const cur = new Array<number>(got.length + 1).fill(0);
  for (let i = 1; i <= truth.length; i++) {
    for (let j = 1; j <= got.length; j++) cur[j] = truth[i - 1] === got[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    for (let j = 0; j <= got.length; j++) prev[j] = cur[j]!;
  }
  return prev[got.length]! / truth.length;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tiers under test
// ---------------------------------------------------------------------------------------------------------------------

export interface TierRunOutcome {
  readonly document?: LoadedPdfDocument;
  readonly error?: { readonly code: string; readonly message: string };
  readonly ledger?: ExtractionLedger;
}

export interface TaxonomyTier {
  readonly name: string;
  run(bytes: Uint8Array): Promise<TierRunOutcome>;
}

/** The free primary path: the repo's own text-layer reader and nothing else. */
export const textLayerTier: TaxonomyTier = {
  name: 'text-layer',
  async run(bytes) {
    const r = new NodePdfLoader().load(bytes, 'case.pdf');
    return r.ok ? { document: r.value } : { error: { code: String(r.error.code), message: r.error.message } };
  },
};

/** The text-layer reader followed by recovery tiers for pages it cannot read. */
export function withRecovery(name: string, tiers: readonly PageTier[], budget: ExtractionBudget = {}): TaxonomyTier {
  return {
    name,
    async run(bytes) {
      const r = new NodePdfLoader().load(bytes, 'case.pdf');
      if (!r.ok) return { error: { code: String(r.error.code), message: r.error.message } };
      const rec = await recoverUnreadPages(r.value, bytes, tiers, budget);
      return { document: rec.document, ledger: rec.ledger };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Per case, per tier measurement
// ---------------------------------------------------------------------------------------------------------------------

export interface CaseResult {
  readonly id: string;
  readonly category: string;
  readonly expectation: string;
  readonly tier: string;
  readonly fileBytes: number;
  readonly opened: boolean;
  readonly errorCode?: string;
  readonly pages: number;
  /** Pages whose text the reader returned (non-empty, no load failure). */
  readonly pagesWithText: number;
  /** Pages the reader flagged as needing recovery (no text layer). */
  readonly pagesFlaggedForRecovery: number;
  /** Pages that failed to load, by failure code. */
  readonly pageFailures: Readonly<Record<string, number>>;
  readonly pagesRecoveredByTier: number;
  /** Unaccounted pages in the coverage ledger (CRD-03): visible, never dropped. */
  readonly unaccountedPages: number;
  readonly qualityState?: string;
  /** Scored on the line-grouped text the pipeline actually consumes. */
  readonly wordF1?: number;
  readonly sequenceScore?: number;
  /** Text came back for a page with no real content match and nothing flagged it: the dangerous failure. */
  readonly silentGarbage: boolean;
  readonly forbiddenLeak: boolean;
  readonly ms: number;
  readonly tokens: number;
  readonly usd: number;
}

function layoutText(doc: LoadedPdfDocument): string[] {
  return doc.pages.map((p) =>
    p.loadFailure !== undefined || p.requiresOcr
      ? ''
      : groupRunsIntoLines(p.pageNumber, p.textRuns, p.resolveFontEncoding)
          .map((l) => l.text)
          .join('\n'),
  );
}

export async function measureCase(c: TaxonomyCase, tier: TaxonomyTier, bytes: Uint8Array): Promise<CaseResult> {
  const t0 = process.hrtime.bigint();
  const out = await tier.run(bytes);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const base = {
    id: c.id,
    category: c.category,
    expectation: c.expectation,
    tier: tier.name,
    fileBytes: bytes.length,
    ms,
    tokens: out.ledger?.totalTokens ?? 0,
    usd: out.ledger?.totalCostUsd ?? 0,
  };
  if (out.document === undefined) {
    return {
      ...base,
      opened: false,
      ...(out.error !== undefined ? { errorCode: out.error.code } : {}),
      pages: 0,
      pagesWithText: 0,
      pagesFlaggedForRecovery: 0,
      pageFailures: {},
      pagesRecoveredByTier: 0,
      unaccountedPages: 0,
      silentGarbage: false,
      forbiddenLeak: false,
    };
  }
  const doc = out.document;
  const failures: Record<string, number> = {};
  for (const p of doc.pages) if (p.loadFailure !== undefined) failures[p.loadFailure.code] = (failures[p.loadFailure.code] ?? 0) + 1;
  const coverage = computePdfCoverage(doc);
  let qualityState: string | undefined;
  try {
    qualityState = assessDocumentQuality(parseDocument(doc), 'case', coverage).state;
  } catch {
    qualityState = 'error';
  }
  const texts = layoutText(doc);
  let f1: number | undefined;
  let seq: number | undefined;
  let silentGarbage = false;
  if (c.truth !== undefined) {
    const truthPages: readonly PageTruth[] = c.truth;
    const n = Math.min(truthPages.length, texts.length);
    const t = truthPages.slice(0, n).flatMap((p) => words(p.lines.join(' ')));
    const g = texts.slice(0, n).flatMap((s) => words(s));
    f1 = wordF1(t, g);
    const seqs = truthPages.slice(0, n).map((p, i) => sequenceScore(words(p.lines.join(' ')), words(texts[i]!)));
    const defined = seqs.filter((x): x is number => x !== undefined);
    if (defined.length > 0) seq = defined.reduce((a, b) => a + b, 0) / defined.length;
    // Silent garbage: a page that has truth text, came back non-empty, matches poorly, and was NOT flagged for recovery.
    silentGarbage = truthPages.slice(0, n).some((p, i) => {
      const truthWords = words(p.lines.join(' '));
      const page = doc.pages[i]!;
      if (truthWords.length === 0 || page.requiresOcr || page.loadFailure !== undefined) return false;
      const got = words(texts[i]!);
      // Text came back (or non-empty raw text with no legible word in it) and it does not match: nothing told the caller.
      const hadRawText = page.plainText.trim().length > 0;
      return (got.length > 0 || hadRawText) && wordF1(truthWords, got) < 0.3;
    });
  }
  const allText = words(texts.join(' '));
  const forbiddenLeak = (c.forbiddenWords ?? []).some((w) => allText.includes(w.toLowerCase()));
  return {
    ...base,
    opened: true,
    pages: doc.pageCount,
    pagesWithText: doc.pages.filter((p) => p.loadFailure === undefined && p.plainText.trim().length > 0).length,
    pagesFlaggedForRecovery: doc.pages.filter((p) => p.requiresOcr && p.recovery === undefined).length,
    pageFailures: failures,
    pagesRecoveredByTier: doc.pages.filter((p) => p.recovery !== undefined).length,
    unaccountedPages: coverage.unaccountedPages,
    ...(qualityState !== undefined ? { qualityState } : {}),
    ...(f1 !== undefined ? { wordF1: Number(f1.toFixed(4)) } : {}),
    ...(seq !== undefined ? { sequenceScore: Number(seq.toFixed(4)) } : {}),
    silentGarbage,
    forbiddenLeak,
  };
}
