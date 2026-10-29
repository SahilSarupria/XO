import { createHash } from 'node:crypto';
import type { TextRun } from '../pdf/content-stream.js';
import type { LoadedPdfDocument, LoadedPdfPage } from '../pdf/pdf-loader.js';
import {
  TIER_COST_ORDER,
  type ExtractionBudget,
  type ExtractionLedger,
  type LedgerEntry,
  type PageRecovery,
  type PageTier,
  type RecoveryCache,
  type RecoveryOutcome,
} from './types.js';

/** A page the text-layer reader could not read and that is worth recovering: not blank, and it did load. */
export function needsRecovery(page: LoadedPdfPage): boolean {
  return page.requiresOcr && !page.isBlank && page.loadFailure === undefined;
}

export class InMemoryRecoveryCache implements RecoveryCache {
  private readonly store = new Map<string, PageRecovery>();
  get(key: string): PageRecovery | undefined {
    return this.store.get(key);
  }
  set(key: string, value: PageRecovery): void {
    this.store.set(key, value);
  }
}

const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 60_000;

function cacheKey(documentHash: string, page: LoadedPdfPage, tier: PageTier): string {
  return createHash('sha256').update(`${documentHash}\u0000${page.pageNumber}\u0000${tier.name}\u0000${tier.version}`).digest('hex');
}

function recoveredPage(page: LoadedPdfPage, tier: string, recovery: PageRecovery): LoadedPdfPage {
  const lines = [...recovery.lines].filter((l) => l.text.trim().length > 0);
  const textRuns: TextRun[] = lines.map((l) => ({
    bytes: new Uint8Array(0),
    fontName: undefined,
    fontSizePt: l.fontSizePt ?? 11,
    x: l.x,
    y: l.y,
    text: l.text,
  }));
  return {
    ...page,
    plainText: lines.map((l) => l.text).join('\n'),
    textRuns,
    requiresOcr: false,
    isBlank: false,
    recovery: { tier, confidence: recovery.confidence },
  };
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Offers each unreadable page to the tiers in cost order (free, then local, then model) and returns the document with
 * recovered pages swapped in, plus a ledger of exactly what was tried and spent. Properties that hold regardless of tier:
 *
 *  - only pages the text reader could not read are touched; a readable page costs nothing;
 *  - a model tier's worst-case cost is reserved BEFORE the call, so the document ceiling is never overrun, and with the
 *    default budget (no spend allowed) a model tier is never called;
 *  - a tier that throws, times out, returns nothing or returns low confidence is skipped, and the next tier is tried;
 *  - results are cached by (document hash, page, tier, tier version), so re-runs and retries cost nothing;
 *  - a page no tier could read stays unaccounted: it is reported, never guessed.
 */
export async function recoverUnreadPages(
  document: LoadedPdfDocument,
  bytes: Uint8Array,
  tiers: readonly PageTier[],
  budget: ExtractionBudget = {},
  cache: RecoveryCache = new InMemoryRecoveryCache(),
): Promise<{ readonly document: LoadedPdfDocument; readonly ledger: ExtractionLedger }> {
  const minConfidence = budget.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const timeoutMs = budget.tierTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = Math.max(1, budget.concurrency ?? DEFAULT_CONCURRENCY);
  let reservedUsd = 0;
  const ceiling = budget.maxCostUsd ?? 0;
  const ordered = [...tiers].sort((a, b) => TIER_COST_ORDER.indexOf(a.costClass) - TIER_COST_ORDER.indexOf(b.costClass));
  const documentHash = createHash('sha256').update(bytes).digest('hex');
  const entries: LedgerEntry[] = [];
  const record = (e: Omit<LedgerEntry, 'costClass'> & { tierObj: PageTier }): void => {
    const { tierObj, ...rest } = e;
    entries.push({ ...rest, costClass: tierObj.costClass });
  };

  const targets = document.pages.filter(needsRecovery);
  const results = new Map<number, LoadedPdfPage>();

  const recoverOne = async (page: LoadedPdfPage): Promise<void> => {
    for (const tier of ordered) {
      if (!tier.handles(page)) continue;
      const key = cacheKey(documentHash, page, tier);
      const t0 = Date.now();
      const cached = await cache.get(key);
      if (cached !== undefined && cached.confidence >= minConfidence) {
        record({ tierObj: tier, page: page.pageNumber, tier: tier.name, outcome: 'cache_hit', ms: Date.now() - t0, tokens: 0, costUsd: 0 });
        results.set(page.pageNumber, recoveredPage(page, tier.name, cached));
        return;
      }
      let reserved = 0;
      if (tier.costClass === 'model') {
        reserved = tier.estimateCostUsd?.(page) ?? Number.POSITIVE_INFINITY;
        // Single-threaded JS: this check-and-add is atomic, so concurrent pages cannot jointly overrun the ceiling.
        if (reservedUsd + reserved > ceiling) {
          record({ tierObj: tier, page: page.pageNumber, tier: tier.name, outcome: 'skipped_budget', ms: 0, tokens: 0, costUsd: 0 });
          continue;
        }
        reservedUsd += reserved;
      }
      let outcome: RecoveryOutcome = 'tier_failed';
      let recovery: PageRecovery | undefined;
      try {
        const done = await withTimeout(tier.recover({ page, document, bytes }), timeoutMs);
        if (done === 'timeout') outcome = 'timed_out';
        else if (done === undefined) outcome = 'no_text';
        else {
          recovery = done;
          outcome = done.lines.every((l) => l.text.trim().length === 0)
            ? 'no_text'
            : done.confidence < minConfidence
              ? 'low_confidence'
              : 'recovered';
        }
      } catch {
        outcome = 'tier_failed';
      }
      const actual = recovery?.costUsd ?? reserved;
      if (tier.costClass === 'model') reservedUsd += actual - reserved; // settle the reservation to what was really spent
      record({
        tierObj: tier,
        page: page.pageNumber,
        tier: tier.name,
        outcome,
        ms: Date.now() - t0,
        tokens: recovery?.tokensUsed ?? 0,
        costUsd: tier.costClass === 'model' ? actual : (recovery?.costUsd ?? 0),
      });
      if (outcome === 'recovered' && recovery !== undefined) {
        await cache.set(key, recovery);
        results.set(page.pageNumber, recoveredPage(page, tier.name, recovery));
        return;
      }
    }
  };

  // Bounded worker pool: pages are independent, so wall-clock time is the slowest page, not the sum.
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    while (next < targets.length) {
      const page = targets[next++]!;
      await recoverOne(page);
    }
  });
  await Promise.all(workers);

  const pages = document.pages.map((p) => results.get(p.pageNumber) ?? p);
  entries.sort((a, b) => a.page - b.page || 0);
  const ledger: ExtractionLedger = {
    entries,
    pagesNeedingRecovery: targets.length,
    pagesRecovered: results.size,
    totalMs: entries.reduce((s, e) => s + e.ms, 0),
    totalTokens: entries.reduce((s, e) => s + e.tokens, 0),
    totalCostUsd: Number(entries.reduce((s, e) => s + e.costUsd, 0).toFixed(6)),
  };
  return { document: { ...document, pages }, ledger };
}
