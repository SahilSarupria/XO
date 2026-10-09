import { ok, type Result } from '@xo/types';
import type { RuntimeError } from '@xo/errors';
import type { ExecutionSession } from '../session/execution-session.js';
import type { ExecutionReceipt } from '../session/execution-receipt.js';
import type { WorkflowCheckpoint } from '../workflow/workflow-checkpoint.js';
import type { WorkflowReceipt } from '../workflow/workflow-receipt.js';
import type { SessionId, WorkflowCheckpointId, WorkflowInstanceId, ReceiptId, WorkflowReceiptId } from '../ids.js';
import { CURRENT_RUNTIME_STORE_VERSION } from './versioning.js';
import type {
  CheckpointRecord,
  CheckpointRecordStore,
  ExecutionRecord,
  ExecutionStore,
  MemoryRecordStore,
  PersistedReceipt,
  ReceiptStore,
  RuntimeStore,
  SessionStore,
  VersionedEnvelope,
} from './runtime-store.interface.js';
import { InMemoryDurableMemoryStore } from '../memory/in-memory-durable-memory-store.js';

function envelope<T>(data: T, now: () => Date): VersionedEnvelope<T> {
  return Object.freeze({ version: CURRENT_RUNTIME_STORE_VERSION, persistedAt: now().toISOString(), data });
}

class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, VersionedEnvelope<ExecutionSession>>();
  constructor(private readonly now: () => Date) {}

  async create(session: ExecutionSession): Promise<Result<VersionedEnvelope<ExecutionSession>, RuntimeError>> {
    const record = envelope(session, this.now);
    this.sessions.set(session.sessionId, record);
    return ok(record);
  }

  async get(sessionId: SessionId): Promise<Result<VersionedEnvelope<ExecutionSession> | undefined, RuntimeError>> {
    return ok(this.sessions.get(sessionId));
  }

  async update(session: ExecutionSession): Promise<Result<VersionedEnvelope<ExecutionSession>, RuntimeError>> {
    const record = envelope(session, this.now);
    this.sessions.set(session.sessionId, record);
    return ok(record);
  }

  async list(): Promise<Result<readonly VersionedEnvelope<ExecutionSession>[], RuntimeError>> {
    return ok([...this.sessions.values()]);
  }

  async delete(sessionId: SessionId): Promise<Result<boolean, RuntimeError>> {
    return ok(this.sessions.delete(sessionId));
  }
}

class InMemoryExecutionStore implements ExecutionStore {
  private readonly executions = new Map<string, VersionedEnvelope<ExecutionRecord>>();
  constructor(private readonly now: () => Date) {}

  async save(record: ExecutionRecord): Promise<Result<VersionedEnvelope<ExecutionRecord>, RuntimeError>> {
    const wrapped = envelope(record, this.now);
    this.executions.set(record.executionId, wrapped);
    return ok(wrapped);
  }

  async get(executionId: WorkflowInstanceId): Promise<Result<VersionedEnvelope<ExecutionRecord> | undefined, RuntimeError>> {
    return ok(this.executions.get(executionId));
  }

  async list(): Promise<Result<readonly VersionedEnvelope<ExecutionRecord>[], RuntimeError>> {
    return ok([...this.executions.values()]);
  }

  async delete(executionId: WorkflowInstanceId): Promise<Result<boolean, RuntimeError>> {
    return ok(this.executions.delete(executionId));
  }
}

class InMemoryCheckpointRecordStore implements CheckpointRecordStore {
  private readonly checkpoints = new Map<string, VersionedEnvelope<CheckpointRecord>>();
  private readonly sequenceByExecution = new Map<string, number>();
  constructor(private readonly now: () => Date) {}

  async save(checkpoint: WorkflowCheckpoint): Promise<Result<VersionedEnvelope<CheckpointRecord>, RuntimeError>> {
    const nextSequence = (this.sequenceByExecution.get(checkpoint.workflowInstanceId) ?? -1) + 1;
    this.sequenceByExecution.set(checkpoint.workflowInstanceId, nextSequence);
    const record: CheckpointRecord = { checkpointId: checkpoint.checkpointId, executionId: checkpoint.workflowInstanceId, sequence: nextSequence, checkpoint };
    const wrapped = envelope(record, this.now);
    this.checkpoints.set(checkpoint.checkpointId, wrapped);
    return ok(wrapped);
  }

  async get(checkpointId: WorkflowCheckpointId): Promise<Result<VersionedEnvelope<CheckpointRecord> | undefined, RuntimeError>> {
    return ok(this.checkpoints.get(checkpointId));
  }

