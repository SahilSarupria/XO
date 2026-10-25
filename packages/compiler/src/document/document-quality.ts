import type { Diagnostic } from '@xo/xoir';
import type { DocumentBlock, DocumentSection, ParsedDocument } from './types.js';
import { findSuspiciousTokens } from './text-legibility.js';
import {
  accountedContentPages,
  coverageCounts,
  coverageDiagnostics,
  SOURCE_COVERAGE_PASS_NAME,
  type CoverageCounts,
  type CoverageReport,
} from './page-coverage.js';

/**
 * Phase 0's "Make Source Extraction Trustworthy" lifecycle, expressed as
 * a type: SOURCE -> EXTRACTED (Stage 1/2 already ran) -> QUALITY CHECK
 * (this module) -> one of these four states -> semantic extraction
 * (Stage 3+) only when the state permits it. See `compile-sources.ts`
 * for where this gates the pipeline.
 *
 * - `trusted`   every page accounted for, text legible.
 * - `degraded`  all pages read, but some tokens look like layout artifacts.
 * - `partial`   (CRD-03) the readable pages compile, but at least one page was not read. Content
 *               from the unread pages is absent, so capabilities from this source are not
 *               approvable without a recorded human waiver.
 * - `blocked`   nothing trustworthy to extract from; semantic extraction does not run.
 */
export type SourceQualityState = 'trusted' | 'degraded' | 'partial' | 'blocked';

export interface DocumentQualityReport {
  readonly state: SourceQualityState;
  readonly totalTokens: number;
  readonly suspiciousTokens: number;
  /** `suspiciousTokens / totalTokens`, `0` for a document with no tokens at all (vacuously trusted — there is nothing to distrust). */
  readonly suspiciousTokenRatio: number;
  /** Per-page counts when the source had page structure; `undefined` otherwise. The page-by-page entries stay on the `CoverageReport` the caller already holds. */
  readonly coverage?: CoverageCounts;
  /** One entry per suspicious token found, plus a trailing summary diagnostic when `state !== 'trusted'`. Shaped as `@xo/xoir#Diagnostic` (this package's existing pass-diagnostic convention — see `pipeline/validate-pass.ts`) even though this check runs upstream of XOIR construction, so a caller can merge these directly into a `CompiledXoirResult.diagnostics` array without translation. */
  readonly diagnostics: readonly Diagnostic[];
}

export const SOURCE_QUALITY_PASS_NAME = 'source-quality';

/**
 * Above this suspicious-token ratio, a source is downgraded from
 * `'trusted'` to `'degraded'`. Real-world scanned/table-heavy documents
 * routinely contain a handful of layout-reconstruction artifacts even
 * after `line-grouper.ts`'s fix (rare residual cases, or content this
 * package's PDF pipeline never claimed glyph-perfect fidelity for — see
 * that package's README, "Known limitations") — a source should not
 * lose full trust over a small, bounded fraction of its text.
 */
const DEGRADED_RATIO_THRESHOLD = 0.02;

/**
 * Above this ratio, enough of the document's text is unreliable that
 * semantic extraction run over it is more likely to invent structure
 * from corrupted tokens than to recover real content from them — this
 * is Phase 0's "prefer false negatives over false positives" boundary
 * made concrete: past this point the compiler declines to treat the
 * source as trustworthy input rather than silently extracting from it
 * anyway.
 */
const BLOCKED_RATIO_THRESHOLD = 0.15;

function textOf(block: DocumentBlock): string {
  return block.kind === 'table_row' ? block.cells.join(' ') : block.text;
}

function pageOf(block: DocumentBlock): number {
  return block.provenance.page;
}

function collectBlocks(section: DocumentSection, acc: DocumentBlock[]): void {
  acc.push(...section.blocks);
  for (const subsection of section.subsections) collectBlocks(subsection, acc);
}

/**
 * Assesses one already-parsed document's (Stage 2 output) text
 * legibility and returns a `DocumentQualityReport`. Pure/deterministic:
 * same `ParsedDocument` in, same report out, every time — required for
 * this to be safely re-run and for `compile-sources.ts`'s determinism
 * tests to hold.
 *
 * Deliberately operates on `ParsedDocument`, not on any PDF-specific
 * type: every `SourceFrontend` (`../sources/`) that produces
 * `DocumentSourceContent` — PDF, HTML, structured, plain-text/document —
 * already normalizes into this same shape (see `../sources/types.ts`),
 * so one quality pass covers every source family without a single
 * `if (sourceType === 'pdf')` branch anywhere in this module or its
 * caller.
 */
