import { createHash } from 'node:crypto';
import type { TextRun } from '../pdf/content-stream.js';
import type { LoadedPdfDocument, LoadedPdfPage } from '../pdf/pdf-loader.js';
import { SpendCeiling } from './budget.js';
import { ABORTED_CODE, RESOURCE_LIMIT_CODE } from '../pdf/limits.js';
import {
  TIER_COST_ORDER,
  type ExtractionBudget,
  type ExtractionLedger,
  type LedgerEntry,
  type PageRecovery,
  type PageTier,
  type RecoveryCache,
  type RecoveryOutcome,
  type TierCostClass,
  type TierCostSummary,
} from './types.js';

/** A page the text-layer reader could not read and that is worth recovering: not blank, and it did load. */
export function needsRecovery(page: LoadedPdfPage): boolean {
  if (page.loadFailure !== undefined) {
    // A page our reader could not load (unsupported filter, damaged stream) may still be readable by another engine.
    // Pages stopped by a resource limit or an abort are NOT offered: they are hostile or cancelled, not merely unsupported.
    return page.loadFailure.code !== RESOURCE_LIMIT_CODE && page.loadFailure.code !== ABORTED_CODE;
  }
  return page.requiresOcr && !page.isBlank;
}

/** What a recovery tier's `handles` should say for the standard case: pages with no text layer and pages our reader failed on. */
export const needsEngineHelp = (page: LoadedPdfPage): boolean => page.requiresOcr || page.loadFailure !== undefined;

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

function recoveredPage(page: LoadedPdfPage, tier: string, costClass: TierCostClass, recovery: PageRecovery): LoadedPdfPage {
  const lines = [...recovery.lines].filter((l) => l.text.trim().length > 0);
  const textRuns: TextRun[] = lines.map((l) => ({
    bytes: new Uint8Array(0),
    fontName: undefined,
    fontSizePt: l.fontSizePt ?? 11,
    x: l.x,
    y: l.y,
    text: l.text,
  }));
  const { loadFailure: _recoveredFrom, ...rest } = page;
  void _recoveredFrom;
  return {
    ...rest,
    plainText: lines.map((l) => l.text).join('\n'),
    textRuns,
    requiresOcr: false,
    isBlank: false,
    recovery: { tier, confidence: recovery.confidence, costClass },
  };
}

/** Runs `work` with a timeout that ABORTS the signal the work receives, so a hung tier can stop consuming resources. */
async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  outer?: AbortSignal,
): Promise<T | 'timeout' | 'cancelled'> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const onOuter = (): void => controller.abort();
  outer?.addEventListener('abort', onOuter, { once: true });
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, ms);
  });
  const cancelled = new Promise<'cancelled'>((resolve) => {
    if (outer?.aborted === true) resolve('cancelled');
    else outer?.addEventListener('abort', () => resolve('cancelled'), { once: true });
  });
  try {
    const running = work(controller.signal);
    running.catch(() => undefined); // an abandoned (timed-out) call must not become an unhandled rejection
    return await Promise.race([running, timeout, cancelled]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    outer?.removeEventListener('abort', onOuter);
  }
}

/**
 * Calls in flight, keyed by (document, page, tier, version). A second request for the same key while the first is
 * running awaits it instead of calling the tier again: a page is never sent twice, even by concurrent runs.
 */
