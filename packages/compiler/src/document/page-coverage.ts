import type { Diagnostic } from '@xo/xoir';

/**
 * WS1-01 / CRD-03: a document is trusted only if every page is accounted for.
 *
 * Every page of a paginated source ends in exactly one of four states:
 *
 * - `extracted`   its text was read and fed to the compiler.
 * - `ocr`         its text was recovered by an OCR engine and fed to the compiler. No OCR engine
 *                 ships today, so nothing produces this state yet; the ledger carries it so an OCR
 *                 stage can be added without changing any consumer.
 * - `excluded`    the page was deliberately left out for a recorded, reviewable reason. Only
 *                 reasons that provably carry no content qualify (see `EXCLUDABLE_REASONS`).
 * - `unaccounted` the page may carry content that the compiler did NOT read, or its fate is
 *                 unknown. This is the fail-closed state: a source with any unaccounted page is
 *                 `partial` and must not yield approvable capabilities without a recorded human
 *                 waiver.
 *
 * Before this ledger a scanned page was dropped after quality assessment had already run, so a
 * fully scanned PDF looked vacuously "trusted" (audit A1-01). Pure data, no I/O.
 */
export type PageCoverageStatus = 'extracted' | 'ocr' | 'excluded' | 'unaccounted';

/** Machine-readable reasons. Free text goes in `detail`, never here, so consumers can switch on this. */
export type PageCoverageReason = 'blank_page' | 'requires_ocr_unavailable' | 'no_extractable_text' | 'page_load_failed';

/** The only reasons under which a page may be `excluded`: each one asserts the page holds no content. */
export const EXCLUDABLE_REASONS: ReadonlySet<PageCoverageReason> = new Set<PageCoverageReason>(['blank_page']);

export interface PageCoverageEntry {
  /** 1-based, the number a human would cite. */
  readonly page: number;
  readonly status: PageCoverageStatus;
  readonly reason?: PageCoverageReason;
  /** Human-readable specifics (e.g. the underlying parser error). Never parsed by code. */
  readonly detail?: string;
}

export interface CoverageCounts {
  readonly totalPages: number;
  readonly extractedPages: number;
  readonly ocrPages: number;
  readonly excludedPages: number;
  readonly unaccountedPages: number;
}

export interface CoverageReport extends CoverageCounts {
  /** One entry per page, ascending by page number. */
  readonly entries: readonly PageCoverageEntry[];
  /** True iff `unaccountedPages === 0` — i.e. every page is extracted, OCR'd, or validly excluded. */
  readonly complete: boolean;
}

export const SOURCE_COVERAGE_PASS_NAME = 'source-coverage';

/**
 * Builds the report from per-page entries. Throws on an entry that is internally inconsistent
 * (an `excluded` page without an excludable reason, a duplicated page number): those are
 * programming errors in the caller, and a ledger that silently accepted them would defeat its
 * own purpose.
 */
export function summarizeCoverage(entries: readonly PageCoverageEntry[]): CoverageReport {
  const sorted = [...entries].sort((a, b) => a.page - b.page);
  const seen = new Set<number>();
  for (const entry of sorted) {
    if (seen.has(entry.page)) throw new Error(`page coverage: page ${entry.page} recorded more than once`);
    seen.add(entry.page);
    if (entry.status === 'excluded' && (entry.reason === undefined || !EXCLUDABLE_REASONS.has(entry.reason))) {
      throw new Error(`page coverage: page ${entry.page} excluded without a valid exclusion reason`);
    }
  }
  const count = (status: PageCoverageStatus): number => sorted.filter((e) => e.status === status).length;
  const unaccountedPages = count('unaccounted');
  return {
    totalPages: sorted.length,
    extractedPages: count('extracted'),
    ocrPages: count('ocr'),
    excludedPages: count('excluded'),
    unaccountedPages,
    entries: sorted,
    complete: unaccountedPages === 0,
  };
}

/** The subset of the report that is persisted on the XOIR manifest (entries stay in the compile result). */
export function coverageCounts(report: CoverageReport): CoverageCounts {
  return {
    totalPages: report.totalPages,
    extractedPages: report.extractedPages,
    ocrPages: report.ocrPages,
    excludedPages: report.excludedPages,
    unaccountedPages: report.unaccountedPages,
  };
}

/** Number of pages whose content reached the compiler (extracted or OCR'd). */
export function accountedContentPages(report: CoverageReport): number {
  return report.extractedPages + report.ocrPages;
}

function describe(entry: PageCoverageEntry): string {
  const reason = entry.reason ?? 'unknown';
  return entry.detail !== undefined ? `${reason} (${entry.detail})` : reason;
}

/**
 * One warning per unaccounted page, so a reviewer can see exactly which pages were not read and
 * why. The state-level summary diagnostic is added by `assessDocumentQuality`.
 */
export function coverageDiagnostics(report: CoverageReport, sourceId: string): Diagnostic[] {
  return report.entries
    .filter((entry) => entry.status === 'unaccounted')
    .map(
      (entry): Diagnostic => ({
        severity: 'warning',
        passName: SOURCE_COVERAGE_PASS_NAME,
        code: `source-coverage/${entry.reason ?? 'unaccounted'}`,
        message: `Source "${sourceId}" (page ${entry.page}): not read by the compiler — ${describe(entry)}. Content on this page is absent from every capability derived from this source.`,
      }),
    );
}
