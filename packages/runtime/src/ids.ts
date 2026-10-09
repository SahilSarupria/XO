import { brand, type Brand } from '@xo/types';

/**
 * Branded identifiers for Runtime Stage 1's own operational objects —
 * distinct from `@xo/types`' `PackageId`/`ContentHash`/etc., which
 * identify package-format concepts. Branded for the same reason as
 * `@xo/types`' ids (see `brand.ts`): a `RequestId` and a `SessionId` are
 * both plain strings underneath, and mixing them up at a call site is
 * exactly the mistake nominal typing exists to catch at compile time.
 */
export type MountId = Brand<string, 'MountId'>;
export type RequestId = Brand<string, 'RequestId'>;
export type PlanId = Brand<string, 'PlanId'>;
export type ReceiptId = Brand<string, 'ReceiptId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type EnvironmentId = Brand<string, 'EnvironmentId'>;
/** Stage 2. Deterministic — see `deriveExecutionId` in `engine/execution-id.ts`: the same `RequestId` always derives the same `ExecutionId`, so idempotency/dedup checks never depend on wall-clock time. */
export type ExecutionId = Brand<string, 'ExecutionId'>;
/**
 * R6. Identifies one concrete *try* at running a logical execution's
 * resolved strategy — distinct from `ExecutionId`, which stays stable
 * across every attempt of the same logical execution (see
 * `engine/execution-attempt-id.ts#deriveAttemptId`). Purely derived
 * (`${executionId}#${n}`), never independently generated, matching every
 * other id in this file. Attempt 1 always exists, even when retry is
 * disabled/unconfigured — "one attempt" is not a special case, it is the
 * default `maxAttempts`.
 */
export type AttemptId = Brand<string, 'AttemptId'>;
/** Stage 3. Identifies one running/completed `WorkflowInstance` — distinct from `SessionId`: a single `ExecutionSession` (Stage 2) can, in principle, front a workflow-graph execution, but the workflow's own internal node-by-node progress is tracked under its own id, not folded into the session's. */
export type WorkflowInstanceId = Brand<string, 'WorkflowInstanceId'>;
export type WorkflowCheckpointId = Brand<string, 'WorkflowCheckpointId'>;
export type WorkflowReceiptId = Brand<string, 'WorkflowReceiptId'>;
/** Stage 5. Identifies one durable `MemoryEntry`. Deterministic when derived from a scope + semantic `key` (`deriveMemoryEntryId`, `memory/memory-id.ts`) so a repeated write with the same key upserts rather than duplicating; randomly generated for memory that has no semantic key and is treated as a unique event instance — see that file's doc comment for the distinction. */
export type MemoryEntryId = Brand<string, 'MemoryEntryId'>;

export const MountId = (value: string): MountId => brand(value);
export const RequestId = (value: string): RequestId => brand(value);
export const PlanId = (value: string): PlanId => brand(value);
export const ReceiptId = (value: string): ReceiptId => brand(value);
export const SessionId = (value: string): SessionId => brand(value);
export const EnvironmentId = (value: string): EnvironmentId => brand(value);
export const ExecutionId = (value: string): ExecutionId => brand(value);
export const AttemptId = (value: string): AttemptId => brand(value);
export const WorkflowInstanceId = (value: string): WorkflowInstanceId => brand(value);
export const WorkflowCheckpointId = (value: string): WorkflowCheckpointId => brand(value);
export const WorkflowReceiptId = (value: string): WorkflowReceiptId => brand(value);
export const MemoryEntryId = (value: string): MemoryEntryId => brand(value);