  async listForExecution(executionId: WorkflowInstanceId): Promise<Result<readonly VersionedEnvelope<CheckpointRecord>[], RuntimeError>> {
    return ok(
      [...this.checkpoints.values()]
        .filter((record) => record.data.executionId === executionId)
        .sort((a, b) => a.data.sequence - b.data.sequence),
    );
  }

  async latestForExecution(executionId: WorkflowInstanceId): Promise<Result<VersionedEnvelope<CheckpointRecord> | undefined, RuntimeError>> {
    const forExecution = await this.listForExecution(executionId);
    if (!forExecution.ok) return forExecution;
    return ok(forExecution.value[forExecution.value.length - 1]);
  }

  async delete(checkpointId: WorkflowCheckpointId): Promise<Result<boolean, RuntimeError>> {
    return ok(this.checkpoints.delete(checkpointId));
  }
}

class InMemoryReceiptStore implements ReceiptStore {
  private readonly executionReceipts = new Map<string, VersionedEnvelope<PersistedReceipt>>();
  private readonly workflowReceipts = new Map<string, VersionedEnvelope<PersistedReceipt>>();
  private readonly byExecution = new Map<string, VersionedEnvelope<PersistedReceipt>[]>();
  constructor(private readonly now: () => Date) {}

  private addAssociation(executionId: string | undefined, record: VersionedEnvelope<PersistedReceipt>): void {
    if (executionId === undefined) return;
    const bucket = this.byExecution.get(executionId);
    if (bucket) bucket.push(record);
    else this.byExecution.set(executionId, [record]);
  }

  async saveExecutionReceipt(executionId: WorkflowInstanceId | undefined, receipt: ExecutionReceipt): Promise<Result<VersionedEnvelope<PersistedReceipt>, RuntimeError>> {
    const wrapped = envelope<PersistedReceipt>({ kind: 'execution', receipt }, this.now);
    this.executionReceipts.set(receipt.receiptId, wrapped);
    this.addAssociation(executionId, wrapped);
    return ok(wrapped);
  }

  async saveWorkflowReceipt(receipt: WorkflowReceipt): Promise<Result<VersionedEnvelope<PersistedReceipt>, RuntimeError>> {
    const wrapped = envelope<PersistedReceipt>({ kind: 'workflow', receipt }, this.now);
    this.workflowReceipts.set(receipt.receiptId, wrapped);
    this.addAssociation(receipt.workflowInstanceId, wrapped);
    return ok(wrapped);
  }

  async getExecutionReceipt(receiptId: ReceiptId): Promise<Result<VersionedEnvelope<ExecutionReceipt> | undefined, RuntimeError>> {
    const found = this.executionReceipts.get(receiptId);
    if (!found || found.data.kind !== 'execution') return ok(undefined);
    return ok({ version: found.version, persistedAt: found.persistedAt, data: found.data.receipt });
  }

  async getWorkflowReceipt(receiptId: WorkflowReceiptId): Promise<Result<VersionedEnvelope<WorkflowReceipt> | undefined, RuntimeError>> {
    const found = this.workflowReceipts.get(receiptId);
    if (!found || found.data.kind !== 'workflow') return ok(undefined);
    return ok({ version: found.version, persistedAt: found.persistedAt, data: found.data.receipt });
  }

  async listByExecution(executionId: WorkflowInstanceId): Promise<Result<readonly VersionedEnvelope<PersistedReceipt>[], RuntimeError>> {
    return ok(this.byExecution.get(executionId) ?? []);
  }
}

/**
 * The default `RuntimeStore` — zero configuration, nothing written
 * anywhere durable. Constructing a `WorkflowExecutor` without a `store`
 * option behaves exactly as Stage 3 always did (no persistence at all,
 * not even this in-memory one); this class exists for callers who want
 * the `RuntimeStore` *interface* (e.g. to test their own integration
 * code against it, or to get uniform list/get semantics across a
 * process's lifetime) without committing to file-backed storage.
 */
export class InMemoryRuntimeStore implements RuntimeStore {
  readonly sessions: SessionStore;
  readonly executions: ExecutionStore;
  readonly checkpoints: CheckpointRecordStore;
  readonly receipts: ReceiptStore;
  readonly memory: MemoryRecordStore;

  constructor(now: () => Date = () => new Date()) {
    this.sessions = new InMemorySessionStore(now);
    this.executions = new InMemoryExecutionStore(now);
    this.checkpoints = new InMemoryCheckpointRecordStore(now);
    this.receipts = new InMemoryReceiptStore(now);
    this.memory = new InMemoryDurableMemoryStore(now);
  }
}
