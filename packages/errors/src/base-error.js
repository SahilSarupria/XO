/**
 * Base class for every error raised by the platform's own code. Third-party
 * / unexpected errors should be caught and wrapped (via `cause`), not
 * re-thrown bare, so every error surfaced to a caller carries a stable
 * `code` from {@link ErrorCode}.
 */
export class XoError extends Error {
    code;
    context;
    constructor(code, message, options = {}) {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = new.target.name;
        this.code = code;
        this.context = options.context ?? {};
        Error.captureStackTrace?.(this, new.target);
    }
    /** JSON-safe representation, suitable for structured logging or an API error body. */
    toJSON() {
        return { name: this.name, code: this.code, message: this.message, context: this.context };
    }
}
//# sourceMappingURL=base-error.js.map