export function ok(value) {
    return { ok: true, value };
}
export function err(error) {
    return { ok: false, error };
}
export function isOk(result) {
    return result.ok;
}
export function isErr(result) {
    return !result.ok;
}
/** Unwraps a Result, throwing `error` (or a generic Error) on failure. Use only at process boundaries (CLI entrypoints, HTTP handlers). */
export function unwrap(result) {
    if (result.ok)
        return result.value;
    throw result.error instanceof Error ? result.error : new Error(String(result.error));
}
export function mapResult(result, fn) {
    return result.ok ? ok(fn(result.value)) : result;
}
export async function fromPromise(promise) {
    try {
        return ok(await promise);
    }
    catch (cause) {
        return err(cause instanceof Error ? cause : new Error(String(cause)));
    }
}
//# sourceMappingURL=result.js.map