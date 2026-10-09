import { ok, type Result } from '@xo/types';
import type { RuntimeError } from '@xo/errors';
import { join } from 'node:path';
import type { ExecutionSession } from '../../session/execution-session.js';
import type { ExecutionReceipt } from '../../session/execution-receipt.js';
import type { WorkflowCheckpoint } from '../../workflow/workflow-checkpoint.js';
import type { WorkflowReceipt } from '../../workflow/workflow-receipt.js';
import type { SessionId, WorkflowCheckpointId, WorkflowInstanceId, ReceiptId, WorkflowReceiptId } from '../../ids.js';
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
} from '../runtime-store.interface.js';
import { FileRecordStore } from './file-record-store.js';
import { FileMemoryRecordStore } from './file-memory-store.js';

export interface FileRuntimeStoreOptions {
  readonly rootDir: string;
  readonly now?: () => Date;
}

class FileSessionStore implements SessionStore {
  private readonly store: FileRecordStore<ExecutionSession>;
  constructor(dir: string, now: () => Date) {
    this.store = new FileRecordStore(dir, now);
  }
  async create(session: ExecutionSession): Promise<Result<VersionedEnvelope<ExecutionSession>, RuntimeError>> {
    return this.store.save(session.sessionId, session);
  }
  async get(sessionId: SessionId): Promise<Result<VersionedEnvelope<ExecutionSession> | undefined, RuntimeError>> {
    return this.store.get(sessionId);
  }
  async update(session: ExecutionSession): Promise<Result<VersionedEnvelope<ExecutionSession>, RuntimeError>> {
    return this.store.save(session.sessionId, session);
  }
  async list(): Promise<Result<readonly VersionedEnvelope<ExecutionSession>[], RuntimeError>> {
    const result = await this.store.list();
    if (!result.ok) return result;
    return ok(result.value.map((entry) => entry.envelope));
  }
  async delete(sessionId: SessionId): Promise<Result<boolean, RuntimeError>> {
    return this.store.delete(sessionId);
  }
}

class FileExecutionStore implements ExecutionStore {
  private readonly store: FileRecordStore<ExecutionRecord>;
  constructor(dir: string, now: () => Date) {
    this.store = new FileRecordStore(dir, now);
  }
  async save(record: ExecutionRecord): Promise<Result<VersionedEnvelope<ExecutionRecord>, RuntimeError>> {
    return this.store.save(record.executionId, record);
  }
  async get(executionId: WorkflowInstanceId): Promise<Result<VersionedEnvelope<ExecutionRecord> | undefined, RuntimeError>> {
    return this.store.get(executionId);
  }
  async list(): Promise<Result<readonly VersionedEnvelope<ExecutionRecord>[], RuntimeError>> {
    const result = await this.store.list();
    if (!result.ok) return result;
    return ok(result.value.map((entry) => entry.envelope));
  }
  async delete(executionId: WorkflowInstanceId): Promise<Result<boolean, RuntimeError>> {
    return this.store.delete(executionId);
  }
}

/**
 * Checkpoints get one subdirectory *per execution* (`checkpoints/<executionId>/<seq>__<checkpointId>.json`)
 * rather than one flat directory — `listForExecution`/`latestForExecution`
 * need to enumerate only one execution's checkpoints, and a flat
 * directory would make that an O(all checkpoints ever) scan instead of
 * O(this execution's checkpoints). The sequence number is baked into the
 * filename (zero-padded) specifically so `FileRecordStore.list()`'s
 * plain alphabetical sort already returns them in the right order
 * without needing to open and parse every file first.
 */
class FileCheckpointRecordStore implements CheckpointRecordStore {
  private readonly byId: FileRecordStore<CheckpointRecord>;
  private readonly rootDir: string;
  private readonly now: () => Date;
  private readonly sequenceByExecution = new Map<string, number>();

  constructor(rootDir: string, now: () => Date) {
    this.rootDir = rootDir;
    this.now = now;
    this.byId = new FileRecordStore(join(rootDir, '_by-id'), now);
  }

  private executionDir(executionId: string): string {
    return join(this.rootDir, encodeURIComponent(executionId));
  }

