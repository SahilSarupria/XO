import { ErrorCode, PdfError } from '@xo/errors';

/**
 * Resource limits for reading one PDF. Every bound exists so hostile or corrupt input produces a bounded, reported
 * failure (a page that stays `unaccounted`, or a document-level `PdfError`) and never an unbounded allocation, an
 * unbounded loop or a stack overflow. Defaults are generous for real insurance documents (multi-hundred-page wordings,
 * a few MiB per content stream) and still stop a decompression bomb or a pathological structure in well under a second.
 */
export interface PdfLimits {
  /** Largest single decoded stream. Default 64 MiB. */
  readonly maxStreamBytes: number;
  /** Total bytes ever decoded for one document (all streams, all filters). Default 512 MiB. */
  readonly maxDocumentDecodedBytes: number;
  /** A stream that inflates beyond `ratioFloorBytes` is rejected if output/input exceeds this. Default 1000. */
  readonly maxInflateRatio: number;
  /** The ratio check applies only above this decoded size, so small, highly repetitive streams are never penalised. Default 1 MiB. */
  readonly ratioFloorBytes: number;
  /** Nesting depth of arrays/dictionaries when parsing one object. Default 64. */
  readonly maxObjectNesting: number;
  /** Depth of the page tree, and of an xref `/Prev` chain. Default 128. */
  readonly maxTreeDepth: number;
  /** Pages read from one document. Pages past this are reported as unaccounted failures, not dropped. Default 100_000. */
  readonly maxPages: number;
  /** Largest input file. Default 1 GiB. */
  readonly maxFileBytes: number;
}

export const DEFAULT_PDF_LIMITS: PdfLimits = {
  maxStreamBytes: 64 * 1024 * 1024,
  maxDocumentDecodedBytes: 512 * 1024 * 1024,
  maxInflateRatio: 1000,
  ratioFloorBytes: 1024 * 1024,
  maxObjectNesting: 64,
  maxTreeDepth: 128,
  maxPages: 100_000,
  maxFileBytes: 1024 * 1024 * 1024,
};

export function resolveLimits(overrides?: Partial<PdfLimits>): PdfLimits {
  return { ...DEFAULT_PDF_LIMITS, ...overrides };
}

/** Failure code carried on a page's `loadFailure` when a resource limit stopped it. */
export const RESOURCE_LIMIT_CODE = 'PDF_RESOURCE_LIMIT';
/** Failure code carried on a page that was not read because the caller aborted or the deadline passed. */
export const ABORTED_CODE = 'PDF_ABORTED';

/** A `PdfError` raised because a bound in `PdfLimits` was hit. Distinguishable so callers can report "too big / hostile" instead of "corrupt". */
export class PdfResourceLimitError extends PdfError {
  constructor(
    readonly limit: keyof PdfLimits,
    message: string,
  ) {
    super(ErrorCode.PDF_MALFORMED, `resource limit (${limit}): ${message}`);
  }
}

/** A read was cancelled (AbortSignal) or ran past its deadline. */
export class PdfAbortedError extends PdfError {
  constructor(message: string) {
    super(ErrorCode.PDF_MALFORMED, message);
  }
}

export interface Cancellation {
  readonly signal?: AbortSignal | undefined;
  /** Absolute `Date.now()` deadline in ms. */
  readonly deadlineMs?: number | undefined;
}

export function throwIfCancelled(c: Cancellation | undefined): void {
  if (c === undefined) return;
  if (c.signal?.aborted === true) throw new PdfAbortedError('read aborted by caller');
  if (c.deadlineMs !== undefined && Date.now() > c.deadlineMs) throw new PdfAbortedError('document read time limit exceeded');
}

/** Tracks decoded bytes across every stream of one document so many individually-legal streams cannot add up to a bomb. */
export class ResourceMeter {
  private decoded = 0;
  constructor(readonly limits: PdfLimits) {}

  /** Largest output a single decode may produce right now. */
  allowance(): number {
    return Math.max(0, Math.min(this.limits.maxStreamBytes, this.limits.maxDocumentDecodedBytes - this.decoded));
  }

  charge(bytes: number): void {
    this.decoded += bytes;
    if (this.decoded > this.limits.maxDocumentDecodedBytes) {
      throw new PdfResourceLimitError('maxDocumentDecodedBytes', `document decoded more than ${this.limits.maxDocumentDecodedBytes} bytes`);
    }
  }

  get decodedBytes(): number {
    return this.decoded;
  }
}
