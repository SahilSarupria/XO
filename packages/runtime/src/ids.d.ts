import { type Brand } from '@xo/types';
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
/** Stage 3. Identifies one running/completed `WorkflowInstance` — distinct from `SessionId`: a single `ExecutionSession` (Stage 2) can, in principle, front a workflow-graph execution, but the workflow's own internal node-by-node progress is tracked under its own id, not folded into the session's. */
export type WorkflowInstanceId = Brand<string, 'WorkflowInstanceId'>;
export type WorkflowCheckpointId = Brand<string, 'WorkflowCheckpointId'>;
export type WorkflowReceiptId = Brand<string, 'WorkflowReceiptId'>;
/** Stage 5. Identifies one durable `MemoryEntry`. Deterministic when derived from a scope + semantic `key` (`deriveMemoryEntryId`, `memory/memory-id.ts`) so a repeated write with the same key upserts rather than duplicating; randomly generated for memory that has no semantic key and is treated as a unique event instance — see that file's doc comment for the distinction. */
export type MemoryEntryId = Brand<string, 'MemoryEntryId'>;
export declare const MountId: (value: string) => MountId;
export declare const RequestId: (value: string) => RequestId;
export declare const PlanId: (value: string) => PlanId;
export declare const ReceiptId: (value: string) => ReceiptId;
export declare const SessionId: (value: string) => SessionId;
export declare const EnvironmentId: (value: string) => EnvironmentId;
export declare const ExecutionId: (value: string) => ExecutionId;
export declare const WorkflowInstanceId: (value: string) => WorkflowInstanceId;
export declare const WorkflowCheckpointId: (value: string) => WorkflowCheckpointId;
export declare const WorkflowReceiptId: (value: string) => WorkflowReceiptId;
export declare const MemoryEntryId: (value: string) => MemoryEntryId;
//# sourceMappingURL=ids.d.ts.map