import type { RuntimeError } from '@xo/errors';
import type { Result } from '@xo/types';
import type { ExecutionSession } from '../session/execution-session.js';
import type { ExecutionReceipt } from '../session/execution-receipt.js';
import type { WorkflowCheckpoint } from '../workflow/workflow-checkpoint.js';
import type { WorkflowInstance } from '../workflow/workflow-instance.js';
import type { WorkflowReceipt } from '../workflow/workflow-receipt.js';
import type { NodeId } from '../workflow/workflow-graph.js';
import type { SessionId, WorkflowCheckpointId, WorkflowInstanceId, ReceiptId, WorkflowReceiptId, MemoryEntryId } from '../ids.js';
import type { MemoryEntry, MemoryQuery, MemoryScope } from '../memory/memory-types.js';

/**
 * Stage 4's persistence abstraction. Deliberately wraps the *existing*
 * Stage 1-3 types (`ExecutionSession`, `WorkflowInstance`,
 * `WorkflowCheckpoint`, `ExecutionReceipt`, `WorkflowReceipt`) rather
 * than redefining their fields — "persist the existing runtime receipt
 * model without creating a second receipt format" applies to every
 * record type here, not just receipts: a `RuntimeStore` is a place to
 * put objects the runtime already produces, not a new schema for them.
 *
 * Every record is wrapped in a small versioned envelope (`version`,
 * `persistedAt`) — see `versioning.ts` — so a future runtime version can
 * migrate old persisted records forward without this interface itself
 * needing to change.
 */
export interface RuntimeStore {
  readonly sessions: SessionStore;
  readonly executions: ExecutionStore;
  /** Named `checkpoints` per the brief's illustrative sketch; the *type* is `CheckpointRecordStore`, not `CheckpointStore` — that name is already taken by Stage 3's in-memory, non-durable `CheckpointStore` class (`workflow/workflow-checkpoint.ts`), which this does not replace. */
  readonly checkpoints: CheckpointRecordStore;
  readonly receipts: ReceiptStore;
  /** Stage 5. Durable runtime memory — see `memory/runtime-memory.ts` for the higher-level, scope-isolating, permission-checked facade built on top of this; this interface itself is the same kind of thin persistence boundary `sessions`/`executions`/`checkpoints`/`receipts` already are. */
  readonly memory: MemoryRecordStore;
}

export interface VersionedEnvelope<T> {
  readonly version: number;
  readonly persistedAt: string;
  readonly data: T;
}

// --- Sessions ------------------------------------------------------------

export interface SessionStore {
  create(session: ExecutionSession): Promise<Result<VersionedEnvelope<ExecutionSession>, RuntimeError>>;
  get(sessionId: SessionId): Promise<Result<VersionedEnvelope<ExecutionSession> | undefined, RuntimeError>>;
  update(session: ExecutionSession): Promise<Result<VersionedEnvelope<ExecutionSession>, RuntimeError>>;
  list(): Promise<Result<readonly VersionedEnvelope<ExecutionSession>[], RuntimeError>>;
  delete(sessionId: SessionId): Promise<Result<boolean, RuntimeError>>;
}

// --- Workflow execution state ---------------------------------------------

/**
 * A durable snapshot of one workflow execution. `instance` (a Stage 3
 * `WorkflowInstance` — graph, immutable `WorkflowState`, status,
 * timestamps) is the source of truth for everything the Stage 4 brief
 * asks execution records to track: current node, completed/failed/
 * skipped nodes, outputs, history, timing are all already fields of
 * `instance.state`/`instance`. `waitingNodeIds` is the one thing that
 * *isn't* already stored on `WorkflowState` (Stage 3 computes "waiting"
 * on demand via `WorkflowScheduler.computeCursor`, never persists it) —
 * here it's a snapshot for inspection/debugging, computed at save time;
 * `instance` (graph + state) remains the only thing `resume()` actually
 * needs or trusts.
 */
export interface ExecutionRecord {
  readonly executionId: WorkflowInstanceId;
  readonly instance: WorkflowInstance;
  readonly waitingNodeIds: readonly NodeId[];
}

export interface ExecutionStore {
  save(record: ExecutionRecord): Promise<Result<VersionedEnvelope<ExecutionRecord>, RuntimeError>>;
  get(executionId: WorkflowInstanceId): Promise<Result<VersionedEnvelope<ExecutionRecord> | undefined, RuntimeError>>;
  list(): Promise<Result<readonly VersionedEnvelope<ExecutionRecord>[], RuntimeError>>;
  delete(executionId: WorkflowInstanceId): Promise<Result<boolean, RuntimeError>>;
}

// --- Checkpoints -----------------------------------------------------------

/** `sequence` is assigned by the store itself (0, 1, 2, ... per execution, in save order) — the "sequence/version" the brief asks for; it lives at the envelope/record level rather than on `WorkflowCheckpoint` itself so Stage 3's type stays untouched. */
export interface CheckpointRecord {
  readonly checkpointId: WorkflowCheckpointId;
  readonly executionId: WorkflowInstanceId;
  readonly sequence: number;
  readonly checkpoint: WorkflowCheckpoint;
}

