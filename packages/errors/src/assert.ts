import { XoError } from './base-error.js';
import { ErrorCode } from './error-codes.js';

/**
 * Asserts an invariant that should be impossible to violate if the rest of
 * the codebase is correct. Use this for programmer errors; use `Result`
 * (from @xo/types) for expected, recoverable failures. Throwing here is
 * intentional — an invariant violation is a bug, not a normal control-flow
 * outcome a caller should be forced to branch on.
 */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new XoError(ErrorCode.PRECONDITION_FAILED, `Assertion failed: ${message}`);
  }
}

/** Exhaustiveness check for switch statements over closed unions. */
export function assertUnreachable(value: never, context = 'value'): never {
  throw new XoError(ErrorCode.PRECONDITION_FAILED, `Unreachable ${context}: ${JSON.stringify(value)}`);
}
