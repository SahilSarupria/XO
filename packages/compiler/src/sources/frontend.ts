import type { Result } from '@xo/types';
import type { SourceError } from '@xo/errors';
import type { Logger } from '@xo/logger';
import type { CanonicalSource, SourceType } from './types.js';

export interface SourceIngestContext {
  /** Injected clock, threaded through to anything that needs a timestamp (currently nothing does — `sourceId` is content-derived, never wall-clock-derived, per Stage 8 §13 — but this keeps the contract consistent with `CompileXoirOptions.now` elsewhere in this package). */
  readonly now?: () => string;
  readonly logger?: Logger;
}

/**
 * The Stage 8 §4 source-adapter contract. `TInput` is intentionally
 * generic per-frontend (a PDF frontend's input shape has nothing in
 * common with a structured-data frontend's) rather than one giant
 * discriminated union every frontend must partially match — `canHandle`
 * is what lets `SourceFrontendRegistry.detect` (`registry.ts`) probe an
 * arbitrary `unknown` input against every registered frontend safely.
 *
 * Implementations MUST be deterministic: the same `input` must always
 * `ingest` to a `CanonicalSource` with the same `sourceId` and the same
 * `content` (Stage 8 §13). None of this package's frontends read the
 * network, the wall clock, or `Math.random()` during `ingest`.
 */
export interface SourceFrontend<TInput = unknown> {
  readonly sourceType: SourceType;

  /** A type guard so `SourceFrontendRegistry.detect` can narrow `unknown` input to `TInput` before calling `ingest`. MUST be a pure, cheap check (a discriminant tag, a magic-byte sniff) — never attempt a full parse here, that's `ingest`'s job. */
  canHandle(input: unknown): input is TInput;

  /** Normalize `input` into a `CanonicalSource`. Returns `err` (never throws) for malformed/invalid input — see `../../SPECIFICATION.md`-style `Result` conventions used throughout this repo — with a `SourceError` (`@xo/errors`) carrying a reused generic `ErrorCode` (see `SourceError`'s own doc comment for why no new `SOURCE_*` codes were minted). */
  ingest(input: TInput, context?: SourceIngestContext): Result<CanonicalSource, SourceError>;
}