export function assessDocumentQuality(parsed: ParsedDocument, sourceId: string, coverage?: CoverageReport): DocumentQualityReport {
  const blocks: DocumentBlock[] = [];
  collectBlocks(parsed.root, blocks);

  let totalTokens = 0;
  let suspiciousTokens = 0;
  const diagnostics: Diagnostic[] = [];

  for (const block of blocks) {
    const text = textOf(block);
    const tokenCount = text.split(/\s+/).filter((t) => t.length > 0).length;
    totalTokens += tokenCount;

    const findings = findSuspiciousTokens(text);
    suspiciousTokens += findings.length;
    for (const finding of findings) {
      diagnostics.push({
        severity: 'warning',
        passName: SOURCE_QUALITY_PASS_NAME,
        code: `source-quality/${finding.kind}`,
        message: `Source "${sourceId}" (page ${pageOf(block)}): suspicious extraction token "${finding.token}" (${finding.kind}) — looks like a layout-reconstruction artifact, not trustworthy source content.`,
      });
    }
  }

  const suspiciousTokenRatio = totalTokens === 0 ? 0 : suspiciousTokens / totalTokens;

  // CRD-03: page accounting. A paginated source with no page read at all has nothing to trust,
  // however clean the (empty) text looks — this is the A1-01 hole, where a fully scanned PDF was
  // vacuously "trusted" because quality was judged only on the tokens that survived.
  const nothingRead = coverage !== undefined && accountedContentPages(coverage) === 0;
  const state: SourceQualityState =
    nothingRead || suspiciousTokenRatio > BLOCKED_RATIO_THRESHOLD
      ? 'blocked'
      : coverage !== undefined && !coverage.complete
        ? 'partial'
        : suspiciousTokenRatio > DEGRADED_RATIO_THRESHOLD
          ? 'degraded'
          : 'trusted';

  if (coverage !== undefined) diagnostics.push(...coverageDiagnostics(coverage, sourceId));

  if (state !== 'trusted') {
    diagnostics.push({
      severity: state === 'blocked' ? 'error' : 'warning',
      passName: nothingRead || state === 'partial' ? SOURCE_COVERAGE_PASS_NAME : SOURCE_QUALITY_PASS_NAME,
      code: `source-quality/${state}`,
      message: summaryMessage(state, sourceId, { suspiciousTokens, totalTokens, suspiciousTokenRatio }, coverage, nothingRead),
    });
  }

  return {
    state,
    totalTokens,
    suspiciousTokens,
    suspiciousTokenRatio,
    ...(coverage !== undefined ? { coverage: coverageCounts(coverage) } : {}),
    diagnostics,
  };
}

function summaryMessage(
  state: SourceQualityState,
  sourceId: string,
  tokens: { readonly suspiciousTokens: number; readonly totalTokens: number; readonly suspiciousTokenRatio: number },
  coverage: CoverageReport | undefined,
  nothingRead: boolean,
): string {
  if (nothingRead && coverage !== undefined) {
    return `Source "${sourceId}" marked blocked: none of its ${coverage.totalPages} page(s) could be read (${coverage.unaccountedPages} unaccounted, ${coverage.excludedPages} blank). Semantic extraction was not run for this source.`;
  }
  if (state === 'partial' && coverage !== undefined) {
    return `Source "${sourceId}" marked partial: ${coverage.unaccountedPages} of ${coverage.totalPages} page(s) were not read (${coverage.extractedPages} extracted, ${coverage.ocrPages} OCR'd, ${coverage.excludedPages} excluded). Capabilities from this source are not approvable without a recorded human waiver.`;
  }
  return `Source "${sourceId}" marked ${state}: ${tokens.suspiciousTokens}/${tokens.totalTokens} tokens (${(tokens.suspiciousTokenRatio * 100).toFixed(1)}%) show extraction-corruption signals.${state === 'blocked' ? ' Semantic extraction was not run for this source — see the accompanying per-token diagnostics for what was found untrustworthy.' : ''}`;
}
