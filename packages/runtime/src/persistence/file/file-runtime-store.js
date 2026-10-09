import { ok } from '@xo/types';
import { join } from 'node:path';
import { FileRecordStore } from './file-record-store.js';
import { FileMemoryRecordStore } from './file-memory-store.js';
class FileSessionStore {
    store;
    constructor(dir, now) {
        this.store = new FileRecordStore(dir, now);
    }
    async create(session) {
        return this.store.save(session.sessionId, session);
    }
    async get(sessionId) {
        return this.store.get(sessionId);
    }
    async update(session) {
        return this.store.save(session.sessionId, session);
    }
    async list() {
        const result = await this.store.list();
        if (!result.ok)
            return result;
        return ok(result.value.map((entry) => entry.envelope));
    }
    async delete(sessionId) {
        return this.store.delete(sessionId);
    }
}
class FileExecutionStore {
    store;
    constructor(dir, now) {
        this.store = new FileRecordStore(dir, now);
    }
    async save(record) {
        return this.store.save(record.executionId, record);
    }
    async get(executionId) {
        return this.store.get(executionId);
    }
    async list() {
        const result = await this.store.list();
        if (!result.ok)
            return result;
        return ok(result.value.map((entry) => entry.envelope));
    }
    async delete(executionId) {
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
class FileCheckpointRecordStore {
    byId;
    rootDir;
    now;
    sequenceByExecution = new Map();
    constructor(rootDir, now) {
        this.rootDir = rootDir;
        this.now = now;
        this.byId = new FileRecordStore(join(rootDir, '_by-id'), now);
    }
    executionDir(executionId) {
        return join(this.rootDir, encodeURIComponent(executionId));
    }
    async save(checkpoint) {
        const executionId = checkpoint.workflowInstanceId;
        const listed = await this.listForExecution(executionId);
        if (!listed.ok)
            return listed;
        const nextSequence = (this.sequenceByExecution.get(executionId) ?? listed.value.length - 1) + 1;
        this.sequenceByExecution.set(executionId, nextSequence);
        const record = { checkpointId: checkpoint.checkpointId, executionId, sequence: nextSequence, checkpoint };
        const marker = new FileRecordStore(this.executionDir(executionId), this.now);
        const filename = `${String(nextSequence).padStart(8, '0')}__${checkpoint.checkpointId}`;
        const markerResult = await marker.save(filename, record);
        if (!markerResult.ok)
            return markerResult;
        // Also indexed by bare checkpoint id, for O(1) `get(checkpointId)`
        // without needing to know which execution it belongs to.
        const byIdResult = await this.byId.save(checkpoint.checkpointId, record);
        if (!byIdResult.ok)
            return byIdResult;
        return ok(markerResult.value);
    }
    async get(checkpointId) {
        return this.byId.get(checkpointId);
    }
    async listForExecution(executionId) {
        const marker = new FileRecordStore(this.executionDir(executionId), this.now);
        const result = await marker.list();
        if (!result.ok)
            return result;
        return ok(result.value
            .map((entry) => entry.envelope)
            .slice()
            .sort((a, b) => a.data.sequence - b.data.sequence));
    }
    async latestForExecution(executionId) {
        const listed = await this.listForExecution(executionId);
        if (!listed.ok)
            return listed;
        return ok(listed.value[listed.value.length - 1]);
    }
    async delete(checkpointId) {
        const existing = await this.byId.get(checkpointId);
        if (!existing.ok)
            return existing;
        const byIdDeleted = await this.byId.delete(checkpointId);
        if (!byIdDeleted.ok)
            return byIdDeleted;
        if (existing.value) {
            const marker = new FileRecordStore(this.executionDir(existing.value.data.executionId), this.now);
            const filename = `${String(existing.value.data.sequence).padStart(8, '0')}__${checkpointId}`;
            await marker.delete(filename);
        }
        return ok(byIdDeleted.value);
    }
}
class FileReceiptStore {
    executionReceipts;
    workflowReceipts;
    byExecutionDir;
    now;
    constructor(rootDir, now) {
        this.executionReceipts = new FileRecordStore(join(rootDir, 'execution'), now);
        this.workflowReceipts = new FileRecordStore(join(rootDir, 'workflow'), now);
        this.byExecutionDir = join(rootDir, '_by-execution');
        this.now = now;
    }
    async indexByExecution(executionId, receiptStoreKind, receiptId, record) {
        const marker = new FileRecordStore(join(this.byExecutionDir, encodeURIComponent(executionId)), this.now);
        const result = await marker.save(`${receiptStoreKind}__${receiptId}`, record);
        if (!result.ok)
            return result;
        return ok(undefined);
    }
    async saveExecutionReceipt(executionId, receipt) {
        const record = { kind: 'execution', receipt };
        const saved = await this.executionReceipts.save(receipt.receiptId, record);
        if (!saved.ok)
            return saved;
        if (executionId !== undefined) {
            const indexed = await this.indexByExecution(executionId, 'execution', receipt.receiptId, record);
            if (!indexed.ok)
                return indexed;
        }
        return ok(saved.value);
    }
    async saveWorkflowReceipt(receipt) {
        const record = { kind: 'workflow', receipt };
        const saved = await this.workflowReceipts.save(receipt.receiptId, record);
        if (!saved.ok)
            return saved;
        const indexed = await this.indexByExecution(receipt.workflowInstanceId, 'workflow', receipt.receiptId, record);
        if (!indexed.ok)
            return indexed;
        return ok(saved.value);
    }
    async getExecutionReceipt(receiptId) {
        const found = await this.executionReceipts.get(receiptId);
        if (!found.ok)
            return found;
        if (!found.value || found.value.data.kind !== 'execution')
            return ok(undefined);
        return ok({ version: found.value.version, persistedAt: found.value.persistedAt, data: found.value.data.receipt });
    }
    async getWorkflowReceipt(receiptId) {
        const found = await this.workflowReceipts.get(receiptId);
        if (!found.ok)
            return found;
        if (!found.value || found.value.data.kind !== 'workflow')
            return ok(undefined);
        return ok({ version: found.value.version, persistedAt: found.value.persistedAt, data: found.value.data.receipt });
    }
    async listByExecution(executionId) {
        const marker = new FileRecordStore(join(this.byExecutionDir, encodeURIComponent(executionId)), this.now);
        const result = await marker.list();
        if (!result.ok)
            return result;
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
export class FileRuntimeStore {
    sessions;
    executions;
    checkpoints;
    receipts;
    memory;
    constructor(options) {
        const now = options.now ?? (() => new Date());
        this.sessions = new FileSessionStore(join(options.rootDir, 'sessions'), now);
        this.executions = new FileExecutionStore(join(options.rootDir, 'executions'), now);
        this.checkpoints = new FileCheckpointRecordStore(join(options.rootDir, 'checkpoints'), now);
        this.receipts = new FileReceiptStore(join(options.rootDir, 'receipts'), now);
        this.memory = new FileMemoryRecordStore(join(options.rootDir, 'memory'), now);
    }
}
//# sourceMappingURL=file-runtime-store.js.map