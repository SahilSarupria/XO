import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Result } from '@xo/types';
import { err, ok } from '@xo/types';
import { ErrorCode, NotFoundError, StorageError, XoError } from '@xo/errors';
import type { IdentityBinding, IdentityBindingStore } from './binding-store.interface.js';

const SUBDIR = join('identity-bindings', 'by-subject');
const MAX_RECORD_BYTES = 16 * 1024;
const RECORD_NAME = /^[0-9a-f]{64}\.json$/;

/** Hash of the JSON pair, so (issuer, subject) boundaries are unambiguous and no subject text becomes a path. */
export function computeBindingId(issuer: string, subject: string): string {
  return createHash('sha256')
    .update(JSON.stringify([issuer, subject]))
    .digest('hex');
}

function isErrno(cause: unknown, code: string): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === code;
}

function decode(text: string, issuer: string, subject: string): IdentityBinding | undefined {
  try {
    const record = JSON.parse(text) as IdentityBinding;
    // Defence in depth: the stored pair, and the id derived from it, must be exactly what was asked for.
    if (record.issuer !== issuer || record.subject !== subject || record.bindingId !== computeBindingId(issuer, subject)) {
      return undefined;
    }
    return record;
  } catch {
    return undefined;
  }
}

/**
 * Filesystem binding store: one JSON record per (issuer, subject), named by its hash.
 *
 * Writes are atomic and, where the filesystem allows, durable (a private temp file is fsynced, renamed over the record, and the directory fsynced), so a concurrent
 * request sees the whole old record or the whole new one and never a torn file. Files are created
 * 0600 and directories 0700. Reads refuse symlinks and non-regular files and are size-bounded; a
 * record that does not parse, does not match its own name, or is not a regular file is reported as
 * absent, which the middleware answers as "unbound" (fail closed). There is no in-memory cache, so a
 * revocation applies to the next request.
 *
 * The bindings directory is the authorization list: whoever can write it can bind any identity. It
 * is operator-owned, at the same trust level as starting the server.
 */
export class FsIdentityBindingStore implements IdentityBindingStore {
  private readonly dir: string;
  constructor(rootDir: string) {
    this.dir = join(rootDir, SUBDIR);
  }

  private pathFor(issuer: string, subject: string): string {
    return join(this.dir, `${computeBindingId(issuer, subject)}.json`);
  }

  /** `undefined` when absent or untrustworthy; throws only for genuine I/O failure. */
  private async readRecord(path: string, issuer: string, subject: string): Promise<IdentityBinding | undefined> {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (cause) {
      if (isErrno(cause, 'ENOENT') || isErrno(cause, 'ELOOP') || isErrno(cause, 'ENOTDIR')) return undefined;
      throw cause;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return undefined;
      return decode(await handle.readFile({ encoding: 'utf8' }), issuer, subject);
    } finally {
      await handle.close();
    }
  }

