import type { ExecutionId, AttemptId } from '../ids.js';
import { AttemptId as AttemptIdBrand } from '../ids.js';

/**
 * R6. Pure, deterministic derivation of one attempt's id from its
 * logical execution's id and a 1-indexed attempt number — no clock, no
 * randomness, mirroring `deriveExecutionId`'s own determinism (see that
 * file's doc comment). `attemptNumber` must be a positive integer;
 * attempt numbering always starts at 1, never 0, so "attempt 1" reads
 * unambiguously in logs/receipts without an off-by-one footnote.
 */
export function deriveAttemptId(executionId: ExecutionId, attemptNumber: number): AttemptId {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new RangeError(`deriveAttemptId: attemptNumber must be a positive integer, got ${attemptNumber}`);
  }
  return AttemptIdBrand(`${executionId}#${attemptNumber}`);
}
