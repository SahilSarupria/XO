import { ExecutionId } from '../ids.js';
/**
 * The same `RequestId` always derives the same `ExecutionId` — pure,
 * no clock, no randomness. Satisfies Stage 2's "deterministic execution
 * ids" requirement and lets a caller compute an `ExecutionId` up front
 * (e.g. to correlate logs before `ExecutionEngine.execute` returns)
 * without waiting on anything the engine produces.
 */
export function deriveExecutionId(requestId) {
    return ExecutionId(`exec_${requestId}`);
}
//# sourceMappingURL=execution-id.js.map