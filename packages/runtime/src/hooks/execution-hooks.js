/**
 * Invokes `hook` (if defined) with `args`, swallowing (and, if `logger`
 * is given, logging) anything it throws or rejects with. A hook is an
 * observer, not a pipeline stage — its failure must never fail or alter
 * the execution it's observing.
 */
export async function runHook(hook, args, onHookError) {
    if (!hook)
        return;
    try {
        await hook(...args);
    }
    catch (error) {
        onHookError?.(error);
    }
}
//# sourceMappingURL=execution-hooks.js.map