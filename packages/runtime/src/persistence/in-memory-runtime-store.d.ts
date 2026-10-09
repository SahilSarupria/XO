import type { CheckpointRecordStore, ExecutionStore, MemoryRecordStore, ReceiptStore, RuntimeStore, SessionStore } from './runtime-store.interface.js';
/**
 * The default `RuntimeStore` — zero configuration, nothing written
 * anywhere durable. Constructing a `WorkflowExecutor` without a `store`
 * option behaves exactly as Stage 3 always did (no persistence at all,
 * not even this in-memory one); this class exists for callers who want
 * the `RuntimeStore` *interface* (e.g. to test their own integration
 * code against it, or to get uniform list/get semantics across a
 * process's lifetime) without committing to file-backed storage.
 */
export declare class InMemoryRuntimeStore implements RuntimeStore {
    readonly sessions: SessionStore;
    readonly executions: ExecutionStore;
    readonly checkpoints: CheckpointRecordStore;
    readonly receipts: ReceiptStore;
    readonly memory: MemoryRecordStore;
    constructor(now?: () => Date);
}
//# sourceMappingURL=in-memory-runtime-store.d.ts.map