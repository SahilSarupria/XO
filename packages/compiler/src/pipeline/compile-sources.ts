import { checkCompileInferenceAuthority } from './inference-authority.js';
import type { GrammarLexicon } from '@xo/capability-contract';
import { err, ok, ContentHash, type Result } from '@xo/types';
import { ErrorCode, SourceError, type XoError } from '@xo/errors';
import type { Logger } from '@xo/logger';
import type { Diagnostic } from '@xo/xoir';
import { createManifest, type SourceQualityInfo } from '@xo/xoir';
import { chunkDocument } from '../semantic/semantic-chunker.js';
import type { ExperienceDocument } from '../semantic/types.js';
import type { CoverageReport } from '../document/page-coverage.js';
import { needsRecovery, recoverUnreadPages } from '../extraction/router.js';
import { proposeDocumentKinds, type DocumentKindProposal } from '../sources/kind-proposals.js';
import { extractDimensions, sniffMimeType, type ImageSourceInput } from '../sources/image-frontend.js';
import { imageAsRecoverableDocument } from '../extraction/image-document.js';
import type { ExtractionBudget, ExtractionLedger, PageTier, RecoveryCache } from '../extraction/types.js';
import { NodePdfLoader } from '../pdf/pdf-loader.js';
import type { PdfSourceInput } from '../sources/pdf-frontend.js';
import type { UnclassifiedSentence } from '../reasoning/types.js';
import { assessDocumentQuality, SOURCE_QUALITY_PASS_NAME, type SourceQualityState } from '../document/document-quality.js';
import { extractKnowledgeGraph, type KnowledgeExtractionOptions } from '../knowledge/knowledge-extractor.js';
import { extractCapabilityGraph, type CapabilityExtractionOptions } from '../capabilities/capability-extractor.js';
import { analyzeCrossDocument, type CrossDocumentAnalysis, type CrossDocumentSource, type PrecedencePolicy } from './cross-document.js';
import { splitSentences } from '../capabilities/sentence-split.js';
import { runCandidateProvider, type CandidateProvider, type CandidateRunResult } from '../ai-assist/candidates.js';
import { buildReviewQueue, type ReviewQueue } from './review-queue.js';
import { analyzeExecutionReadiness, type ConnectorDeclaration, type ExecutionReadiness } from './execution-readiness.js';
import { BUILT_IN_PACKS } from '../knowledge-layer/packs/index.js';
import { listDomainProfiles, type DomainProfile } from '../profiles/index.js';
import { Bm25Retriever, HybridRetriever, StructuredLookupRetriever } from '../knowledge-layer/retrieval.js';
import { identifyDomain } from '../knowledge-layer/identify.js';
import type { DomainKnowledgePack } from '../knowledge-layer/types.js';
import { classifyContent, classifySentenceKind } from '../document/content-classification.js';
import { uncoveredNormativeSentences } from '../reasoning/coverage.js';
import { interpretPrompt, type PromptInterpretation } from '../prompt/interpret.js';
import { mintRuleLevelCapabilities, nonMandatoryRuleDiagnostics } from '../capabilities/rule-capability-minter.js';
import { extractReasoningGraph, type ReasoningExtractionOptions } from '../reasoning/reasoning-extractor.js';
import type { ConfirmedRule } from '../reasoning/rule-proposals.js';
import { compileXoir } from './compile.js';
import {
  synthesizePolicyArtifacts,
  type PolicyArtifacts,
  type PolicyOptions,
  type PolicyReview,
  type PolicySource,
} from '../policy/artifacts.js';
import { policyTextFromParsed } from '../policy/from-document.js';
import { policyCapability, policyReasoningNodes } from '../policy/to-graph.js';
import type { CompiledXoirResult } from './types.js';
import { createDefaultSourceFrontendRegistry } from '../sources/default-registry.js';
import type { SourceFrontendRegistry } from '../sources/registry.js';
import type { CanonicalSource, SourceType } from '../sources/types.js';

/**
 * Per-source status for `CompileSourcesResult.sources` — Stage 8 §22's
 * "fully supported vs. extensible" distinction, surfaced as data rather
 * than only as a doc comment, so a caller (or a future CLI `inspect`
 * command, `XO_PROTOCOL.md` §18.1) can render it without re-deriving the
 * distinction itself.
 */
