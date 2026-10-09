import { mkdir, readFile, writeFile, unlink, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { err, ok } from '@xo/types';
import { ErrorCode, StorageError } from '@xo/errors';
/**
 * A real, working {@link BlobStore} backed by the local filesystem. Keys
 * are treated as `/`-separated paths under `rootDir`; every resolved path
 * is checked to still be inside `rootDir` to prevent `../` traversal
 * escaping the store.
 */
export class LocalFsBlobStore {
    rootDir;
    constructor(rootDir) {
        this.rootDir = rootDir;
    }
    resolveKey(key) {
        const resolved = resolve(this.rootDir, key);
        const rel = relative(this.rootDir, resolved);
        if (rel.startsWith('..') || rel.split(sep).includes('..')) {
            throw new StorageError(ErrorCode.STORAGE_WRITE_FAILED, `Key escapes store root: "${key}"`);
        }
        return resolved;
    }
    async put(key, data, options) {
        try {
            const path = this.resolveKey(key);
            await mkdir(dirname(path), { recursive: true });
            const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
            await writeFile(path, buffer);
            return ok(options?.contentType !== undefined ? { key, size: buffer.byteLength, contentType: options.contentType } : { key, size: buffer.byteLength });
        }
        catch (cause) {
            return err(new StorageError(ErrorCode.STORAGE_WRITE_FAILED, `Failed to write blob "${key}"`, { cause }));
        }
    }
    async get(key) {
        try {
            const path = this.resolveKey(key);
            const buffer = await readFile(path);
            return ok(new Uint8Array(buffer));
        }
        catch (cause) {
            return err(new StorageError(ErrorCode.STORAGE_OBJECT_NOT_FOUND, `Blob not found: "${key}"`, { cause }));
        }
    }
    async has(key) {
        try {
            await stat(this.resolveKey(key));
            return true;
        }
        catch {
            return false;
        }
    }
    async delete(key) {
        try {
            await unlink(this.resolveKey(key));
            return ok(undefined);
        }
        catch (cause) {
            return err(new StorageError(ErrorCode.STORAGE_OBJECT_NOT_FOUND, `Failed to delete blob "${key}"`, { cause }));
        }
    }
    async list(prefix = '') {
        try {
            const base = this.resolveKey(prefix || '.');
            const keys = [];
            async function walk(dir) {
                const entries = await readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const full = join(dir, entry.name);
                    if (entry.isDirectory())
                        await walk(full);
                    else
                        keys.push(full);
                }
            }
            await walk(base);
            const root = this.rootDir;
            return ok(keys.map((k) => relative(root, k).split(sep).join('/')));
        }
        catch (cause) {
            return err(new StorageError(ErrorCode.STORAGE_OBJECT_NOT_FOUND, `Failed to list prefix "${prefix}"`, { cause }));
        }
    }
}
//# sourceMappingURL=local-fs-blob-store.js.map