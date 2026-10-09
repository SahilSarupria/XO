import type { RequestId } from '../ids.js';
import { ExecutionId } from '../ids.js';
/**
 * The same `RequestId` always derives the same `ExecutionId` — pure,
 * no clock, no randomness. Satisfies Stage 2's "deterministic execution
 * ids" requirement and lets a caller compute an `ExecutionId` up front
 * (e.g. to correlate logs before `ExecutionEngine.execute` returns)
 * without waiting on anything the engine produces.
 */
export declare function deriveExecutionId(requestId: RequestId): ExecutionId;
//# sourceMappingURL=execution-id.d.ts.map