export interface SourceCompilationReport {
  readonly sourceId: string;
  readonly sourceType: SourceType;
  readonly sourcePath: string;
  readonly semanticExtractionAvailable: boolean;
  /** Number of `ExperienceUnit`s this source contributed to the shared extraction run — always `0` for a source with `semanticExtractionAvailable: false` (e.g. an image), which is the honest, non-silent way that outcome is represented (Stage 8 §22). Also `0` for a `document`-kind source whose quality state is `'blocked'` — see `qualityState` below. */
  readonly unitCount: number;
  /**
   * Phase 0's source-quality lifecycle result for this source (SOURCE ->
   * EXTRACTED -> QUALITY CHECK -> TRUSTED/DEGRADED/BLOCKED,
   * `../document/document-quality.ts`). `undefined` for a
   * non-`document`-kind source, which the quality pass never runs
   * against (there is no extracted text to assess).
   *
   * - `'partial'`: the readable pages were extracted, but at least one page was not read
   *   (`coverage` lists which and why); not approvable without a recorded human waiver.
   * - `'trusted'` / `'degraded'`: semantic extraction ran normally; a
   *   `'degraded'` source additionally carries per-token findings in
   *   `CompileSourcesResult.diagnostics`.
   * - `'blocked'`: semantic extraction was **not** run for this source
   *   (`unitCount` is `0`) — the compiler declined to treat its
   *   extracted text as trustworthy input rather than silently
   *   promoting corrupted tokens into capability/knowledge candidates.
   */
  readonly qualityState?: SourceQualityState;
  /**
   * Page-by-page accounting (WS1-01, CRD-03) for paginated sources: which pages were extracted,
   * OCR'd, excluded (with reason) or left unaccounted. Absent for sources with no page structure.
   * A `'partial'` `qualityState` means `coverage.unaccountedPages > 0`.
   */
  readonly coverage?: CoverageReport;
  /** What page recovery tried and spent for this source (`CompileSourcesOptions.pageTiers`). Absent when no tier was configured or no page needed one. */
  readonly recovery?: ExtractionLedger;
  /**
   * Trust class of this source. Present only for prompt-authored input (`'user_instruction'`: what an author WANTS, never
   * evidence); absent for ordinary documents, whose class is the default `source_document`.
   */
  readonly sourceClass?: 'user_instruction';
  /**
   * UW-3 — what kind of document this looks like (certificate, invoice, register, ...), best first, each with the cues that matched and
   * where. Always `status: 'proposed'`: a person confirms a kind; nothing downstream treats a proposal as fact. Absent for sources with
   * no text; empty when nothing in the cue pack matched.
   */
  readonly kindProposals?: readonly DocumentKindProposal[];
}

/** What the compiler understood a prompt source to say, and whether a person has confirmed it (only confirmed prompts compile). */
export interface PromptInterpretationReport {
  readonly sourceId: string;
  readonly sourcePath: string;
  readonly confirmed: boolean;
  readonly confirmedBy?: string;
  readonly interpretation: PromptInterpretation;
}

export interface CompileSourcesResult extends CompiledXoirResult {
  /**
   * Executable decision logic read from the same documents (decision tree, safety rules, worked examples, review report).
   * Absent when no document in the run states decidable rules. Pass it to `packageXoirGraph({ policy })`.
   */
  readonly policy?: PolicyArtifacts;
  /** One entry per input, in input order — always present even for inputs that contributed zero units, so a caller can see exactly what happened to every source it submitted (Stage 8 §14's "must not silently pass through"). */
  readonly sources: readonly SourceCompilationReport[];
  /**
   * WS1-04 / CRD-04: sentences that look decision-bearing (obligation, limit, deadline, exclusion,
   * condition) but that no deterministic rule pattern parsed, in document order, each with its
   * source span. A review list, not a rule list: nothing here is promoted automatically. Empty
   * means "the detector found none", which is a statement about the detector's lexicon, not a
   * guarantee that no rule was missed.
   */
  readonly unclassified: readonly UnclassifiedSentence[];
  /** One entry per prompt source, so a caller can show the author the interpretation and its open questions before confirming. Absent when no prompt source was supplied. */
  readonly promptInterpretations?: readonly PromptInterpretationReport[];
  /** Per-rule compiler state vs execution state (what was understood vs how it can run), with explicit blockers. */
  readonly executionReadiness?: ExecutionReadiness;
  /** Everything still needing a person, in one prioritised list (derived from the other outputs). */
  readonly reviewQueue?: ReviewQueue;
  /** Conflicts between rules (within or across sources) and supersession/amendment wording. */
  readonly crossDocument?: CrossDocumentAnalysis;
  /** Validated/rejected model candidates for unresolved sentences. Present only when a `candidateProvider` was supplied. */
  readonly aiCandidates?: readonly CandidateRunResult[];
  /** What the policy extractor understood and did not — kept even when no decision tree could be built. */
  readonly policyReview?: PolicyReview;
}

export interface CompileSourcesOptions {
  readonly registry?: SourceFrontendRegistry;
  readonly graphId?: string;
  readonly now?: () => string;
  readonly logger?: Logger;
  readonly aiCore?: KnowledgeExtractionOptions['aiCore'] & CapabilityExtractionOptions['aiCore'] & ReasoningExtractionOptions['aiCore'];
  readonly domainHint?: string;
  /** Domain-profile vocabulary for this compilation only. The neutral core grammar is unchanged when absent. */
  readonly lexicon?: GrammarLexicon;
  /**
   * Domain Knowledge Packs used for ADVISORY domain identification. Defaults to the built-in packs; `false` disables it.
   * Identification only reports (and suggests); it never changes extraction or applies vocabulary.
   */
  readonly knowledgePacks?: readonly DomainKnowledgePack[] | false;
  /**
   * EXPLICIT opt-in: apply the domain profile whose id equals the domain identified from the sources' own text. Off by default;
   * never applied when the domain is unknown or mixed, and an explicit `lexicon` always wins.
   */
  readonly autoProfile?: boolean;
  /** Authority ranking (highest first, by source path) used to resolve rule conflicts. Without it conflicts are reported unresolved — never guessed. */
  readonly precedence?: PrecedencePolicy;
  /** Connectors the caller declares. A declared operation is bound only when a connector lists it; nothing is ever inferred from prose. */
  readonly connectors?: readonly ConnectorDeclaration[];
  /**
   * Optional, injected model provider. It is asked ONLY about sentences the compiler could not resolve (lost or unstructured),
   * its output is validated deterministically against the source, and it is reported in `aiCandidates` — never merged into the
   * graph. Deterministic compilation never needs it or a key.
   */
  readonly candidateProvider?: CandidateProvider;
  /** Profiles `autoProfile` may choose from. Defaults to the built-in registry. */
  readonly profiles?: readonly DomainProfile[];
  readonly focusQuestion?: string;
  /** Policy synthesis runs by default; `false` skips it. `glossary` is the operator's closed-set classification glossary. */
  readonly policy?: false | PolicyOptions;
  /** Human-confirmed rule proposals for sentences on the review list (see `reasoning/rule-proposals.ts`). */
  readonly confirmedRules?: readonly ConfirmedRule[];
  /** Recovery tiers for pages the text reader cannot read (scans, outlined text). With none configured such pages stay unaccounted, exactly as before. */
  readonly pageTiers?: readonly PageTier[];
  /** Spend limits for recovery. Default: free and local tiers only, no model spend. */
  readonly extractionBudget?: ExtractionBudget;
  /** Reused across calls so a page is never recovered twice. */
  readonly recoveryCache?: RecoveryCache;
  /**
   * Explicit operator opt-in to run `aiCore` with NO spend limit. Absent/false means an unbounded layer is refused (see
   * `checkCompileInferenceAuthority`). Obtain it from `createCompilerAiLayer`, never default it.
   */
  readonly allowUnboundedInference?: boolean;
}