  async save(checkpoint: WorkflowCheckpoint): Promise<Result<VersionedEnvelope<CheckpointRecord>, RuntimeError>> {
    const executionId = checkpoint.workflowInstanceId;
    const listed = await this.listForExecution(executionId);
    if (!listed.ok) return listed;
    const nextSequence = (this.sequenceByExecution.get(executionId) ?? listed.value.length - 1) + 1;
    this.sequenceByExecution.set(executionId, nextSequence);

    const record: CheckpointRecord = { checkpointId: checkpoint.checkpointId, executionId, sequence: nextSequence, checkpoint };
    const marker = new FileRecordStore<CheckpointRecord>(this.executionDir(executionId), this.now);
    const filename = `${String(nextSequence).padStart(8, '0')}__${checkpoint.checkpointId}`;
    const markerResult = await marker.save(filename, record);
    if (!markerResult.ok) return markerResult;
    // Also indexed by bare checkpoint id, for O(1) `get(checkpointId)`
    // without needing to know which execution it belongs to.
    const byIdResult = await this.byId.save(checkpoint.checkpointId, record);
    if (!byIdResult.ok) return byIdResult;
    return ok(markerResult.value);
  }

  async get(checkpointId: WorkflowCheckpointId): Promise<Result<VersionedEnvelope<CheckpointRecord> | undefined, RuntimeError>> {
    return this.byId.get(checkpointId);
  }

  async listForExecution(executionId: WorkflowInstanceId): Promise<Result<readonly VersionedEnvelope<CheckpointRecord>[], RuntimeError>> {
    const marker = new FileRecordStore<CheckpointRecord>(this.executionDir(executionId), this.now);
    const result = await marker.list();
    if (!result.ok) return result;
    return ok(
      result.value
        .map((entry) => entry.envelope)
        .slice()
        .sort((a, b) => a.data.sequence - b.data.sequence),
    );
  }

  async latestForExecution(executionId: WorkflowInstanceId): Promise<Result<VersionedEnvelope<CheckpointRecord> | undefined, RuntimeError>> {
    const listed = await this.listForExecution(executionId);
    if (!listed.ok) return listed;
    return ok(listed.value[listed.value.length - 1]);
  }

  async delete(checkpointId: WorkflowCheckpointId): Promise<Result<boolean, RuntimeError>> {
    const existing = await this.byId.get(checkpointId);
    if (!existing.ok) return existing;
    const byIdDeleted = await this.byId.delete(checkpointId);
    if (!byIdDeleted.ok) return byIdDeleted;
    if (existing.value) {
      const marker = new FileRecordStore<CheckpointRecord>(this.executionDir(existing.value.data.executionId), this.now);
      const filename = `${String(existing.value.data.sequence).padStart(8, '0')}__${checkpointId}`;
      await marker.delete(filename);
    }
    return ok(byIdDeleted.value);
  }
}

class FileReceiptStore implements ReceiptStore {
  private readonly executionReceipts: FileRecordStore<PersistedReceipt>;
  private readonly workflowReceipts: FileRecordStore<PersistedReceipt>;
  private readonly byExecutionDir: string;
  private readonly now: () => Date;

  constructor(rootDir: string, now: () => Date) {
    this.executionReceipts = new FileRecordStore(join(rootDir, 'execution'), now);
    this.workflowReceipts = new FileRecordStore(join(rootDir, 'workflow'), now);
    this.byExecutionDir = join(rootDir, '_by-execution');
    this.now = now;
  }

  private async indexByExecution(executionId: string, receiptStoreKind: 'execution' | 'workflow', receiptId: string, record: PersistedReceipt): Promise<Result<void, RuntimeError>> {
    const marker = new FileRecordStore<PersistedReceipt>(join(this.byExecutionDir, encodeURIComponent(executionId)), this.now);
    const result = await marker.save(`${receiptStoreKind}__${receiptId}`, record);
    if (!result.ok) return result;
    return ok(undefined);
  }

