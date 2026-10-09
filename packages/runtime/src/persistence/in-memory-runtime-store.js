import { ok } from '@xo/types';
import { CURRENT_RUNTIME_STORE_VERSION } from './versioning.js';
import { InMemoryDurableMemoryStore } from '../memory/in-memory-durable-memory-store.js';
function envelope(data, now) {
    return Object.freeze({ version: CURRENT_RUNTIME_STORE_VERSION, persistedAt: now().toISOString(), data });
}
class InMemorySessionStore {
    now;
    sessions = new Map();
    constructor(now) {
        this.now = now;
    }
    async create(session) {
        const record = envelope(session, this.now);
        this.sessions.set(session.sessionId, record);
        return ok(record);
    }
    async get(sessionId) {
        return ok(this.sessions.get(sessionId));
    }
    async update(session) {
        const record = envelope(session, this.now);
        this.sessions.set(session.sessionId, record);
        return ok(record);
    }
    async list() {
        return ok([...this.sessions.values()]);
    }
    async delete(sessionId) {
        return ok(this.sessions.delete(sessionId));
    }
}
class InMemoryExecutionStore {
    now;
    executions = new Map();
    constructor(now) {
        this.now = now;
    }
    async save(record) {
        const wrapped = envelope(record, this.now);
        this.executions.set(record.executionId, wrapped);
        return ok(wrapped);
    }
    async get(executionId) {
        return ok(this.executions.get(executionId));
    }
    async list() {
        return ok([...this.executions.values()]);
    }
    async delete(executionId) {
        return ok(this.executions.delete(executionId));
    }
}
class InMemoryCheckpointRecordStore {
    now;
    checkpoints = new Map();
    sequenceByExecution = new Map();
    constructor(now) {
        this.now = now;
    }
    async save(checkpoint) {
        const nextSequence = (this.sequenceByExecution.get(checkpoint.workflowInstanceId) ?? -1) + 1;
        this.sequenceByExecution.set(checkpoint.workflowInstanceId, nextSequence);
        const record = { checkpointId: checkpoint.checkpointId, executionId: checkpoint.workflowInstanceId, sequence: nextSequence, checkpoint };
        const wrapped = envelope(record, this.now);
        this.checkpoints.set(checkpoint.checkpointId, wrapped);
        return ok(wrapped);
    }
    async get(checkpointId) {
        return ok(this.checkpoints.get(checkpointId));
    }
    async listForExecution(executionId) {
        return ok([...this.checkpoints.values()]
            .filter((record) => record.data.executionId === executionId)
            .sort((a, b) => a.data.sequence - b.data.sequence));
    }
    async latestForExecution(executionId) {
        const forExecution = await this.listForExecution(executionId);
        if (!forExecution.ok)
            return forExecution;
        return ok(forExecution.value[forExecution.value.length - 1]);
    }
    async delete(checkpointId) {
        return ok(this.checkpoints.delete(checkpointId));
    }
}
class InMemoryReceiptStore {
    now;
    executionReceipts = new Map();
    workflowReceipts = new Map();
    byExecution = new Map();
    constructor(now) {
        this.now = now;
    }
    addAssociation(executionId, record) {
        if (executionId === undefined)
            return;
        const bucket = this.byExecution.get(executionId);
        if (bucket)
            bucket.push(record);
        else
            this.byExecution.set(executionId, [record]);
    }
    async saveExecutionReceipt(executionId, receipt) {
        const wrapped = envelope({ kind: 'execution', receipt }, this.now);
        this.executionReceipts.set(receipt.receiptId, wrapped);
        this.addAssociation(executionId, wrapped);
        return ok(wrapped);
    }
    async saveWorkflowReceipt(receipt) {
        const wrapped = envelope({ kind: 'workflow', receipt }, this.now);
        this.workflowReceipts.set(receipt.receiptId, wrapped);
        this.addAssociation(receipt.workflowInstanceId, wrapped);
        return ok(wrapped);
    }
    async getExecutionReceipt(receiptId) {
        const found = this.executionReceipts.get(receiptId);
        if (!found || found.data.kind !== 'execution')
            return ok(undefined);
        return ok({ version: found.version, persistedAt: found.persistedAt, data: found.data.receipt });
    }
    async getWorkflowReceipt(receiptId) {
        const found = this.workflowReceipts.get(receiptId);
        if (!found || found.data.kind !== 'workflow')
            return ok(undefined);
        return ok({ version: found.version, persistedAt: found.persistedAt, data: found.data.receipt });
    }
    async listByExecution(executionId) {
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
export class InMemoryRuntimeStore {
    sessions;
    executions;
    checkpoints;
    receipts;
    memory;
    constructor(now = () => new Date()) {
        this.sessions = new InMemorySessionStore(now);
        this.executions = new InMemoryExecutionStore(now);
        this.checkpoints = new InMemoryCheckpointRecordStore(now);
        this.receipts = new InMemoryReceiptStore(now);
        this.memory = new InMemoryDurableMemoryStore(now);
    }
}
//# sourceMappingURL=in-memory-runtime-store.js.map