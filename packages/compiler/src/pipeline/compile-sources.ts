import { err, ok, ContentHash, type Result } from '@xo/types';
import { ErrorCode, SourceError, type XoError } from '@xo/errors';
import type { Logger } from '@xo/logger';
import type { Diagnostic } from '@xo/xoir';
import { createManifest, type SourceQualityInfo } from '@xo/xoir';
import { chunkDocument } from '../semantic/semantic-chunker.js';
import type { ExperienceDocument } from '../semantic/types.js';
import { assessDocumentQuality, type SourceQualityState } from '../document/document-quality.js';
import { extractKnowledgeGraph, type KnowledgeExtractionOptions } from '../knowledge/knowledge-extractor.js';
import { extractCapabilityGraph, type CapabilityExtractionOptions } from '../capabilities/capability-extractor.js';
import { mintRuleLevelCapabilities } from '../capabilities/rule-capability-minter.js';
import { extractReasoningGraph, type ReasoningExtractionOptions } from '../reasoning/reasoning-extractor.js';
import { compileXoir } from './compile.js';
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
   * - `'trusted'` / `'degraded'`: semantic extraction ran normally; a
   *   `'degraded'` source additionally carries per-token findings in
   *   `CompileSourcesResult.diagnostics`.
   * - `'blocked'`: semantic extraction was **not** run for this source
   *   (`unitCount` is `0`) — the compiler declined to treat its
   *   extracted text as trustworthy input rather than silently
   *   promoting corrupted tokens into capability/knowledge candidates.
   */
  readonly qualityState?: SourceQualityState;
}

export interface CompileSourcesResult extends CompiledXoirResult {
  /** One entry per input, in input order — always present even for inputs that contributed zero units, so a caller can see exactly what happened to every source it submitted (Stage 8 §14's "must not silently pass through"). */
  readonly sources: readonly SourceCompilationReport[];
}

