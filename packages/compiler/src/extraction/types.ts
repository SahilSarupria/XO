import type { LoadedPdfDocument, LoadedPdfPage } from '../pdf/pdf-loader.js';
import type { RunBudget } from './budget.js';

/**
 * Tiered page recovery. The deterministic reader handles every page that has a text layer for free. A page it cannot
 * read (a scan, outlined text, an unreadable font) is offered to recovery tiers in order of cost, and the first tier
 * that returns trustworthy text wins. Nothing here sends a whole document anywhere: a tier sees one page.
 *
 *   free   a second reader of the same file, no I/O beyond the process
 *   local  OCR / layout models that run on this machine: time, no tokens
 *   model  a hosted model: tokens and money, so it is last and budget-guarded
 */
export type TierCostClass = 'free' | 'local' | 'model';
export const TIER_COST_ORDER: readonly TierCostClass[] = ['free', 'local', 'model'];

export interface RecoveredLine {
  readonly text: string;
  /** Page-space position, same convention as `TextRun` (origin bottom-left, y grows upward). Reading order is recovered from these. */
  readonly x: number;
  readonly y: number;
  readonly fontSizePt?: number;
}

export interface PageRecovery {
  readonly lines: readonly RecoveredLine[];
  /** 0..1. A recovery below the budget's `minConfidence` is discarded, not trusted. */
  readonly confidence: number;
  readonly tokensUsed?: number;
  readonly costUsd?: number;
}

export interface PageRecoveryContext {
  readonly page: LoadedPdfPage;
  readonly document: LoadedPdfDocument;
  /** The original file bytes, so a tier can rasterise or re-parse the page itself. */
  readonly bytes: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface PageTier {
  /** Stable id, recorded in coverage and in the ledger. */
  readonly name: string;
  /** Bump when the tier's output could change, so cached recoveries are not reused across versions. */
  readonly version: string;
  readonly costClass: TierCostClass;
  /** Cheap, synchronous: should this tier try this page at all? */
  handles(page: LoadedPdfPage): boolean;
  /** Worst-case spend for this page, reserved against the budget BEFORE the call. Omit for free and local tiers. */
  estimateCostUsd?(page: LoadedPdfPage): number;
  /** Returns `undefined` when the tier cannot read the page. Throwing is treated the same way. */
  recover(ctx: PageRecoveryContext): Promise<PageRecovery | undefined>;
}

export interface ExtractionBudget {
  /** Hard ceiling for the whole document. Model tiers are skipped, never overrun, once it would be exceeded. Default 0: no model spend unless the caller opts in. */
  readonly maxCostUsd?: number;
  /** A recovery below this confidence is rejected. Default 0.6. */
  readonly minConfidence?: number;
  /** Pages recovered in parallel. Default 4. */
  readonly concurrency?: number;
  /** Per-page wall-clock limit in ms for any one tier call. On expiry the tier's `signal` is aborted. Default 60_000. */
  readonly tierTimeoutMs?: number;
  /** Cancels the whole recovery run: in-flight tier calls are aborted and remaining pages are left unaccounted. */
  readonly signal?: AbortSignal;
  /** Hard spend ceiling shared across every document of a run. Checked together with `maxCostUsd`; either one stops a model call. */
  readonly runBudget?: RunBudget;
}

export interface RecoveryCache {
  get(key: string): Promise<PageRecovery | undefined> | PageRecovery | undefined;
  set(key: string, value: PageRecovery): Promise<void> | void;
}

export type RecoveryOutcome =
  | 'recovered'
  | 'cache_hit'
  /** Another page request for the same (document, page, tier) was already in flight; its result was shared, nothing was sent twice. */
  | 'deduplicated'
  | 'low_confidence'
  | 'no_text'
  | 'tier_failed'
  | 'skipped_budget'
  | 'timed_out'
  | 'cancelled';

export interface LedgerEntry {
  readonly page: number;
  readonly tier: string;
  readonly costClass: TierCostClass;
  readonly outcome: RecoveryOutcome;
  readonly ms: number;
  readonly tokens: number;
  readonly costUsd: number;
}

/** Everything a recovery run spent, per page and per tier, so cost is a number you can read rather than a surprise. */
export interface TierCostSummary {
  readonly tier: string;
  readonly costClass: TierCostClass;
  readonly attempts: number;
  readonly recovered: number;
  readonly ms: number;
  readonly tokens: number;
  readonly costUsd: number;
}

export interface ExtractionLedger {
  readonly entries: readonly LedgerEntry[];
  /** The same entries rolled up per tier: what each tier cost and how much it recovered. */
  readonly byTier: readonly TierCostSummary[];
  readonly pagesNeedingRecovery: number;
  readonly pagesRecovered: number;
  readonly totalMs: number;
  readonly totalTokens: number;
  readonly totalCostUsd: number;
}
