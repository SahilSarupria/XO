/**
 * Structured, JSON-safe discovery errors.
 *
 * Deliberately a plain data shape rather than a subclass of `@xo/errors`'
 * `XoError`: that package's `ErrorCode` list is shared, append-only
 * platform contract owned by another workstream, and this package must not
 * edit it. Codes here are prefixed `EI_` and are append-only for the same
 * reason. Discovery returns these inside `Result.err` (docs/CODING_STANDARDS.md:
 * expected failures are values, not exceptions) or inside an outcome's
 * `errors[]` for partial results.
 *
 * `context` must never carry credentials, file contents, or raw
 * untrusted strings longer than a short, sanitized excerpt.
 */
export const DiscoveryErrorCode = {
  /** Requested path/resource lies outside the explicitly authorized scope. */
  SCOPE_VIOLATION: 'EI_SCOPE_VIOLATION',
  /** Scope itself is unusable (not absolute, is a filesystem root, missing, not a directory). */
  INVALID_SCOPE: 'EI_INVALID_SCOPE',
  /** No authorization decision permits this yet (nothing was read). */
  AUTHORIZATION_REQUIRED: 'EI_AUTHORIZATION_REQUIRED',
  /** Authorization was explicitly refused (nothing was read). */
  AUTHORIZATION_DENIED: 'EI_AUTHORIZATION_DENIED',
  /** No connector exists for this source type. */
  UNSUPPORTED_SOURCE: 'EI_UNSUPPORTED_SOURCE',
  /** The connector exists but does not implement this operation. */
  UNSUPPORTED_OPERATION: 'EI_UNSUPPORTED_OPERATION',
  /** Connection could not be established/validated. */
  CONNECTION_FAILED: 'EI_CONNECTION_FAILED',
  /** Source was reachable before but is not now (removed, offline). */
  SOURCE_UNAVAILABLE: 'EI_SOURCE_UNAVAILABLE',
  /** A configured limit (depth, entries, bytes, time) stopped the work. */
  LIMIT_EXCEEDED: 'EI_LIMIT_EXCEEDED',
  /** Input was malformed or unsafe (bad name, undecodable content, bad request). */
  MALFORMED_INPUT: 'EI_MALFORMED_INPUT',
  /** Caller cancelled via AbortSignal. */
  CANCELLED: 'EI_CANCELLED',
  /** An illegal source-state transition was attempted. */
  INVALID_TRANSITION: 'EI_INVALID_TRANSITION',
  /** Unexpected internal failure (wrapped, never leaked raw). */
  INTERNAL: 'EI_INTERNAL',
} as const;

export type DiscoveryErrorCode = (typeof DiscoveryErrorCode)[keyof typeof DiscoveryErrorCode];

export interface DiscoveryError {
  readonly code: DiscoveryErrorCode;
  readonly message: string;
  /** Whether retrying the same request unchanged could plausibly succeed. */
  readonly retryable: boolean;
  readonly context: Readonly<Record<string, string | number | boolean | null>>;
}

const RETRYABLE: ReadonlySet<DiscoveryErrorCode> = new Set([
  DiscoveryErrorCode.CONNECTION_FAILED,
  DiscoveryErrorCode.SOURCE_UNAVAILABLE,
  DiscoveryErrorCode.CANCELLED,
  DiscoveryErrorCode.INTERNAL,
]);

export function discoveryError(
  code: DiscoveryErrorCode,
  message: string,
  context: Readonly<Record<string, string | number | boolean | null>> = {},
): DiscoveryError {
  return Object.freeze({ code, message, retryable: RETRYABLE.has(code), context: Object.freeze({ ...context }) });
}

/** Wraps an unexpected thrown value without leaking its message verbatim (it may embed paths or content). */
export function internalError(cause: unknown, where: string): DiscoveryError {
  const name = cause instanceof Error ? cause.name : typeof cause;
  const errnoCode =
    typeof cause === 'object' && cause !== null && 'code' in cause && typeof (cause as { code: unknown }).code === 'string'
      ? (cause as { code: string }).code
      : null;
  return discoveryError(DiscoveryErrorCode.INTERNAL, `unexpected failure in ${where}`, { where, errorName: name, errno: errnoCode });
}