export interface CompileSourcesOptions {
  readonly registry?: SourceFrontendRegistry;
  readonly graphId?: string;
  readonly now?: () => string;
  readonly logger?: Logger;
  readonly aiCore?: KnowledgeExtractionOptions['aiCore'] & CapabilityExtractionOptions['aiCore'] & ReasoningExtractionOptions['aiCore'];
  readonly domainHint?: string;
  readonly focusQuestion?: string;
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
export async function compileSources(inputs: readonly unknown[], options: CompileSourcesOptions = {}): Promise<Result<CompileSourcesResult, XoError>> {
  if (inputs.length === 0) {
    return err(new SourceError(ErrorCode.INVALID_ARGUMENT, 'compileSources requires at least one input'));
  }

  const registry = options.registry ?? createDefaultSourceFrontendRegistry();
  const ingestContext = options.now !== undefined || options.logger !== undefined ? { ...(options.now !== undefined ? { now: options.now } : {}), ...(options.logger !== undefined ? { logger: options.logger } : {}) } : undefined;

  const canonicalSources: CanonicalSource[] = [];
  for (const input of inputs) {
    const ingested = registry.ingest(input, ingestContext);
    if (!ingested.ok) return err(ingested.error);
    canonicalSources.push(ingested.value);
  }

  const experienceDocuments: ExperienceDocument[] = [];
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

  for (const source of canonicalSources) {
    if (source.content.kind !== 'document') {
      sourceReports.push({ sourceId: source.sourceId, sourceType: source.sourceType, sourcePath: source.sourcePath, semanticExtractionAvailable: false, unitCount: 0 });
      options.logger?.info('Source has no semantic extraction available; it will not contribute XOIR content', { sourceId: source.sourceId, sourceType: source.sourceType });
      continue;
    }

    const quality = assessDocumentQuality(source.content.parsed, source.sourceId);
    qualityDiagnostics.push(...quality.diagnostics);
    sourceQualityByDocumentPath.set(source.sourceId, { state: quality.state, suspiciousTokenRatio: quality.suspiciousTokenRatio });

    if (quality.state === 'blocked') {
      sourceReports.push({
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        sourcePath: source.sourcePath,
        semanticExtractionAvailable: true,
        unitCount: 0,
        qualityState: quality.state,
      });
      options.logger?.warn('Source quality check blocked semantic extraction — extracted text was not trustworthy enough to feed into semantic extraction', {
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        suspiciousTokenRatio: quality.suspiciousTokenRatio,
      });
      continue;
    }

    const experienceDocument = await chunkDocument(source.content.parsed, source.sourceId, source.content.documentTitle);
    experienceDocuments.push(experienceDocument);
    sourceReports.push({
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      sourcePath: source.sourcePath,
      semanticExtractionAvailable: true,
      unitCount: experienceDocument.units.length,
      qualityState: quality.state,
    });
  }

  if (experienceDocuments.length === 0) {
    return err(
      new SourceError(ErrorCode.PRECONDITION_FAILED, 'None of the supplied sources have extractable document content — nothing to compile', {
        context: { sources: sourceReports },
      }),
    );
  }

  const mergedPath = canonicalSources.length === 1 ? canonicalSources[0]!.sourceId : `multi:${canonicalSources.map((s) => s.sourceId).join('+')}`;
  const merged = mergeExperienceDocuments(experienceDocuments, mergedPath);

  const extractionOptions = {
    ...(options.aiCore !== undefined ? { aiCore: options.aiCore } : {}),
    ...(options.domainHint !== undefined ? { domainHint: options.domainHint } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };

  const knowledge = await extractKnowledgeGraph(merged, extractionOptions);
  const capability = await extractCapabilityGraph(merged, knowledge, extractionOptions);
  const reasoning = await extractReasoningGraph(merged, { ...extractionOptions, ...(options.focusQuestion !== undefined ? { focusQuestion: options.focusQuestion } : {}) });

  // M1.1 — additive rule-level capability minting (see
  // `../capabilities/rule-capability-minter.ts`'s doc comment for the
  // full rationale). Runs after both `capability` and `reasoning` exist
  // (minting needs the reasoning graph's per-rule structured conditions,
  // which `extractCapabilityGraph` above never sees) and merely appends
  // to `capability.capabilities` — every existing verb-/title-derived
  // capability from `extractCapabilityGraph` is passed through
  // unchanged, so this can never regress or remove any capability the
  // pipeline already produced.
  const mintedCapabilities = mintRuleLevelCapabilities(reasoning);
  const capabilityWithMintedRules = mintedCapabilities.length > 0 ? { ...capability, capabilities: [...capability.capabilities, ...mintedCapabilities] } : capability;

  const compileOptions = {
    ...(options.graphId !== undefined ? { graphId: options.graphId } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };

  const compiled = await compileXoir({ kind: 'combined', knowledge, capability: capabilityWithMintedRules, reasoning }, compileOptions);
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
        ...(existing !== undefined ? { professionTags: existing.professionTags, sourceManifestRefs: existing.sourceManifestRefs, passHistory: existing.passHistory } : {}),
        graphHash: ContentHash(compiled.value.graph.contentHash()),
        ...(sourceQuality !== undefined ? { sourceQuality } : {}),
        ...(existing?.sourceQuality !== undefined && sourceQuality === undefined ? { sourceQuality: existing.sourceQuality } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      }),
    );
  }

  return ok({ ...compiled.value, diagnostics: [...qualityDiagnostics, ...compiled.value.diagnostics], sources: sourceReports });
}

/** Single-source convenience wrapper over `compileSources` — the common case (one PDF, one HTML page, ...) without the caller needing to think about the array/merge machinery at all. */
export async function compileSource(input: unknown, options: CompileSourcesOptions = {}): Promise<Result<CompileSourcesResult, XoError>> {
  return compileSources([input], options);
}