  private async writeRecord(binding: IdentityBinding): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = this.pathFor(binding.issuer, binding.subject);
    const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await handle.writeFile(JSON.stringify(binding), { encoding: 'utf8' });
      await handle.sync();
    } catch (cause) {
      await handle.close();
      await unlink(tmp).catch(() => undefined);
      throw cause;
    }
    await handle.close();
    try {
      await rename(tmp, target);
    } catch (cause) {
      await unlink(tmp).catch(() => undefined);
      throw cause;
    }
    await this.syncDirectory();
  }

  /**
   * Persist the rename itself: without this, a power loss after a revocation was acknowledged could bring
   * the previous (active) record back. Filesystems that cannot fsync a directory (some FUSE/network mounts,
   * and Windows, which cannot open one) are tolerated: atomicity still holds there, only crash-durability
   * of the directory entry is best-effort.
   */
  private async syncDirectory(): Promise<void> {
    let handle;
    try {
      handle = await open(this.dir, constants.O_RDONLY);
    } catch (cause) {
      if (isErrno(cause, 'EISDIR') || isErrno(cause, 'EPERM') || isErrno(cause, 'EACCES')) return;
      throw cause;
    }
    try {
      await handle.sync();
    } catch (cause) {
      if (!(isErrno(cause, 'EINVAL') || isErrno(cause, 'ENOTSUP') || isErrno(cause, 'EPERM'))) throw cause;
    } finally {
      await handle.close();
    }
  }

  /**
   * Create-only-if-absent. The record is written completely and fsynced to a private temp file, then published with
   * `link(2)`, which fails with EEXIST if ANY entry (file, corrupt file, symlink, dangling symlink) already has the target
   * name. So concurrent creators get exactly one winner, the winner's record is never visible half-written, and an existing
   * record of any kind (revoked or corrupt included) is never replaced. A revocation cannot be overwritten either: `revoke`
   * only acts on an existing record, and this method never replaces one. If the filesystem cannot hard-link, the call
   * fails closed with a storage error; it does NOT fall back to an overwriting write.
   */
  async createIfAbsent(binding: IdentityBinding): Promise<Result<void, XoError>> {
    const target = this.pathFor(binding.issuer, binding.subject);
    const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.new`;
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        await handle.writeFile(JSON.stringify(binding), { encoding: 'utf8' });
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(tmp, target);
    } catch (cause) {
      await unlink(tmp).catch(() => undefined);
      if (isErrno(cause, 'EEXIST')) return err(new XoError(ErrorCode.ALREADY_EXISTS, 'a binding record already exists for this identity'));
      return err(new StorageError(ErrorCode.STORAGE_WRITE_FAILED, 'could not write the binding record', { cause }));
    }
    await unlink(tmp).catch(() => undefined);
    await this.syncDirectory().catch(() => undefined);
    return ok(undefined);
  }

  async create(binding: IdentityBinding): Promise<Result<void, XoError>> {
    const found = await this.find(binding.issuer, binding.subject);
    if (!found.ok) return err(found.error);
    if (found.value !== undefined && found.value.revokedAt === undefined) {
      return err(new XoError(ErrorCode.ALREADY_EXISTS, 'an active binding already exists for this identity'));
    }
    try {
      await this.writeRecord(binding);
    } catch (cause) {
      return err(new StorageError(ErrorCode.STORAGE_WRITE_FAILED, 'could not write the binding record', { cause }));
    }
    return ok(undefined);
  }

  async find(issuer: string, subject: string): Promise<Result<IdentityBinding | undefined, XoError>> {
    try {
      return ok(await this.readRecord(this.pathFor(issuer, subject), issuer, subject));
    } catch (cause) {
      return err(new XoError(ErrorCode.UNKNOWN, 'could not read the binding record', { cause }));
    }
  }

  async revoke(issuer: string, subject: string): Promise<Result<{ readonly alreadyRevoked: boolean }, XoError>> {
    const found = await this.find(issuer, subject);
    if (!found.ok) return err(found.error);
    if (found.value === undefined) return err(new NotFoundError('identity binding'));
    if (found.value.revokedAt !== undefined) return ok({ alreadyRevoked: true });
    try {
      await this.writeRecord({ ...found.value, revokedAt: new Date().toISOString() });
    } catch (cause) {
      return err(new StorageError(ErrorCode.STORAGE_WRITE_FAILED, 'could not write the binding record', { cause }));
    }
    return ok({ alreadyRevoked: false });
  }

  async list(): Promise<Result<readonly IdentityBinding[], XoError>> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (cause) {
      if (isErrno(cause, 'ENOENT')) return ok([]);
      return err(new XoError(ErrorCode.UNKNOWN, 'could not list binding records', { cause }));
    }
    const out: IdentityBinding[] = [];
    for (const name of names.filter((n) => RECORD_NAME.test(n)).sort()) {
      try {
        const path = join(this.dir, name);
        // Read without knowing the pair, then require the record to match its own file name.
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) continue;
          const record = JSON.parse(await handle.readFile({ encoding: 'utf8' })) as IdentityBinding;
          // Listed only if find() would honour it: the name, the stored pair and the stored id must all agree.
          if (typeof record.issuer === 'string' && typeof record.subject === 'string') {
            const id = computeBindingId(record.issuer, record.subject);
            if (`${id}.json` === name && record.bindingId === id) out.push(record);
          }
        } finally {
          await handle.close();
        }
      } catch {
        // unreadable, symlinked or corrupt: omitted from the listing and never honoured by find()
      }
    }
    return ok(out);
  }
}
