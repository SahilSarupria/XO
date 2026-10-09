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
export declare class XoError extends Error {
    readonly code: ErrorCode;
    readonly context: Readonly<Record<string, unknown>>;
    constructor(code: ErrorCode, message: string, options?: XoErrorOptions);
    /** JSON-safe representation, suitable for structured logging or an API error body. */
    toJSON(): Readonly<{
        name: string;
        code: ErrorCode;
        message: string;
        context: Readonly<Record<string, unknown>>;
    }>;
}
//# sourceMappingURL=base-error.d.ts.map