/**
 * Merges N independently-chunked `ExperienceDocument`s into one for a
 * single shared extraction run (Stage 8 §11: "do NOT run four
 * independent compilers and merge arbitrary outputs afterward ...
 * normalize all sources first, then run the common pipeline"). This is
 * safe against id collisions because every `ExperienceUnit.id` is a
 * content hash that includes `documentPath`
 * (`../semantic/unit-id.ts#computeExperienceUnitId`), and every source
 * here was chunked with its own unique `sourceId` as `documentPath` — so
 * two sources with byte-identical content still produce disjoint unit
 * ids. Relationships are concatenated as-is: this function never
 * invents a relationship between units from two different sources
 * (`buildRelationships` already ran once per source, inside
 * `chunkDocument`, before this merge), matching Stage 8 §12's "provenance
 * must remain truthful."
 */
function mergeExperienceDocuments(docs: readonly ExperienceDocument[], mergedPath: string): ExperienceDocument {
  return {
    documentPath: mergedPath,
    documentTitle: undefined,
    units: docs.flatMap((d) => d.units),
    relationshipGraph: { relationships: docs.flatMap((d) => d.relationshipGraph.relationships) },
  };
}

/**
 * The Stage 8 §15 entry point: `compile(request) -> resolve frontend(s)
 * -> canonical source(s) -> existing Stage 1-7 pipeline -> XOIR`,
 * generalized to any number of heterogeneous inputs. Each textual input
 * is normalized by its `SourceFrontend` into a `CanonicalSource` (a
 * `ParsedDocument`, structurally identical to what `NodePdfLoader` +
 * `parseDocument` already produce for a PDF), independently chunked by
 * the *unmodified* Stage 3 `chunkDocument`, then merged
 * (`mergeExperienceDocuments`) before Stage 4-7 ever run — so Stage 4-7
 * see exactly one `ExperienceDocument`, execute exactly once, and never
 * branch on which frontend produced any given unit.
 *
 * Non-textual sources (currently: `image`, whose
 * `semanticExtractionAvailable` is always `false` — see
 * `../sources/image-frontend.ts`) are ingested, hashed, and reported in
 * `sources`, but contribute no units and are never silently dropped nor
 * faked into producing content they can't support (Stage 8 §14, §22).
 *
 * Fails fast (returns `err`) on the first input that fails to resolve a
 * frontend or fails to ingest — a batch compile is one job, and a
 * malformed input in the middle of it is a real error the caller should
 * see immediately, not a partial result silently missing a source.
 *
 * Returns `err(SourceError)` if *no* input in the batch produced usable
 * document content — there being nothing to feed Stage 4-7 renders any
 * `CompiledXoirResult` produced meaningless, so this reports that
 * explicitly instead of returning a technically-"valid," in-practice-
 * empty `XoirGraph`.
 */
/** For a PDF input with unreadable pages, runs the configured recovery tiers and hands the frontend the recovered document. Anything else passes through untouched. */
async function withRecoveredPages(
  input: unknown,
  options: CompileSourcesOptions,
  ledgers: Map<string, ExtractionLedger>,
): Promise<unknown> {
  const candidate = input as Partial<PdfSourceInput> | null;
  const image = input as Partial<ImageSourceInput> | null;
  // UW-3: a photo or scanned image is read by the same tiers, as a one-page document with no text layer.
  if (
    image !== null &&
    typeof image === 'object' &&
    image.kind === 'image' &&
    image.bytes instanceof Uint8Array &&
    typeof image.sourcePath === 'string'
  ) {
    const mimeType = image.mimeType ?? sniffMimeType(image.bytes);
    if (mimeType === undefined || image.bytes.length === 0) return input;
    const wrapped = imageAsRecoverableDocument(image.sourcePath, mimeType, extractDimensions(image.bytes, mimeType));
    const { document, ledger } = await recoverUnreadPages(
      wrapped,
      image.bytes,
      options.pageTiers!,
      options.extractionBudget,
      options.recoveryCache,
    );
    ledgers.set(image.sourcePath, ledger);
    return { ...image, mimeType, preloaded: document };
  }
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    candidate.kind !== 'pdf' ||
    !(candidate.bytes instanceof Uint8Array) ||
    typeof candidate.sourcePath !== 'string'
  ) {
    return input;
  }
  const loaded = new NodePdfLoader().load(candidate.bytes, candidate.sourcePath);
  if (!loaded.ok || !loaded.value.pages.some(needsRecovery)) return input;
  const { document, ledger } = await recoverUnreadPages(
    loaded.value,
    candidate.bytes,
    options.pageTiers!,
    options.extractionBudget,
    options.recoveryCache,
  );
  ledgers.set(candidate.sourcePath, ledger);
  return { ...candidate, preloaded: document };
}

