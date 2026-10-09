/**
 * A discriminated-union Result type. Every fallible operation in the
 * foundation layer returns a Result instead of throwing, so callers are
 * forced by the type system to handle the failure path. Throwing is
 * reserved for programmer errors (see @xo/errors' `assert`), never for
 * expected failure modes like "package not found" or "signature invalid".
 */
export type Result<T, E = Error> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: E }>;

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return !result.ok;
}

/** Unwraps a Result, throwing `error` (or a generic Error) on failure. Use only at process boundaries (CLI entrypoints, HTTP handlers). */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw result.error instanceof Error ? result.error : new Error(String(result.error));
}

export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

export async function fromPromise<T>(promise: Promise<T>): Promise<Result<T, Error>> {
  try {
    return ok(await promise);
  } catch (cause) {
    return err(cause instanceof Error ? cause : new Error(String(cause)));
  }
}