export interface CheckpointRecordStore {
  save(checkpoint: WorkflowCheckpoint): Promise<Result<VersionedEnvelope<CheckpointRecord>, RuntimeError>>;
  get(checkpointId: WorkflowCheckpointId): Promise<Result<VersionedEnvelope<CheckpointRecord> | undefined, RuntimeError>>;
  /** Every checkpoint for `executionId`, ordered by `sequence` ascending (oldest first) — deterministic regardless of storage backend. */
  listForExecution(executionId: WorkflowInstanceId): Promise<Result<readonly VersionedEnvelope<CheckpointRecord>[], RuntimeError>>;
  latestForExecution(executionId: WorkflowInstanceId): Promise<Result<VersionedEnvelope<CheckpointRecord> | undefined, RuntimeError>>;
  delete(checkpointId: WorkflowCheckpointId): Promise<Result<boolean, RuntimeError>>;
}

// --- Receipts ----------------------------------------------------------

/**
 * Both receipt kinds this runtime actually produces — Stage 2's
 * `ExecutionReceipt` (one capability call) and Stage 3's
 * `WorkflowReceipt` (one workflow run, aggregating node receipts) —
 * persisted through the same store rather than inventing a third,
 * unifying shape. Immutable once saved: no method here updates a
 * previously-saved receipt, only reads or (for cleanup) deletes.
 */
export type PersistedReceipt = { readonly kind: 'execution'; readonly receipt: ExecutionReceipt } | { readonly kind: 'workflow'; readonly receipt: WorkflowReceipt };

export interface ReceiptStore {
  saveExecutionReceipt(executionId: WorkflowInstanceId | undefined, receipt: ExecutionReceipt): Promise<Result<VersionedEnvelope<PersistedReceipt>, RuntimeError>>;
  saveWorkflowReceipt(receipt: WorkflowReceipt): Promise<Result<VersionedEnvelope<PersistedReceipt>, RuntimeError>>;
  getExecutionReceipt(receiptId: ReceiptId): Promise<Result<VersionedEnvelope<ExecutionReceipt> | undefined, RuntimeError>>;
  getWorkflowReceipt(receiptId: WorkflowReceiptId): Promise<Result<VersionedEnvelope<WorkflowReceipt> | undefined, RuntimeError>>;
  /** Every receipt (of either kind) associated with `executionId`, oldest first. A Stage 2-only caller with no workflow will simply never have anything under a `WorkflowInstanceId`-keyed association — see `saveExecutionReceipt`'s `executionId` parameter, which is optional for exactly that case. */
  listByExecution(executionId: WorkflowInstanceId): Promise<Result<readonly VersionedEnvelope<PersistedReceipt>[], RuntimeError>>;
}

// --- Memory (Stage 5) ----------------------------------------------------

/**
 * The durable-memory persistence boundary, one level below `RuntimeMemory`
 * (`memory/runtime-memory.ts`). Every method is explicitly `(scope, ...)`
 * — never a bare id — so a store implementation physically cannot answer
 * "get this id" without also being told which scope it's supposed to live
 * in; see `memory-types.ts`'s `MemoryScope` doc comment for why that's the
 * structural isolation guarantee, not merely a filter.
 *
 * TTL is enforced here, not only at the `RuntimeMemory` facade layer:
 * `get`/`query` never return an expired entry unless `query.includeExpired`
 * is set, so *any* caller reading directly against a `RuntimeStore` (not
 * only ones going through `RuntimeMemory`) gets correct expiration
 * semantics — §15 of the Stage 5 brief.
 */
export interface MemoryRecordStore {
  /** Upsert: writing the same `entry.id` again (typically because it was derived deterministically from the same `(scope, key)` — see `memory/memory-id.ts`) replaces the prior value rather than erroring or duplicating. */
  put(entry: MemoryEntry): Promise<Result<VersionedEnvelope<MemoryEntry>, RuntimeError>>;
  get(scope: MemoryScope, id: MemoryEntryId): Promise<Result<VersionedEnvelope<MemoryEntry> | undefined, RuntimeError>>;
  /** Every non-expired entry in `scope` matching `query` (unfiltered if `query` is omitted), oldest-created first — deterministic regardless of storage backend, matching `CheckpointRecordStore.listForExecution`'s ordering guarantee. */
  query(scope: MemoryScope, query?: MemoryQuery): Promise<Result<readonly VersionedEnvelope<MemoryEntry>[], RuntimeError>>;
  delete(scope: MemoryScope, id: MemoryEntryId): Promise<Result<boolean, RuntimeError>>;
  /** Deletes every entry in `scope`. Returns the number deleted. Used for explicit scope teardown (e.g. an execution completing and its execution-scoped memory being deliberately discarded) — never called implicitly by anything in this stage. */
  clear(scope: MemoryScope): Promise<Result<number, RuntimeError>>;
}
