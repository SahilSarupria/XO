/**
 * An in-process, per-key serialization queue — NOT distributed locking
 * (per the milestone brief's explicit "do not introduce distributed
 * locking or a database transaction system" instruction). This is
 * enough to make two concurrent `POST .../resolve` calls for the SAME
 * executionId, arriving at the SAME running server process, provably
 * never both observe `humanTask.status === 'pending'` and both proceed
 * to write — the second caller's `fn` only starts after the first's has
 * fully finished (including its store write), so `FsExecutionStore.resolveHumanTask`'s
 * own read-then-write is safe under this wrapper even though the store
 * method alone has a TOCTOU gap (see that method's doc comment).
 *
 * Deliberately does NOT protect against two concurrent requests hitting
 * two DIFFERENT server processes/replicas sharing the same
 * `workspaceDataDir` — that would require real distributed locking,
 * explicitly out of scope. In this milestone's single-process
 * deployment shape (matching every other P0 milestone's assumptions),
 * that's the correct, narrowest-safe boundary, not an oversight.
 */
const chains = new Map<string, Promise<unknown>>();

export function withExecutionLock<T>(executionId: string, fn: () => Promise<T>): Promise<T> {
  const prior = chains.get(executionId) ?? Promise.resolve();
  const result = prior.then(fn, fn);
  // Keep the chain alive for the next caller regardless of whether this
  // call succeeded or threw — but swallow the rejection here so it
  // doesn't become an unhandled-rejection warning; the real rejection
  // still propagates to THIS call's own caller via `result` itself.
  chains.set(
    executionId,
    result.catch(() => undefined),
  );
  return result;
}
