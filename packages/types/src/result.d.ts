/**
 * A discriminated-union Result type. Every fallible operation in the
 * foundation layer returns a Result instead of throwing, so callers are
 * forced by the type system to handle the failure path. Throwing is
 * reserved for programmer errors (see @xo/errors' `assert`), never for
 * expected failure modes like "package not found" or "signature invalid".
 */
export type Result<T, E = Error> = Readonly<{
    ok: true;
    value: T;
}> | Readonly<{
    ok: false;
    error: E;
}>;
export declare function ok<T>(value: T): Result<T, never>;
export declare function err<E>(error: E): Result<never, E>;
export declare function isOk<T, E>(result: Result<T, E>): result is {
    ok: true;
    value: T;
};
export declare function isErr<T, E>(result: Result<T, E>): result is {
    ok: false;
    error: E;
};
/** Unwraps a Result, throwing `error` (or a generic Error) on failure. Use only at process boundaries (CLI entrypoints, HTTP handlers). */
export declare function unwrap<T, E>(result: Result<T, E>): T;
export declare function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E>;
export declare function fromPromise<T>(promise: Promise<T>): Promise<Result<T, Error>>;
//# sourceMappingURL=result.d.ts.map