  async saveExecutionReceipt(executionId: WorkflowInstanceId | undefined, receipt: ExecutionReceipt): Promise<Result<VersionedEnvelope<PersistedReceipt>, RuntimeError>> {
    const record: PersistedReceipt = { kind: 'execution', receipt };
    const saved = await this.executionReceipts.save(receipt.receiptId, record);
    if (!saved.ok) return saved;
    if (executionId !== undefined) {
      const indexed = await this.indexByExecution(executionId, 'execution', receipt.receiptId, record);
      if (!indexed.ok) return indexed;
    }
    return ok(saved.value);
  }

  async saveWorkflowReceipt(receipt: WorkflowReceipt): Promise<Result<VersionedEnvelope<PersistedReceipt>, RuntimeError>> {
    const record: PersistedReceipt = { kind: 'workflow', receipt };
    const saved = await this.workflowReceipts.save(receipt.receiptId, record);
    if (!saved.ok) return saved;
    const indexed = await this.indexByExecution(receipt.workflowInstanceId, 'workflow', receipt.receiptId, record);
    if (!indexed.ok) return indexed;
    return ok(saved.value);
  }

  async getExecutionReceipt(receiptId: ReceiptId): Promise<Result<VersionedEnvelope<ExecutionReceipt> | undefined, RuntimeError>> {
    const found = await this.executionReceipts.get(receiptId);
    if (!found.ok) return found;
    if (!found.value || found.value.data.kind !== 'execution') return ok(undefined);
    return ok({ version: found.value.version, persistedAt: found.value.persistedAt, data: found.value.data.receipt });
  }

  async getWorkflowReceipt(receiptId: WorkflowReceiptId): Promise<Result<VersionedEnvelope<WorkflowReceipt> | undefined, RuntimeError>> {
    const found = await this.workflowReceipts.get(receiptId);
    if (!found.ok) return found;
    if (!found.value || found.value.data.kind !== 'workflow') return ok(undefined);
    return ok({ version: found.value.version, persistedAt: found.value.persistedAt, data: found.value.data.receipt });
  }

  async listByExecution(executionId: WorkflowInstanceId): Promise<Result<readonly VersionedEnvelope<PersistedReceipt>[], RuntimeError>> {
    const marker = new FileRecordStore<PersistedReceipt>(join(this.byExecutionDir, encodeURIComponent(executionId)), this.now);
    const result = await marker.list();
    if (!result.ok) return result;
    return ok(result.value.map((entry) => entry.envelope));
  }
}

/**
 * The local, durable `RuntimeStore` — appropriate for XO Studio / local
 * desktop execution per the brief, deliberately not a database: every
 * record is one JSON file, written atomically (temp file + rename) with
 * a checksum for corruption detection. No SQLite, no external process,
 * no network — `rootDir` is a plain directory a caller fully owns.
 *
 * Layout under `rootDir`:
 * ```
 * sessions/<sessionId>.json
 * executions/<executionId>.json
 * checkpoints/<executionId>/<seq>__<checkpointId>.json   (+ _by-id/<checkpointId>.json for O(1) get-by-id)
 * receipts/execution/<receiptId>.json
 * receipts/workflow/<receiptId>.json
 * receipts/_by-execution/<executionId>/<kind>__<receiptId>.json
 * memory/<scopeKind>/<scopeId>/<entryId>.json             (Stage 5 — see file-memory-store.ts)
 * ```
 */
export class FileRuntimeStore implements RuntimeStore {
  readonly sessions: SessionStore;
  readonly executions: ExecutionStore;
  readonly checkpoints: CheckpointRecordStore;
  readonly receipts: ReceiptStore;
  readonly memory: MemoryRecordStore;

  constructor(options: FileRuntimeStoreOptions) {
    const now = options.now ?? (() => new Date());
    this.sessions = new FileSessionStore(join(options.rootDir, 'sessions'), now);
    this.executions = new FileExecutionStore(join(options.rootDir, 'executions'), now);
    this.checkpoints = new FileCheckpointRecordStore(join(options.rootDir, 'checkpoints'), now);
    this.receipts = new FileReceiptStore(join(options.rootDir, 'receipts'), now);
    this.memory = new FileMemoryRecordStore(join(options.rootDir, 'memory'), now);
  }
}
