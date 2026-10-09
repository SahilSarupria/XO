import { err, ok, type Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import type { Logger } from '@xo/logger';
import type { AiCapabilityLayer } from '@xo/ai-core';
import { NodePdfLoader, type LoadedPdfDocument } from '../pdf/pdf-loader.js';
import { parseDocument } from '../document/document-parser.js';
import type { DocumentSection } from '../document/types.js';
import { chunkDocument } from '../semantic/semantic-chunker.js';
import type { BoundaryAmbiguityResolver } from '../semantic/boundary-resolver.js';
import type { ExperienceDocument } from '../semantic/types.js';
import { extractKnowledgeGraph } from '../knowledge/knowledge-extractor.js';
import { extractCapabilityGraph } from '../capabilities/capability-extractor.js';
import { extractReasoningGraph } from '../reasoning/reasoning-extractor.js';
import { mintRuleLevelCapabilities } from '../capabilities/rule-capability-minter.js';
import { synthesizeTitle } from '../semantic/title.js';
import { compileXoir } from './compile.js';
import type { CompiledXoirResult } from './types.js';

export interface CompilePdfOptions {
  /** Shared across every Stage 4-7 extractor (`aiCore`/`domainHint`/`logger`) — see each extractor's own options doc comment (`knowledge-extractor.ts`, `capability-extractor.ts`, `reasoning-extractor.ts`). Omitted `aiCore` means every stage runs rule-based only, which is a correct, if lower-confidence and narrower, graph end to end — never a failure. */
  readonly aiCore?: AiCapabilityLayer;
  readonly domainHint?: string;
  /** Passed through to Stage 7 (`extractReasoningGraph`) only — see `reasoning-extractor.ts`. */
  readonly focusQuestion?: string;
  readonly logger?: Logger;
  /** Stage 3's boundary-ambiguity resolver override — see `semantic-chunker.ts` / `boundary-resolver.ts`. Defaults to the deterministic rule-based resolver. */
  readonly boundaryResolver?: BoundaryAmbiguityResolver;
  /** Forwarded to `compileXoir` (Stage 6) — see `pipeline/types.ts#CompileXoirOptions`. */
  readonly graphId?: string;
  readonly now?: () => string;
}

export interface CompiledPdfResult extends CompiledXoirResult {
  /** Stage 1's loaded document — exposed mainly so a caller can inspect `pages[].requiresOcr` to explain a thin or empty resulting graph (a scanned page with no extractable text contributes nothing downstream; see `pdf-loader.ts`). */
  readonly loadedDocument: LoadedPdfDocument;
  /** Stage 3's output — exposed for callers that want unit-level provenance (`experienceDocument.units[].provenance`) without re-deriving it from the final XOIR graph. */
  readonly experienceDocument: ExperienceDocument;
}

/** First page-level heading in the parsed structural tree, if any — the natural document title for a form/report/contract whose first line of real content usually *is* its title (matches every one of this package's real-world regression fixtures: "CLAIM FORM FOR HEALTH INSURANCE POLICIES...", "Claim Form - Part B", etc.). */
function firstHeadingText(section: DocumentSection): string | undefined {
  if (section.heading) return section.heading.text;
  for (const block of section.blocks) {
    if (block.kind === 'heading') return block.text;
  }
  for (const sub of section.subsections) {
    const found = firstHeadingText(sub);
    if (found) return found;
  }
  return undefined;
}

function deriveDocumentTitle(loaded: LoadedPdfDocument, parsedRoot: DocumentSection, sourcePath: string): string {
  if (loaded.metadata.title && loaded.metadata.title.trim().length > 0) return loaded.metadata.title.trim();
  const heading = firstHeadingText(parsedRoot);
  if (heading) return heading;
  const firstPageText = loaded.pages.find((p) => !p.requiresOcr)?.plainText ?? '';
  if (firstPageText.trim().length > 0) return synthesizeTitle(firstPageText);
  return sourcePath;
}

/**
 * The single PDF -> XOIR entry point: `PDF bytes -> Stage 1 (pdf-loader.ts)
 * -> Stage 2 (document-parser.ts) -> Stage 3 (semantic-chunker.ts) ->
 * Stage 4/5/7 (knowledge-/capability-/reasoning-extractor.ts, run in
 * parallel — they each read the same immutable `ExperienceDocument` and
 * don't depend on one another's *output*, only Stage 5 takes Stage 4's
 * `KnowledgeGraph` as an input per its own signature) -> Stage 6
 * (`compileXoir`, Stage 6/7's `'combined'` input kind)`.
 *
 * This function is the thing that did not exist before: every stage above
 * was independently implemented and independently tested, but nothing
 * chained a real, on-disk PDF through all of them — see this package's
 * README, "Known limitations," and the regression fixtures this was
 * built and verified against. A source adapter (or a caller testing the
 * pipeline end to end) needs exactly this one function; it should never
 * need to import `pdf-loader.ts`, `document-parser.ts`, etc. directly.
 *
 * Mirrors `compileXoir`'s own contract: never throws for a pipeline-stage
 * problem. A malformed/unsupported PDF (Stage 1) comes back as `err`
 * (there is no page structure to even attempt Stage 2 onward from). Once
 * Stage 1 succeeds, every later stage's own "never fail compilation"
 * discipline holds — a page needing OCR simply contributes nothing, a
 * unit with no rule-based match simply contributes no candidate node, and
 * the result is `ok(...)` with `valid` reflecting Stage 6's own
 * validation outcome, exactly as `compileXoir` already documents.
 */
export async function compilePdfToXoir(bytes: Uint8Array, sourcePath: string, options: CompilePdfOptions = {}): Promise<Result<CompiledPdfResult, XoError>> {
  const loadResult = new NodePdfLoader().load(bytes, sourcePath);
  if (!loadResult.ok) return err(loadResult.error);
  const loadedDocument = loadResult.value;

  const parsedDocument = parseDocument(loadedDocument);
  const documentTitle = deriveDocumentTitle(loadedDocument, parsedDocument.root, sourcePath);

  const experienceDocument = await chunkDocument(parsedDocument, sourcePath, documentTitle, options.boundaryResolver ? { resolver: options.boundaryResolver } : {});

  const sharedExtractionOptions = {
    ...(options.aiCore !== undefined ? { aiCore: options.aiCore } : {}),
    ...(options.domainHint !== undefined ? { domainHint: options.domainHint } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };

  const knowledge = await extractKnowledgeGraph(experienceDocument, sharedExtractionOptions);
  const capability = await extractCapabilityGraph(experienceDocument, knowledge, sharedExtractionOptions);
  const reasoning = await extractReasoningGraph(experienceDocument, {
    ...sharedExtractionOptions,
    ...(options.focusQuestion !== undefined ? { focusQuestion: options.focusQuestion } : {}),
  });

  // M1.1 — additive rule-level capability minting (see
  // `../capabilities/rule-capability-minter.ts`'s doc comment for the
  // full rationale). Runs after both `capability` and `reasoning` exist
  // (minting needs the reasoning graph's per-rule structured conditions,
  // which `extractCapabilityGraph` above never sees) and merely appends
  // to `capability.capabilities` — every existing verb-/title-derived
  // capability from `extractCapabilityGraph` is passed through
  // unchanged, so this can never regress or remove any capability the
  // pipeline already produced. Mirrors `compile-sources.ts`'s identical
  // step verbatim — this pipeline and that one are independent
  // extraction orchestrations that must both apply M1.1 minting, and
  // this call site was the one missing it (the packaged-artifact
  // discrepancy for `cap_rule_2a15163541fa80841ee32ba0602c07b4`).
  const mintedCapabilities = mintRuleLevelCapabilities(reasoning);
  const capabilityWithMintedRules = mintedCapabilities.length > 0 ? { ...capability, capabilities: [...capability.capabilities, ...mintedCapabilities] } : capability;

  const compiled = await compileXoir(
    { kind: 'combined', knowledge, capability: capabilityWithMintedRules, reasoning },
    {
      ...(options.graphId !== undefined ? { graphId: options.graphId } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
    },
  );
  if (!compiled.ok) return err(compiled.error);

  return ok({ ...compiled.value, loadedDocument, experienceDocument });
}