export async function compileSources(
  inputs: readonly unknown[],
  options: CompileSourcesOptions = {},
): Promise<Result<CompileSourcesResult, XoError>> {
  const authority = checkCompileInferenceAuthority(options.aiCore, options.allowUnboundedInference, options.logger);
  if (!authority.ok) return err(authority.error);
  if (inputs.length === 0) {
    return err(new SourceError(ErrorCode.INVALID_ARGUMENT, 'compileSources requires at least one input'));
  }

  const registry = options.registry ?? createDefaultSourceFrontendRegistry();
  const ingestContext =
    options.now !== undefined || options.logger !== undefined
      ? { ...(options.now !== undefined ? { now: options.now } : {}), ...(options.logger !== undefined ? { logger: options.logger } : {}) }
      : undefined;

  const ledgers = new Map<string, ExtractionLedger>();
  const canonicalSources: CanonicalSource[] = [];
  for (const rawInput of inputs) {
    const input =
      options.pageTiers !== undefined && options.pageTiers.length > 0 ? await withRecoveredPages(rawInput, options, ledgers) : rawInput;
    const ingested = registry.ingest(input, ingestContext);
    if (!ingested.ok) return err(ingested.error);
    canonicalSources.push(ingested.value);
  }

  const experienceDocuments: ExperienceDocument[] = [];
  const policySources: PolicySource[] = [];
  const sourceReports: SourceCompilationReport[] = [];
  const qualityDiagnostics: Diagnostic[] = [];
  // P0.9A area D ("Source quality surfaced"): every `document`-kind
  // source's quality assessment, keyed by `sourceId` — the same value
  // used as `documentPath` on every `XoirSourceRef` this source
  // contributes (see `chunkDocument` below), so it survives into the
  // graph's manifest (`setManifest` call near the end of this function)
  // and can be joined back to any node's own source refs, including
  // after the graph is serialized and reloaded independently of this
  // call. See `manifest.ts#SourceQualityInfo`'s doc comment for why this
  // lives on the manifest rather than on individual nodes.
  const sourceQualityByDocumentPath = new Map<string, SourceQualityInfo>();

  const promptReports: PromptInterpretationReport[] = [];
  const crossDocSources: CrossDocumentSource[] = [];
  for (const source of canonicalSources) {
    if (source.sourceType === 'prompt' && source.content.kind === 'document') {
      const interpretation = interpretPrompt(source.content.plainText, options.lexicon);
      const confirmedBy = source.metadata['confirmedBy'];
      const confirmed = source.metadata['confirmation'] === 'confirmed';
      promptReports.push({
        sourceId: source.sourceId,
        sourcePath: source.sourcePath,
        confirmed,
        ...(confirmedBy !== undefined ? { confirmedBy } : {}),
        interpretation,
      });
      for (const q of interpretation.questions) {
        qualityDiagnostics.push({
          severity: 'info',
          passName: 'prompt-interpretation',
          code: 'prompt/clarification-needed',
          message: `Prompt "${source.sourcePath}" [${q.reason}]: ${q.question}`,
        });
      }
      if (!confirmed) {
        qualityDiagnostics.push({
          severity: 'warning',
          passName: 'prompt-interpretation',
          code: 'prompt/awaiting-confirmation',
          message: `Prompt "${source.sourcePath}" is a user instruction awaiting confirmation (${interpretation.statements.length} statement(s), ${interpretation.intents.length} intent(s), ${interpretation.questions.length} open question(s)); it contributed nothing to this compilation. Review the interpretation and recompile with confirmedBy set.`,
        });
        sourceReports.push({
          sourceId: source.sourceId,
          sourceType: source.sourceType,
          sourcePath: source.sourcePath,
          semanticExtractionAvailable: true,
          unitCount: 0,
          sourceClass: 'user_instruction',
        });
        continue;
      }
      qualityDiagnostics.push({
        severity: 'info',
        passName: 'prompt-interpretation',
        code: 'prompt/confirmed',
        message: `Prompt "${source.sourcePath}" confirmed by ${confirmedBy ?? 'unknown'}; its rule-shaped statements are compiled through the same pipeline as documents.`,
      });
      if (interpretation.statements.length === 0) {
        qualityDiagnostics.push({
          severity: 'warning',
          passName: 'prompt-interpretation',
          code: 'prompt/no-formalizable-statements',
          message: `Prompt "${source.sourcePath}" was confirmed but contains no rule-shaped statements, only purpose statements or unrecognised text, so it contributed nothing to this compilation.`,
        });
        sourceReports.push({
          sourceId: source.sourceId,
          sourceType: source.sourceType,
          sourcePath: source.sourcePath,
          semanticExtractionAvailable: true,
          unitCount: 0,
          sourceClass: 'user_instruction',
        });
      }
      for (const intent of interpretation.intents) {
        qualityDiagnostics.push({
          severity: 'warning',
          passName: 'prompt-interpretation',
          code: 'prompt/unformalized-intent',
          message: `Intent "${intent.text}" is a purpose statement, not a rule: it was NOT compiled into an executable capability. Requested behaviour(s): ${intent.behaviours.join('; ') || 'none parsed'}.`,
        });
      }
      if (interpretation.statements.length === 0) continue;
    }
    if (source.content.kind !== 'document') {
      sourceReports.push({
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        sourcePath: source.sourcePath,
        semanticExtractionAvailable: false,
        unitCount: 0,
        kindProposals: proposeDocumentKinds(source), // file name only: a photo named certificate.jpg still gets a proposal to confirm
      });
      options.logger?.info('Source has no semantic extraction available; it will not contribute XOIR content', {
        sourceId: source.sourceId,
        sourceType: source.sourceType,
      });
      continue;
    }

    const quality = assessDocumentQuality(source.content.parsed, source.sourceId, source.content.coverage);
    const coverage = source.content.coverage;
    qualityDiagnostics.push(...quality.diagnostics);
    const ocrPages = source.metadata['ocrRequiredPages'];
    if (ocrPages !== undefined) {
      const ocrCount = ocrPages.split(',').length;
      const pageCount = Number(source.metadata['pageCount'] ?? '0');
      const allPages = pageCount > 0 && ocrCount >= pageCount;
      qualityDiagnostics.push({
        severity: allPages ? 'error' : 'warning',
        passName: SOURCE_QUALITY_PASS_NAME,
        code: 'source-quality/ocr-required',
        message: `Source "${source.sourceId}": page(s) ${ocrPages} have no extractable text layer and OCR is not available, so ${allPages ? 'the whole document' : 'those pages'} contributed no content. Any rules on ${allPages ? 'it' : 'them'} were NOT compiled.`,
      });
    }
    sourceQualityByDocumentPath.set(source.sourceId, {
      state: quality.state,
      suspiciousTokenRatio: quality.suspiciousTokenRatio,
      ...(quality.coverage !== undefined ? { coverage: quality.coverage } : {}),
    });

    if (quality.state === 'blocked') {
      sourceReports.push({
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        sourcePath: source.sourcePath,
        semanticExtractionAvailable: true,
        unitCount: 0,
        qualityState: quality.state,
        ...(coverage !== undefined ? { coverage } : {}),
        kindProposals: proposeDocumentKinds(source),
      });
      options.logger?.warn(
        'Source quality check blocked semantic extraction — extracted text was not trustworthy enough to feed into semantic extraction',
        {
          sourceId: source.sourceId,
          sourceType: source.sourceType,
          suspiciousTokenRatio: quality.suspiciousTokenRatio,
        },
      );
      continue;
    }

    if (options.policy !== false) {
      const rendered = policyTextFromParsed(source.content.parsed, source.content.documentTitle);
      policySources.push({
        text: rendered.text,
        tables: rendered.tables,
        sourcePath: source.sourcePath,
        ...(source.content.documentTitle !== undefined ? { title: source.content.documentTitle } : {}),
      });
    }
    const experienceDocument = await chunkDocument(source.content.parsed, source.sourceId, source.content.documentTitle);
    experienceDocuments.push(experienceDocument);
    crossDocSources.push({
      sourceId: source.sourceId,
      sourcePath: source.sourcePath,
      text: experienceDocument.units.map((u) => u.content).join('\n'),
    });
    // Report what KIND of information this source carries (rules, obligations, definitions, reference, ...) so a
    // non-rule source is visibly understood as such instead of silently producing nothing. Informational only: it does
    // not gate extraction (v0).
    if (options.knowledgePacks !== false) {
      const packs = options.knowledgePacks ?? BUILT_IN_PACKS;
      const id = identifyDomain(experienceDocument.units.map((u) => u.content).join('\n'), packs);
      const evidence = (id.candidates[0]?.matchedConcepts ?? [])
        .slice(0, 6)
        .map((m) => (m.viaSynonym !== undefined ? `${m.label} (as "${m.viaSynonym}")` : m.label))
        .join(', ');
      qualityDiagnostics.push({
        severity: 'info',
        passName: 'domain-identification',
        code: id.domain === 'unknown' ? 'domain/unknown' : 'domain/identified',
        message:
          id.domain === 'unknown'
            ? `Source "${source.sourceId}": no known domain vocabulary was recognised, so this was compiled with the neutral core grammar alone. Domain-specific terms may be unstructured or mis-structured; review the unresolved rules, or supply a domain profile.`
            : `Source "${source.sourceId}": reads as ${
                id.domain === 'mixed'
                  ? `a mix of ${id.candidates
                      .slice(0, 2)
                      .map((c) => c.packId)
                      .join(' and ')}`
                  : id.domain
              } (confidence ${id.confidence.toFixed(2)}; evidence: ${evidence}). This is advisory: no vocabulary was applied and extraction is unchanged.`,
      });
    }
    const profile = classifyContent(experienceDocument.units.map((u) => u.content));
    const shown = (Object.entries(profile.counts) as [string, number][])
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`)
      .join(', ');
    qualityDiagnostics.push({
      severity: 'info',
      passName: 'document-profile',
      code: profile.normativeCount === 0 ? 'document-profile/no-normative-content' : 'document-profile/summary',
      message: `Source "${source.sourceId}": ${profile.total} sentence(s) classified (${shown || 'none'}); dominant kind: ${profile.dominantKind ?? 'none'}. ${profile.normativeCount === 0 ? 'No normative (rule/obligation/permission/prohibition/procedure) content was found, so no rules are expected from this source; it is preserved as reference knowledge.' : `${profile.normativeCount} normative sentence(s) may yield rules, obligations or procedures.`}`,
    });
    sourceReports.push({
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      sourcePath: source.sourcePath,
      semanticExtractionAvailable: true,
      unitCount: experienceDocument.units.length,
      ...(source.sourceType === 'prompt' ? { sourceClass: 'user_instruction' as const } : {}),
      qualityState: quality.state,
      ...(coverage !== undefined ? { coverage } : {}),
      kindProposals: proposeDocumentKinds(source),
    });
  }

  if (experienceDocuments.length === 0) {
    return err(
      new SourceError(
        ErrorCode.PRECONDITION_FAILED,
        promptReports.some((p) => !p.confirmed)
          ? 'None of the supplied sources could be compiled: prompt source(s) await confirmation (set confirmedBy after reviewing the interpretation) — nothing to compile'
          : promptReports.length > 0 && promptReports.every((p) => p.interpretation.statements.length === 0)
            ? 'None of the supplied sources could be compiled: the prompt source(s) contain no rule-shaped statements (only purpose statements or unrecognised text) — nothing to compile'
            : 'None of the supplied sources have extractable document content — nothing to compile',
        {
          context: { sources: sourceReports, ...(promptReports.length > 0 ? { promptInterpretations: promptReports } : {}) },
        },
      ),
    );
  }

  const mergedPath =
    canonicalSources.length === 1 ? canonicalSources[0]!.sourceId : `multi:${canonicalSources.map((s) => s.sourceId).join('+')}`;
  const merged = mergeExperienceDocuments(experienceDocuments, mergedPath);

  const extractionOptions = {
    ...(options.aiCore !== undefined ? { aiCore: options.aiCore } : {}),
    ...(options.domainHint !== undefined ? { domainHint: options.domainHint } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };

  const knowledge = await extractKnowledgeGraph(merged, extractionOptions);
  const capability = await extractCapabilityGraph(merged, knowledge, extractionOptions);
  let effectiveLexicon = options.lexicon;
  if (effectiveLexicon === undefined && options.autoProfile === true && options.knowledgePacks !== false) {
    const identified = identifyDomain(merged.units.map((u) => u.content).join('\n'), options.knowledgePacks ?? BUILT_IN_PACKS);
    const profile = (options.profiles ?? listDomainProfiles()).find((p) => p.id === identified.domain);
    if (profile !== undefined) {
      effectiveLexicon = profile.lexicon;
      qualityDiagnostics.push({
        severity: 'info',
        passName: 'domain-identification',
        code: 'domain/profile-applied',
        message: `Domain "${identified.domain}" was identified (confidence ${identified.confidence.toFixed(2)}) and its profile was applied because autoProfile was requested; its vocabulary extended the grammar for this compilation only.`,
      });
    }
  }
  const reasoning = await extractReasoningGraph(merged, {
    ...extractionOptions,
    ...(effectiveLexicon !== undefined ? { lexicon: effectiveLexicon } : {}),
    ...(options.focusQuestion !== undefined ? { focusQuestion: options.focusQuestion } : {}),
    ...(options.confirmedRules !== undefined ? { confirmedRules: options.confirmedRules } : {}),
  });

  // M1.1 — additive rule-level capability minting (see
  // `../capabilities/rule-capability-minter.ts`'s doc comment for the
  // full rationale). Runs after both `capability` and `reasoning` exist
  // (minting needs the reasoning graph's per-rule structured conditions,
  // which `extractCapabilityGraph` above never sees) and merely appends
  // to `capability.capabilities` — every existing verb-/title-derived
  // capability from `extractCapabilityGraph` is passed through
  // unchanged, so this can never regress or remove any capability the
  // pipeline already produced.
  // Silent-loss guard: normative sentences with no extracted node are surfaced, never quietly absent.
  const uncovered = uncoveredNormativeSentences(
    merged.units.map((u) => u.content),
    reasoning.nodes.map((n) => ({ texts: [n.canonicalLabel, n.condition ?? '', n.action ?? '', n.outcome ?? ''] })),
  );
  for (const u of uncovered.slice(0, 50)) {
    qualityDiagnostics.push({
      severity: 'info',
      passName: 'coverage',
      code: 'coverage/normative-sentence-not-extracted',
      message: `${/^[aeiou]/i.test(u.kind) ? 'An' : 'A'} ${u.kind} sentence produced no extracted rule or constraint and may have been lost: "${u.sentence.length > 160 ? `${u.sentence.slice(0, 157)}...` : u.sentence}"`,
    });
  }
  if (uncovered.length > 50) {
    qualityDiagnostics.push({
      severity: 'info',
      passName: 'coverage',
      code: 'coverage/normative-sentence-not-extracted',
      message: `${uncovered.length - 50} further normative sentence(s) produced no extracted rule or constraint (first 50 listed individually).`,
    });
  }

  const mintedCapabilities = mintRuleLevelCapabilities(reasoning);
  qualityDiagnostics.push(...nonMandatoryRuleDiagnostics(reasoning));
  const capabilityWithMintedRules =
    mintedCapabilities.length > 0 ? { ...capability, capabilities: [...capability.capabilities, ...mintedCapabilities] } : capability;

  // Policy synthesis must never fail a compilation: a document it cannot read simply yields no tree.
  let policy: PolicyArtifacts | undefined;
  let policyReview: PolicyReview | undefined;
  if (options.policy !== false && policySources.length > 0) {
    try {
      const synthesized = synthesizePolicyArtifacts(policySources, options.policy ?? {});
      policyReview = synthesized.review;
      if (synthesized.trees !== undefined) policy = synthesized;
      else if (
        synthesized.review.unrecognized.some(
          (u) =>
            classifySentenceKind(u.sentence) !== 'reference' &&
            classifySentenceKind(u.sentence) !== 'definition' &&
            classifySentenceKind(u.sentence) !== 'heading',
        )
      ) {
        qualityDiagnostics.push({
          severity: 'info',
          passName: 'policy',
          code: 'policy/no-tree-unrecognized',
          message: `No decision tree was built: ${synthesized.review.unrecognized.length} decision sentence(s) were not recognised by the policy extractor and ${synthesized.review.recognizedSentences} were. The review is kept in policyReview so they are not lost.`,
        });
      }
    } catch (cause) {
      options.logger?.warn('Policy synthesis failed; compiling without decision logic', {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  // The decision logic is also expressed in the graph: escalation / risk / decision / prohibition nodes with their source
  // sentence, and one typed, deterministic capability bound to the tree. Appended after rule-level minting on purpose.
  let reasoningForXoir = reasoning;
  let capabilityForXoir = capabilityWithMintedRules;
  if (policy?.trees?.[0] !== undefined) {
    const known = new Set(reasoning.nodes.map((n) => n.id as string));
    const extra = policyReasoningNodes(policy.program, experienceDocuments).filter((n) => !known.has(n.id as string));
    reasoningForXoir = { ...reasoning, nodes: [...reasoning.nodes, ...extra] };
    capabilityForXoir = {
      ...capabilityWithMintedRules,
      capabilities: [...capabilityWithMintedRules.capabilities, policyCapability(policy.program, policy.trees[0], experienceDocuments)],
    };
  }

  const compileOptions = {
    ...(options.graphId !== undefined ? { graphId: options.graphId } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };

  const compiled = await compileXoir(
    { kind: 'combined', knowledge, capability: capabilityForXoir, reasoning: reasoningForXoir },
    compileOptions,
  );
  if (!compiled.ok) return err(compiled.error);

  // P0.9A area D: attach the per-source quality assessment collected
  // above to the graph's own manifest (never to individual node
  // content — `setManifest` is explicitly documented as never affecting
  // any content hash), so it survives independently of this in-memory
  // `CompileSourcesResult` (e.g. after `packages/xoir/src/serialization.ts`
  // round-trips the graph, or once a Runtime loads it from storage with
  // no access to this call's return value at all).
  //
  // P0.9B, graph identity: this is also the one place `compileSources`
  // finalizes a graph, so it is the correct — and only — place to
  // originate `manifest.graphHash` from the graph's own authoritative,
  // already-existing identity, `XoirGraph.contentHash()` (`@xo/xoir`'s
  // `graph.ts`). No second graph-hashing scheme is introduced here: this
  // is a cached snapshot of the same value `contentHash()` always
  // recomputes, per that field's own doc comment. The manifest is now
  // always set (previously only when source quality was collected),
  // because graph identity is unconditional — a graph compiled from a
  // single trusted source with no quality findings still has an
  // identity worth recording.
  {
    const sourceQuality = sourceQualityByDocumentPath.size > 0 ? Object.fromEntries(sourceQualityByDocumentPath) : undefined;
    const existing = compiled.value.graph.manifest;
    compiled.value.graph.setManifest(
      createManifest({
        schemaVersion: compiled.value.graph.schemaVersion,
        ...(existing?.compilerVersion !== undefined ? { compilerVersion: existing.compilerVersion } : {}),
        ...(existing !== undefined
          ? { professionTags: existing.professionTags, sourceManifestRefs: existing.sourceManifestRefs, passHistory: existing.passHistory }
          : {}),
        graphHash: ContentHash(compiled.value.graph.contentHash()),
        ...(sourceQuality !== undefined ? { sourceQuality } : {}),
        ...(existing?.sourceQuality !== undefined && sourceQuality === undefined ? { sourceQuality: existing.sourceQuality } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      }),
    );
  }

  const unclassified = reasoning.unclassified ?? [];
  const reviewDiagnostics: Diagnostic[] =
    unclassified.length > 0
      ? [
          {
            severity: 'info',
            passName: 'reasoning-coverage',
            code: 'reasoning/unclassified-decision-sentences',
            message: `${unclassified.length} sentence(s) look decision-bearing but matched no rule pattern. They are listed for review and were not turned into rules.`,
          },
        ]
      : [];

  const executionReadiness = analyzeExecutionReadiness(compiled.value.graph, options.connectors ?? []);
  {
    const cap = executionReadiness.capabilities;
    if (cap.summary.external_integration_required > 0) {
      qualityDiagnostics.push({
        severity: 'info',
        passName: 'execution-readiness',
        code: 'execution-readiness/integration-required',
        message: `${cap.summary.external_integration_required} declared operation(s) need an external integration and have no connector bound (${cap.entries
          .filter((e) => e.executionState === 'external_integration_required')
          .map((e) => e.name)
          .slice(0, 8)
          .join(', ')}).`,
      });
    }
    for (const u of cap.unmatchedConnectorOperations) {
      qualityDiagnostics.push({
        severity: 'warning',
        passName: 'execution-readiness',
        code: 'execution-readiness/connector-unknown-operation',
        message: `Connector "${u.connectorId}" declares operation "${u.operation}", which no source declares; it was not bound to anything.`,
      });
    }
  }
  let aiCandidates: readonly CandidateRunResult[] | undefined;
  if (options.candidateProvider !== undefined) {
    const sentenceOf = (needle: string): string | undefined => {
      const n = needle.toLowerCase().replace(/\s+/g, ' ').trim();
      for (const src of crossDocSources)
        for (const line of src.text.split(/\r?\n/))
          for (const sn of splitSentences(line)) if (sn.text.toLowerCase().replace(/\s+/g, ' ').includes(n)) return sn.text.trim();
      return undefined;
    };
    const targets = new Map<string, { sentence: string }>();
    for (const u of uncovered.slice(0, 20)) targets.set(u.sentence, { sentence: u.sentence });
    for (const e of executionReadiness.entries) {
      if (e.compilerState !== 'unresolved' || e.condition === undefined) continue;
      const sn = sentenceOf(e.condition);
      if (sn !== undefined) targets.set(sn, { sentence: sn });
      if (targets.size >= 20) break;
    }
    aiCandidates = await runCandidateProvider(options.candidateProvider, [...targets.values()], {
      ...(effectiveLexicon !== undefined ? { lexicon: effectiveLexicon } : {}),
    });
    const all = aiCandidates.flatMap((r) => r.results);
    qualityDiagnostics.push({
      severity: 'info',
      passName: 'ai-assist',
      code: 'ai-assist/candidates',
      message: `Model assistance was requested for ${aiCandidates.length} unresolved sentence(s): ${all.filter((x) => x.validation.status === 'validated').length} candidate(s) passed deterministic validation, ${all.filter((x) => x.validation.status === 'rejected').length} were rejected, ${aiCandidates.filter((r) => r.error !== undefined).length} provider error(s). Nothing was merged into the graph; validated candidates need human confirmation.`,
    });
  }
  const crossDocument = analyzeCrossDocument(compiled.value.graph, crossDocSources, options.precedence);
  for (const c of crossDocument.conflicts) {
    const resolved = c.resolution.status === 'resolved-by-precedence';
    qualityDiagnostics.push({
      severity: resolved ? 'info' : 'warning',
      passName: 'cross-document',
      code: resolved ? 'crossdoc/conflict-resolved' : 'crossdoc/conflict',
      message: `${c.kind === 'identical-condition' ? 'Conflicting rules' : 'Potentially conflicting rules'} (${c.scope}${c.field !== undefined ? `, field "${c.field}"` : ''}): "${c.a.label}" [${c.a.outcomeType}, ${c.a.sourcePath}] vs "${c.b.label}" [${c.b.outcomeType}, ${c.b.sourcePath}]. ${c.resolution.status === 'resolved-by-precedence' ? `Resolved by the supplied precedence order: ${c.resolution.winner} outranks ${c.resolution.loser}.` : 'No precedence policy resolves this; it needs a decision.'}`,
    });
  }
  for (const a of crossDocument.amendments) {
    qualityDiagnostics.push({
      severity: 'info',
      passName: 'cross-document',
      code: 'crossdoc/amendment',
      message: `Amendment/supersession wording ("${a.cue}"${a.effectiveDate !== undefined ? `, effective ${a.effectiveDate}` : ''}) in ${a.sourcePath}: "${a.sentence.length > 160 ? `${a.sentence.slice(0, 157)}...` : a.sentence}". Which rules it affects is not resolved automatically.`,
    });
  }
  {
    const { byCompilerState: cs, byExecutionState: es } = executionReadiness.summary;
    qualityDiagnostics.push({
      severity: 'info',
      passName: 'execution-readiness',
      code: 'execution-readiness/summary',
      message: `Rules by compiler state: ${cs.resolved} resolved, ${cs.partially_resolved} partially resolved, ${cs.unresolved} unresolved. By execution state: ${es.deterministic} deterministic, ${es.human_required} human-required, ${es.not_executable} not executable (each with its blockers in executionReadiness).`,
    });
  }
  return ok({
    ...compiled.value,
    diagnostics: [...qualityDiagnostics, ...reviewDiagnostics, ...compiled.value.diagnostics],
    sources: sourceReports.map((r) => (ledgers.has(r.sourcePath) ? { ...r, recovery: ledgers.get(r.sourcePath)! } : r)),
    unclassified,
    executionReadiness,
    crossDocument,
    ...(aiCandidates !== undefined ? { aiCandidates } : {}),
    ...(policyReview !== undefined ? { policyReview } : {}),
    reviewQueue: buildReviewQueue(executionReadiness, [...qualityDiagnostics, ...reviewDiagnostics, ...compiled.value.diagnostics], {
      crossDocument,
      ...(aiCandidates !== undefined ? { aiCandidates } : {}),
      ...(options.knowledgePacks !== false
        ? {
            retriever: new HybridRetriever([
              new StructuredLookupRetriever(options.knowledgePacks ?? BUILT_IN_PACKS),
              new Bm25Retriever(options.knowledgePacks ?? BUILT_IN_PACKS),
            ]),
            domainUnknown: qualityDiagnostics.some((d) => d.code === 'domain/unknown'),
          }
        : {}),
    }),
    ...(promptReports.length > 0 ? { promptInterpretations: promptReports } : {}),
    ...(policy !== undefined ? { policy } : {}),
  });
}

/** Single-source convenience wrapper over `compileSources` — the common case (one PDF, one HTML page, ...) without the caller needing to think about the array/merge machinery at all. */
export async function compileSource(input: unknown, options: CompileSourcesOptions = {}): Promise<Result<CompileSourcesResult, XoError>> {
  return compileSources([input], options);
}
