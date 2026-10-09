import type { Diagnostic } from '@xo/xoir';
import type { DocumentBlock, DocumentSection, ParsedDocument } from './types.js';
import { findSuspiciousTokens } from './text-legibility.js';

/**
 * Phase 0's "Make Source Extraction Trustworthy" lifecycle, expressed as
 * a type: SOURCE -> EXTRACTED (Stage 1/2 already ran) -> QUALITY CHECK
 * (this module) -> one of these three states -> semantic extraction
 * (Stage 3+) only when the state permits it. See `compile-sources.ts`
 * for where this gates the pipeline.
 */
export type SourceQualityState = 'trusted' | 'degraded' | 'blocked';

export interface DocumentQualityReport {
  readonly state: SourceQualityState;
  readonly totalTokens: number;
  readonly suspiciousTokens: number;
  /** `suspiciousTokens / totalTokens`, `0` for a document with no tokens at all (vacuously trusted — there is nothing to distrust). */
  readonly suspiciousTokenRatio: number;
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
export function assessDocumentQuality(parsed: ParsedDocument, sourceId: string): DocumentQualityReport {
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
  const state: SourceQualityState = suspiciousTokenRatio > BLOCKED_RATIO_THRESHOLD ? 'blocked' : suspiciousTokenRatio > DEGRADED_RATIO_THRESHOLD ? 'degraded' : 'trusted';

  if (state !== 'trusted') {
    diagnostics.push({
      severity: state === 'blocked' ? 'error' : 'warning',
      passName: SOURCE_QUALITY_PASS_NAME,
      code: `source-quality/${state}`,
      message: `Source "${sourceId}" marked ${state}: ${suspiciousTokens}/${totalTokens} tokens (${(suspiciousTokenRatio * 100).toFixed(1)}%) show extraction-corruption signals.${state === 'blocked' ? ' Semantic extraction was not run for this source — see the accompanying per-token diagnostics for what was found untrustworthy.' : ''}`,
    });
  }

  return { state, totalTokens, suspiciousTokens, suspiciousTokenRatio, diagnostics };
}
