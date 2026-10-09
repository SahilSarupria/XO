import { type Result } from '@xo/types';
import { RuntimeError } from '@xo/errors';
import type { VersionedEnvelope } from '../runtime-store.interface.js';
/**
 * A generic, file-backed, versioned key-value store — one JSON file per
 * record, under `dir`. Every `FileRuntimeStore` sub-store is built on
 * top of one or more of these rather than reimplementing atomic-write /
 * corruption-check / locking / versioning logic four times.
 */
export declare class FileRecordStore<T> {
    private readonly dir;
    private readonly now;
    /** Advances a record stored at an older `version` to the current shape. Only ever called when `storedVersion !== CURRENT_RUNTIME_STORE_VERSION`; see `versioning.ts`. The default throws — with no migrations registered yet (`CURRENT_RUNTIME_STORE_VERSION` is still `1`), *any* other stored version is genuinely unsupported, and silently passing the raw data through as if it matched the current shape would be a real data-integrity risk, not a safe fallback. */
    private readonly migrate;
    private readonly lock;
    constructor(dir: string, now: () => Date, 
    /** Advances a record stored at an older `version` to the current shape. Only ever called when `storedVersion !== CURRENT_RUNTIME_STORE_VERSION`; see `versioning.ts`. The default throws — with no migrations registered yet (`CURRENT_RUNTIME_STORE_VERSION` is still `1`), *any* other stored version is genuinely unsupported, and silently passing the raw data through as if it matched the current shape would be a real data-integrity risk, not a safe fallback. */
    migrate?: (storedVersion: number, raw: unknown) => T);
    private pathFor;
    save(id: string, data: T): Promise<Result<VersionedEnvelope<T>, RuntimeError>>;
    get(id: string): Promise<Result<VersionedEnvelope<T> | undefined, RuntimeError>>;
    list(): Promise<Result<readonly {
        readonly id: string;
        readonly envelope: VersionedEnvelope<T>;
    }[], RuntimeError>>;
    delete(id: string): Promise<Result<boolean, RuntimeError>>;
}
//# sourceMappingURL=file-record-store.d.ts.map