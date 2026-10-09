import type { ParsedDocument } from '../document/types.js';

/**
 * The set of source families this package's frontends currently know
 * about (Stage 8 §3). Deliberately a closed union rather than an open
 * `string` — unlike `SemanticType`/`RelationType` (which model
 * profession-specific vocabulary and are legitimately open-ended), a
 * source *family* is an architectural concept this package's registry
 * and pipeline integration switch on, so adding one is a real code
 * change (a new frontend module), not free-form data. Future families
 * (audio, video, api, database — Stage 8 §3) are added the same way
 * `'structured'` was: a new literal here, plus a new frontend module,
 * with zero change to `document/`, `semantic/`, `knowledge/`,
 * `capabilities/`, `reasoning/`, or `xoir/`.
 */
export type SourceType = 'pdf' | 'document' | 'image' | 'html' | 'structured' | 'openapi';

/**
 * A source whose content has been (or can be) normalized into the same
 * structural shape Stage 2's PDF pipeline already produces —
 * `ParsedDocument` (`../document/types.ts`). This is what lets `pdf`,
 * `document`, `html`, and `structured` frontends all terminate at the
 * exact same downstream entry point (`chunkDocument`,
 * `../semantic/semantic-chunker.ts`) without Stage 3 ever branching on
 * source type — see `document-frontend.ts`, `html-frontend.ts`, and
 * `structured-frontend.ts`, which all build `ParsedDocument` directly
 * via `../document/section-builder.ts#buildSections` rather than
 * reimplementing Stage 3.
 */
export interface DocumentSourceContent {
  readonly kind: 'document';
  readonly parsed: ParsedDocument;
  readonly documentTitle: string | undefined;
  /** Best-effort flattened text of the whole source — never fed back into the pipeline itself (that's what `parsed` is for), only useful for logging, hashing, and debugging. */
  readonly plainText: string;
}

/**
 * A source whose bytes are represented and described, but for which no
 * frontend in this package can currently produce meaningful `Concept`/
 * `Heuristic`/... content — an image with no vision/OCR processor wired
 * up (Stage 8 §8, §22). This is a first-class, honest outcome, not an
 * error: the source is still real, still hashed, still carries
 * provenance, and a *future* frontend/processor can upgrade it to
 * `DocumentSourceContent` without any change to this type or to the
 * registry that produced it.
 */
export interface BinarySourceContent {
  readonly kind: 'binary';
  readonly mimeType: string;
  readonly byteLength: number;
  /** Only populated when the frontend could establish it deterministically from the bytes themselves (e.g. a PNG/GIF header) — never guessed. */
  readonly dimensions?: { readonly width: number; readonly height: number };
}

export type SourceContent = DocumentSourceContent | BinarySourceContent;

/**
 * The Stage 8 "canonical source representation" — the boundary artifact
 * every `SourceFrontend` (`frontend.ts`) produces and the only thing the
 * rest of the compiler (Stage 1-7, unchanged) is ever handed. Nothing
 * downstream of this type needs to know "this came from a PDF" unless
 * that fact is legitimately provenance (§12) — it's carried in
 * `sourceType`/`metadata` for exactly that reason, not because any
 * extraction stage branches on it.
 */
export interface CanonicalSource {
  /** Deterministic, content-derived identifier (see `source-id.ts`) — never random, never wall-clock-derived (Stage 8 §13). Doubles as the `documentPath` handed to `chunkDocument` for sources with document content, which is what keeps multi-source `ExperienceUnit` ids collision-free (`compile-sources.ts`). */
  readonly sourceId: string;
  readonly sourceType: SourceType;
  /** Human-facing origin identifier — a file name, a URL, a caller-supplied label. Not required to be unique; `sourceId` is what identity/provenance actually key on. */
  readonly sourcePath: string;
  readonly content: SourceContent;
  readonly metadata: Readonly<Record<string, string>>;
  /**
   * True iff `content.kind === 'document'` — i.e. this source can be
   * handed to `chunkDocument` and the rest of the existing extraction
   * pipeline. Stage 8 §22 requires this distinction be explicit rather
   * than implied: a caller (or `compile-sources.ts`) branches on this
   * field instead of re-deriving it from `content.kind` everywhere.
   */
  readonly semanticExtractionAvailable: boolean;
}
