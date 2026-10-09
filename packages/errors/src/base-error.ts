import type { ErrorCode } from './error-codes.js';

export interface XoErrorOptions {
  readonly cause?: unknown;
  readonly context?: Readonly<Record<string, unknown>>;
}

/**
 * Base class for every error raised by the platform's own code. Third-party
 * / unexpected errors should be caught and wrapped (via `cause`), not
 * re-thrown bare, so every error surfaced to a caller carries a stable
 * `code` from {@link ErrorCode}.
 */
export class XoError extends Error {
  public readonly code: ErrorCode;
  public readonly context: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, message: string, options: XoErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.context = options.context ?? {};
    Error.captureStackTrace?.(this, new.target);
  }

  /** JSON-safe representation, suitable for structured logging or an API error body. */
  toJSON(): Readonly<{ name: string; code: ErrorCode; message: string; context: Readonly<Record<string, unknown>> }> {
    return { name: this.name, code: this.code, message: this.message, context: this.context };
  }
}
