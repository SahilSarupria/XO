import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
/**
 * Deterministic serialization: recursively sorts object keys before
 * `JSON.stringify`-ing, so two calls with structurally-equal data always
 * produce byte-identical output — required both for the content-hash
 * corruption check below (which would otherwise flag equal data as
 * corrupt just because key order differed) and for the "deterministic
 * serialization" requirement itself. Arrays keep their given order
 * (order is meaningful there); only object key order is normalized.
 */
export function canonicalStringify(value) {
    return JSON.stringify(sortKeysDeep(value));
}
function sortKeysDeep(value) {
    if (Array.isArray(value))
        return value.map(sortKeysDeep);
    if (value !== null && typeof value === 'object') {
        const sorted = {};
        for (const key of Object.keys(value).sort()) {
            sorted[key] = sortKeysDeep(value[key]);
        }
        return sorted;
    }
    return value;
}
function sha256(content) {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}
/**
 * Writes `payload` to `path` atomically: serializes to a temp file in
 * the same directory (so the eventual `rename` is same-filesystem, and
 * therefore atomic on every platform Node supports), then renames it
 * into place. A reader can never observe a partially-written file — it
 * either sees the previous complete version or the new complete version,
 * never a half-written one, even if the process crashes mid-write (the
 * temp file is simply orphaned, not the target path).
 */
export async function atomicWriteJson(path, payload) {
    await mkdir(dirname(path), { recursive: true });
    const serialized = canonicalStringify(payload);
    const envelope = { checksum: sha256(serialized), payload };
    const tempPath = `${path}.tmp-${randomBytes(8).toString('hex')}`;
    await writeFile(tempPath, canonicalStringify(envelope), 'utf8');
    await rename(tempPath, path);
}
/** Reads and verifies a file written by {@link atomicWriteJson}. Distinguishes "never written" (`'missing'`, not an error) from "written but unreadable/tampered/truncated" (`'corrupt'`, a real error a caller should surface) — see `runtime-store.interface.ts`'s doc comments for why that distinction matters. */
export async function readJsonChecked(path) {
    let raw;
    try {
        raw = await readFile(path, 'utf8');
    }
    catch (cause) {
        if (isErrnoException(cause) && cause.code === 'ENOENT')
            return { kind: 'missing' };
        return { kind: 'corrupt', reason: cause instanceof Error ? cause.message : String(cause) };
    }
    let envelope;
    try {
        envelope = JSON.parse(raw);
    }
    catch (cause) {
        return { kind: 'corrupt', reason: `not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}` };
    }
    if (typeof envelope.checksum !== 'string' || !('payload' in envelope)) {
        return { kind: 'corrupt', reason: 'missing checksum/payload envelope fields' };
    }
    const expected = sha256(canonicalStringify(envelope.payload));
    if (expected !== envelope.checksum) {
        return { kind: 'corrupt', reason: `checksum mismatch (expected ${expected}, found ${envelope.checksum})` };
    }
    return { kind: 'ok', payload: envelope.payload };
}
export async function deleteFile(path) {
    try {
        await rm(path);
        return true;
    }
    catch (cause) {
        if (isErrnoException(cause) && cause.code === 'ENOENT')
            return false;
        throw cause;
    }
}
/** Every `.json` file directly inside `dir` (non-recursive), or `[]` if `dir` doesn't exist yet — never throws for a not-yet-created directory, since "no records saved yet" is a normal state, not an error. */
export async function listJsonFiles(dir) {
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name);
    }
    catch (cause) {
        if (isErrnoException(cause) && cause.code === 'ENOENT')
            return [];
        throw cause;
    }
}
function isErrnoException(value) {
    return value instanceof Error && 'code' in value;
}
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
export class KeyedAsyncLock {
    queues = new Map();
    async withLock(key, fn) {
        const previous = this.queues.get(key) ?? Promise.resolve();
        const run = previous.then(fn, fn);
        // Swallow so a failed operation doesn't permanently wedge this key's
        // queue for whoever runs next.
        this.queues.set(key, run.catch(() => undefined));
        return run;
    }
}
//# sourceMappingURL=atomic-file-io.js.map