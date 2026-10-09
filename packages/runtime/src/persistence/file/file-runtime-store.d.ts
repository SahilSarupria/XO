import type { CheckpointRecordStore, ExecutionStore, MemoryRecordStore, ReceiptStore, RuntimeStore, SessionStore } from '../runtime-store.interface.js';
export interface FileRuntimeStoreOptions {
    readonly rootDir: string;
    readonly now?: () => Date;
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
export declare class FileRuntimeStore implements RuntimeStore {
    readonly sessions: SessionStore;
    readonly executions: ExecutionStore;
    readonly checkpoints: CheckpointRecordStore;
    readonly receipts: ReceiptStore;
    readonly memory: MemoryRecordStore;
    constructor(options: FileRuntimeStoreOptions);
}
//# sourceMappingURL=file-runtime-store.d.ts.map