import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, writeFile, unlink, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { err, ok, type Result } from '@xo/types';
import { ErrorCode, StorageError } from '@xo/errors';
import type { AtomicBlobStore, BlobMetadata, PutOptions } from './blob-store.interface.js';

/**
 * A real, working {@link BlobStore} backed by the local filesystem. Keys
 * are treated as `/`-separated paths under `rootDir`; every resolved path
 * is checked to still be inside `rootDir` to prevent `../` traversal
 * escaping the store.
 */
export class LocalFsBlobStore implements AtomicBlobStore {
  constructor(private readonly rootDir: string) {}

  private resolveKey(key: string): string {
    const resolved = resolve(this.rootDir, key);
    const rel = relative(this.rootDir, resolved);
    if (rel.startsWith('..') || rel.split(sep).includes('..')) {
      throw new StorageError(ErrorCode.STORAGE_WRITE_FAILED, `Key escapes store root: "${key}"`);
    }
    return resolved;
  }

  async put(key: string, data: Uint8Array | string, options?: PutOptions): Promise<Result<BlobMetadata, StorageError>> {
    try {
      const path = this.resolveKey(key);
      await mkdir(dirname(path), { recursive: true });
      const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      await writeFile(path, buffer);
      return ok(
        options?.contentType !== undefined
          ? { key, size: buffer.byteLength, contentType: options.contentType }
          : { key, size: buffer.byteLength },
      );
    } catch (cause) {
      return err(new StorageError(ErrorCode.STORAGE_WRITE_FAILED, `Failed to write blob "${key}"`, { cause }));
    }
  }

  private tempPathFor(path: string): string {
    return `${path}.${process.pid}.${randomUUID()}.tmp`;
  }

  /**
   * Atomic create-if-absent: the content is written to a private temp file first, then `link()`ed to the final name. `link` fails
   * with `EEXIST` if the key already exists and otherwise makes the COMPLETE content visible in one step, so there is no window in
   * which another process can observe an empty or partial blob (which `open(..., 'wx')` followed by a write would leave).
   */
  async putIfAbsent(
    key: string,
    data: Uint8Array | string,
    _options?: PutOptions,
  ): Promise<Result<{ readonly created: boolean }, StorageError>> {
    let temp: string | undefined;
    try {
      const path = this.resolveKey(key);
      await mkdir(dirname(path), { recursive: true });
      temp = this.tempPathFor(path);
      await writeFile(temp, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
      try {
        await link(temp, path);
        return ok({ created: true });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'EEXIST') return ok({ created: false });
        throw cause;
      }
    } catch (cause) {
      return err(new StorageError(ErrorCode.STORAGE_WRITE_FAILED, `Failed to create blob "${key}"`, { cause }));
    } finally {
      if (temp !== undefined) await unlink(temp).catch(() => undefined);
    }
  }

  /** Atomic overwrite: write a private temp file, then `rename` over the key (atomic on POSIX filesystems). */
  async replace(key: string, data: Uint8Array | string, options?: PutOptions): Promise<Result<BlobMetadata, StorageError>> {
    let temp: string | undefined;
    try {
      const path = this.resolveKey(key);
      await mkdir(dirname(path), { recursive: true });
      const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      temp = this.tempPathFor(path);
      await writeFile(temp, buffer);
      await rename(temp, path);
      temp = undefined;
      return ok(
        options?.contentType !== undefined
          ? { key, size: buffer.byteLength, contentType: options.contentType }
          : { key, size: buffer.byteLength },
      );
    } catch (cause) {
      return err(new StorageError(ErrorCode.STORAGE_WRITE_FAILED, `Failed to replace blob "${key}"`, { cause }));
    } finally {
      if (temp !== undefined) await unlink(temp).catch(() => undefined);
    }
  }

  async get(key: string): Promise<Result<Uint8Array, StorageError>> {
    try {
      const path = this.resolveKey(key);
      const buffer = await readFile(path);
      return ok(new Uint8Array(buffer));
    } catch (cause) {
      return err(new StorageError(ErrorCode.STORAGE_OBJECT_NOT_FOUND, `Blob not found: "${key}"`, { cause }));
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      await stat(this.resolveKey(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<Result<void, StorageError>> {
    try {
      await unlink(this.resolveKey(key));
      return ok(undefined);
    } catch (cause) {
      return err(new StorageError(ErrorCode.STORAGE_OBJECT_NOT_FOUND, `Failed to delete blob "${key}"`, { cause }));
    }
  }

  async list(prefix = ''): Promise<Result<readonly string[], StorageError>> {
    try {
      const base = this.resolveKey(prefix || '.');
      const keys: string[] = [];
      async function walk(dir: string): Promise<void> {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else keys.push(full);
        }
      }
      await walk(base);
      const root = this.rootDir;
      return ok(keys.map((k) => relative(root, k).split(sep).join('/')));
    } catch (cause) {
      return err(new StorageError(ErrorCode.STORAGE_OBJECT_NOT_FOUND, `Failed to list prefix "${prefix}"`, { cause }));
    }
  }
}
