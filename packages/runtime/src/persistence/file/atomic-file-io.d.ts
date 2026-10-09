/**
 * Deterministic serialization: recursively sorts object keys before
 * `JSON.stringify`-ing, so two calls with structurally-equal data always
 * produce byte-identical output — required both for the content-hash
 * corruption check below (which would otherwise flag equal data as
 * corrupt just because key order differed) and for the "deterministic
 * serialization" requirement itself. Arrays keep their given order
 * (order is meaningful there); only object key order is normalized.
 */
export declare function canonicalStringify(value: unknown): string;
/**
 * Writes `payload` to `path` atomically: serializes to a temp file in
 * the same directory (so the eventual `rename` is same-filesystem, and
 * therefore atomic on every platform Node supports), then renames it
 * into place. A reader can never observe a partially-written file — it
 * either sees the previous complete version or the new complete version,
 * never a half-written one, even if the process crashes mid-write (the
 * temp file is simply orphaned, not the target path).
 */
export declare function atomicWriteJson(path: string, payload: unknown): Promise<void>;
export type ReadJsonResult = {
    readonly kind: 'ok';
    readonly payload: unknown;
} | {
    readonly kind: 'missing';
} | {
    readonly kind: 'corrupt';
    readonly reason: string;
};
/** Reads and verifies a file written by {@link atomicWriteJson}. Distinguishes "never written" (`'missing'`, not an error) from "written but unreadable/tampered/truncated" (`'corrupt'`, a real error a caller should surface) — see `runtime-store.interface.ts`'s doc comments for why that distinction matters. */
export declare function readJsonChecked(path: string): Promise<ReadJsonResult>;
export declare function deleteFile(path: string): Promise<boolean>;
/** Every `.json` file directly inside `dir` (non-recursive), or `[]` if `dir` doesn't exist yet — never throws for a not-yet-created directory, since "no records saved yet" is a normal state, not an error. */
export declare function listJsonFiles(dir: string): Promise<readonly string[]>;
/**
 * Serializes concurrent operations that touch the *same* key (e.g. two
 * writes to the same session id racing each other) while letting
 * operations on *different* keys run fully concurrently — "avoid global
 * locks that unnecessarily serialize unrelated executions." Each key's
 * queue is just a chained promise; there is no OS-level file lock
 * involved (`atomicWriteJson`'s rename-based atomicity is what protects
 * against a torn write; this is purely about ordering same-key
 * operations within this one process).
 */
export declare class KeyedAsyncLock {
    private readonly queues;
    withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}
//# sourceMappingURL=atomic-file-io.d.ts.map