const inflight = new Map<string, Promise<PageRecovery | undefined>>();

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
  const docCeiling = new SpendCeiling(budget.maxCostUsd ?? 0);
  const runCeiling = budget.runBudget;
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
      if (budget.signal?.aborted === true) {
        record({ tierObj: tier, page: page.pageNumber, tier: tier.name, outcome: 'cancelled', ms: 0, tokens: 0, costUsd: 0 });
        return;
      }
      const cached = await cache.get(key);
      if (cached !== undefined) {
        // A previous attempt already answered for this exact (document, page, tier, version): reuse it, trusted or not.
        // A rejected answer is not retried either, so a failing page is never paid for twice.
        const trusted = cached.confidence >= minConfidence && cached.lines.some((l) => l.text.trim().length > 0);
        record({
          tierObj: tier,
          page: page.pageNumber,
          tier: tier.name,
          outcome: trusted ? 'cache_hit' : 'low_confidence',
          ms: Date.now() - t0,
          tokens: 0,
          costUsd: 0,
        });
        if (trusted) {
          results.set(page.pageNumber, recoveredPage(page, tier.name, tier.costClass, cached));
          return;
        }
        continue;
      }
      const shared = inflight.get(key);
      if (shared !== undefined) {
        const got = await shared.catch(() => undefined);
        const trusted = got !== undefined && got.confidence >= minConfidence && got.lines.some((l) => l.text.trim().length > 0);
        record({
          tierObj: tier,
          page: page.pageNumber,
          tier: tier.name,
          outcome: trusted ? 'deduplicated' : 'low_confidence',
          ms: Date.now() - t0,
          tokens: 0,
          costUsd: 0,
        });
        if (trusted) {
          results.set(page.pageNumber, recoveredPage(page, tier.name, tier.costClass, got));
          return;
        }
        continue;
      }
      let reserved = 0;
      if (tier.costClass === 'model') {
        reserved = tier.estimateCostUsd?.(page) ?? Number.POSITIVE_INFINITY;
        // Both reservations are atomic check-and-add (no await between check and update). The run ceiling is checked
        // second and rolled back if the document ceiling then refuses, so neither can be overrun by concurrent pages.
        const docOk = docCeiling.tryReserve(reserved);
        const runOk = docOk && (runCeiling === undefined || runCeiling.tryReserve(reserved));
        if (docOk && !runOk) docCeiling.settle(reserved, 0);
        if (!docOk || !runOk) {
          record({ tierObj: tier, page: page.pageNumber, tier: tier.name, outcome: 'skipped_budget', ms: 0, tokens: 0, costUsd: 0 });
          continue;
        }
      }
      let outcome: RecoveryOutcome = 'tier_failed';
      let recovery: PageRecovery | undefined;
      try {
        let publish: (r: PageRecovery | undefined) => void = () => undefined;
        const pending = new Promise<PageRecovery | undefined>((resolve) => {
          publish = resolve;
        });
        inflight.set(key, pending);
        let done: PageRecovery | undefined | 'timeout' | 'cancelled' = undefined;
        try {
          done = await withTimeout((signal) => tier.recover({ page, document, bytes, signal }), timeoutMs, budget.signal);
        } finally {
          inflight.delete(key);
          publish(done !== undefined && done !== 'timeout' && done !== 'cancelled' ? done : undefined);
        }
        if (done === 'timeout') outcome = 'timed_out';
        else if (done === 'cancelled') outcome = 'cancelled';
        else if (done === undefined) outcome = 'no_text';
        else {
          recovery = done;
          // Settle what waiters see: they get the recovery whether or not it clears the gate (each applies its own gate).
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
      if (tier.costClass === 'model') {
        // A model call that failed or timed out may still have been billed, so it keeps its full reservation.
        const spent = Math.min(actual, reserved);
        docCeiling.settle(reserved, spent);
        runCeiling?.settle(reserved, spent);
      }
      record({
        tierObj: tier,
        page: page.pageNumber,
        tier: tier.name,
        outcome,
        ms: Date.now() - t0,
        tokens: recovery?.tokensUsed ?? 0,
        costUsd: tier.costClass === 'model' ? Math.min(actual, reserved) : (recovery?.costUsd ?? 0),
      });
      // Remember every answer a tier actually gave, trusted or not, so the same page is never asked of the same tier twice.
      if (recovery !== undefined) await cache.set(key, recovery);
      if (outcome === 'recovered' && recovery !== undefined) {
        results.set(page.pageNumber, recoveredPage(page, tier.name, tier.costClass, recovery));
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
    byTier: summarizeByTier(entries),
    pagesNeedingRecovery: targets.length,
    pagesRecovered: results.size,
    totalMs: entries.reduce((s, e) => s + e.ms, 0),
    totalTokens: entries.reduce((s, e) => s + e.tokens, 0),
    totalCostUsd: Number(entries.reduce((s, e) => s + e.costUsd, 0).toFixed(6)),
  };
  return { document: { ...document, pages }, ledger };
}

export function summarizeByTier(entries: readonly LedgerEntry[]): TierCostSummary[] {
  const map = new Map<string, { s: TierCostSummary }>();
  for (const e of entries) {
    const cur = map.get(e.tier)?.s ?? { tier: e.tier, costClass: e.costClass, attempts: 0, recovered: 0, ms: 0, tokens: 0, costUsd: 0 };
    map.set(e.tier, {
      s: {
        ...cur,
        attempts:
          cur.attempts +
          (e.outcome === 'cache_hit' || e.outcome === 'deduplicated' || e.outcome === 'skipped_budget' || e.outcome === 'cancelled'
            ? 0
            : 1),
        recovered: cur.recovered + (e.outcome === 'recovered' || e.outcome === 'cache_hit' || e.outcome === 'deduplicated' ? 1 : 0),
        ms: cur.ms + e.ms,
        tokens: cur.tokens + e.tokens,
        costUsd: Number((cur.costUsd + e.costUsd).toFixed(6)),
      },
    });
  }
  return [...map.values()].map((v) => v.s);
}

/** Per-run cost report across documents: the sum of each document's ledger, with per-tier roll-up. */
export function summarizeRun(ledgers: readonly ExtractionLedger[]): {
  readonly documents: number;
  readonly pagesNeedingRecovery: number;
  readonly pagesRecovered: number;
  readonly totalMs: number;
  readonly totalTokens: number;
  readonly totalCostUsd: number;
  readonly byTier: readonly TierCostSummary[];
} {
  const entries = ledgers.flatMap((l) => l.entries);
  return {
    documents: ledgers.length,
    pagesNeedingRecovery: ledgers.reduce((n, l) => n + l.pagesNeedingRecovery, 0),
    pagesRecovered: ledgers.reduce((n, l) => n + l.pagesRecovered, 0),
    totalMs: ledgers.reduce((n, l) => n + l.totalMs, 0),
    totalTokens: ledgers.reduce((n, l) => n + l.totalTokens, 0),
    totalCostUsd: Number(ledgers.reduce((n, l) => n + l.totalCostUsd, 0).toFixed(6)),
    byTier: summarizeByTier(entries),
  };
}
