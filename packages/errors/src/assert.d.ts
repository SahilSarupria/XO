/**
 * Asserts an invariant that should be impossible to violate if the rest of
 * the codebase is correct. Use this for programmer errors; use `Result`
 * (from @xo/types) for expected, recoverable failures. Throwing here is
 * intentional — an invariant violation is a bug, not a normal control-flow
 * outcome a caller should be forced to branch on.
 */
export declare function assert(condition: unknown, message: string): asserts condition;
/** Exhaustiveness check for switch statements over closed unions. */
export declare function assertUnreachable(value: never, context?: string): never;
//# sourceMappingURL=assert.d.ts.map