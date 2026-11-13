import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { acquireInstanceLock, type InstanceLock, type LockOptions } from './lock.js';
import { InstanceError, LATEST_SCHEMA_VERSION, LOCK_FILE, readInstance } from './metadata.js';
import { END_OF_ARCHIVE, entryHeader, padding, readTar, TarError, type TarEntryHeader } from './tar.js';

/**
 * UW-17 — instance backups. One `.tar.gz` holds the whole data directory under `data/`, a header first (`xo-backup/BACKUP.json`:
 * which instance, which schema) and a manifest last (`xo-backup/MANIFEST.json`: every file with its size and SHA-256). A restore
 * checks the whole archive against its manifest BEFORE it writes anything, and checks each file again as it writes it.
 *
 * The secrets key is not in the backup (it never lives in the data directory), so a backup restores only where that key is provided.
 */
export const BACKUP_FORMAT = 'xo-backup/1';
const HEADER_PATH = 'xo-backup/BACKUP.json';
const MANIFEST_PATH = 'xo-backup/MANIFEST.json';
const MAX_META_BYTES = 64 * 1024 * 1024;

export interface BackupHeader {
  readonly format: typeof BACKUP_FORMAT;
  readonly instanceId: string;
  readonly schemaVersion: number;
  readonly createdAt: string;
  readonly xoVersion: string;
  /** `stopped`: taken while nothing else held the instance. `live`: taken while it ran; files written meanwhile may disagree. */
  readonly consistency: 'stopped' | 'live';
}

export interface BackupManifest extends BackupHeader {
  readonly directories: readonly string[];
  readonly files: readonly { readonly path: string; readonly size: number; readonly sha256: string }[];
  readonly totalBytes: number;
}

export class BackupError extends Error {}

/** Every path in an archive must be one of ours, relative, and free of anything that could escape the folder it is restored into. */
export function safeArchivePath(p: string): boolean {
  if (p.length === 0 || p.length > 4096 || p.includes('\0') || p.includes('\\') || p.startsWith('/')) return false;
  if (!(p.startsWith('data/') || p === 'data' || p === HEADER_PATH || p === MANIFEST_PATH)) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

async function walk(root: string): Promise<{ dirs: string[]; files: { rel: string; size: number; mode: number; mtime: Date }[] }> {
  const dirs: string[] = [];
  const files: { rel: string; size: number; mode: number; mtime: Date }[] = [];
  const visit = async (rel: string) => {
    const names = (await readdir(join(root, rel))).sort();
    for (const name of names) {
      const r = rel === '' ? name : `${rel}/${name}`;
      if (r === LOCK_FILE || /\.\d+\.tmp$/.test(name)) continue;
      const s = await lstat(join(root, r));
      if (s.isSymbolicLink())
        throw new BackupError(`${join(root, r)} is a symbolic link; the data directory must hold only files and folders`);
      if (s.isDirectory()) {
        dirs.push(r);
        await visit(r);
      } else if (s.isFile()) files.push({ rel: r, size: s.size, mode: s.mode, mtime: s.mtime });
      else throw new BackupError(`${join(root, r)} is not a regular file or folder`);
    }
  };
  await visit('');
  return { dirs, files };
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

export interface CreateBackupOptions {
  readonly dataDir: string;
  readonly outFile: string;
  readonly xoVersion: string;
  readonly now?: () => Date;
  /** Back up while the instance runs. Without it, a running instance is refused (the lock is held) so the copy is consistent. */
  readonly live?: boolean;
  readonly lock?: Omit<LockOptions, 'purpose'>;
}

export interface BackupResult {
  readonly file: string;
  readonly manifest: BackupManifest;
  readonly archiveSha256: string;
  readonly archiveBytes: number;
}

export async function createBackup(opts: CreateBackupOptions): Promise<BackupResult> {
  const meta = await readInstance(opts.dataDir);
  if (meta === undefined) throw new InstanceError(`${opts.dataDir} is not an XO instance`);
  if (await exists(opts.outFile)) throw new BackupError(`${opts.outFile} already exists; choose another name`);
  const outResolved = opts.outFile;
  if (outResolved.startsWith(opts.dataDir.replace(/[\\/]+$/, '') + sep))
    throw new BackupError('the backup file must be outside the data directory');
  let lock: InstanceLock | undefined;
  if (opts.live !== true) lock = await acquireInstanceLock(opts.dataDir, { ...opts.lock, purpose: 'backup' });
  const partial = `${opts.outFile}.partial`;
  try {
    const now = (opts.now ?? (() => new Date()))();
    const header: BackupHeader = {
      format: BACKUP_FORMAT,
      instanceId: meta.instanceId,
      schemaVersion: meta.schemaVersion,
      createdAt: now.toISOString(),
      xoVersion: opts.xoVersion,
      consistency: opts.live === true ? 'live' : 'stopped',
    };
    const { dirs, files } = await walk(opts.dataDir);
    await mkdir(dirname(opts.outFile), { recursive: true });
    const gzip = createGzip({ level: 6 });
    const archiveHash = createHash('sha256');
    let archiveBytes = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _e, cb) {
        archiveHash.update(chunk);
        archiveBytes += chunk.length;
        cb(null, chunk);
      },
    });
    const done = pipeline(gzip, tap, createWriteStream(partial, { flags: 'wx', mode: 0o600 }));
    const write = async (b: Buffer) => {
      if (!gzip.write(b)) await new Promise<void>((r) => gzip.once('drain', r));
    };
    const addBuffer = async (path: string, body: Buffer) => {
      await write(entryHeader({ path, type: 'file', size: body.length, mode: 0o600, mtime: now }));
      await write(body);
      await write(Buffer.alloc(padding(body.length)));
    };

    await addBuffer(HEADER_PATH, Buffer.from(`${JSON.stringify(header, null, 2)}\n`));
    await write(entryHeader({ path: 'data', type: 'directory', size: 0, mode: 0o700, mtime: now }));
    for (const d of dirs) await write(entryHeader({ path: `data/${d}`, type: 'directory', size: 0, mode: 0o700, mtime: now }));
    const manifestFiles: { path: string; size: number; sha256: string }[] = [];
    let totalBytes = 0;
    for (const f of files) {
      await write(entryHeader({ path: `data/${f.rel}`, type: 'file', size: f.size, mode: f.mode & 0o777, mtime: f.mtime }));
      const hash = createHash('sha256');
      let read = 0;
      for await (const chunk of createReadStream(join(opts.dataDir, f.rel), { end: f.size > 0 ? f.size - 1 : 0 })) {
        const b = chunk as Buffer;
        const piece = f.size === 0 ? Buffer.alloc(0) : b.subarray(0, Math.min(b.length, f.size - read));
        read += piece.length;
        hash.update(piece);
        await write(piece);
        if (read >= f.size) break;
      }
      if (read !== f.size)
        throw new BackupError(`${f.rel} changed size while it was being backed up; take the backup with the instance stopped`);
      await write(Buffer.alloc(padding(f.size)));
      manifestFiles.push({ path: `data/${f.rel}`, size: f.size, sha256: hash.digest('hex') });
      totalBytes += f.size;
    }
    const manifest: BackupManifest = {
      ...header,
      directories: ['data', ...dirs.map((d) => `data/${d}`)],
      files: manifestFiles,
      totalBytes,
    };
    await addBuffer(MANIFEST_PATH, Buffer.from(`${JSON.stringify(manifest)}\n`));
    await write(END_OF_ARCHIVE);
    gzip.end();
    await done;
    await rename(partial, opts.outFile);
    return { file: opts.outFile, manifest, archiveSha256: archiveHash.digest('hex'), archiveBytes };
  } catch (cause) {
    await rm(partial, { force: true });
    throw cause;
  } finally {
    await lock?.release();
  }
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly header?: BackupHeader;
  readonly manifest?: BackupManifest;
  readonly problems: readonly string[];
}

/** Reads the whole archive and checks it against its manifest: every file present, the right size, the right hash, nothing extra. */
export async function verifyBackup(file: string): Promise<VerifyResult> {
  const problems: string[] = [];
  const seen = new Map<string, { size: number; sha256: string }>();
  const dirsSeen = new Set<string>();
  let headerText = '';
  let manifestText = '';
  try {
    await readTar(createReadStream(file).pipe(createGunzip()), (entry: TarEntryHeader) => {
      if (!safeArchivePath(entry.path)) {
        problems.push(`unsafe or unexpected path in the archive: ${JSON.stringify(entry.path.slice(0, 200))}`);
        return undefined;
      }
      if (entry.type === 'directory') {
        dirsSeen.add(entry.path);
        return undefined;
      }
      if (
        seen.has(entry.path) ||
        (entry.path === HEADER_PATH && headerText !== '') ||
        (entry.path === MANIFEST_PATH && manifestText !== '')
      ) {
        problems.push(`${entry.path} appears twice`);
      }
      if (entry.path === HEADER_PATH || entry.path === MANIFEST_PATH) {
        if (entry.size > MAX_META_BYTES) {
          problems.push(`${entry.path} is too large`);
          return undefined;
        }
        const parts: Buffer[] = [];
        return {
          write: (c) => void parts.push(c),
          end: () => {
            if (entry.path === HEADER_PATH) headerText = Buffer.concat(parts).toString('utf8');
            else manifestText = Buffer.concat(parts).toString('utf8');
          },
        };
      }
      const hash = createHash('sha256');
      let size = 0;
      return {
        write: (c) => {
          size += c.length;
          hash.update(c);
        },
        end: () => void seen.set(entry.path, { size, sha256: hash.digest('hex') }),
      };
    });
  } catch (cause) {
    const message =
      cause instanceof TarError
        ? cause.message
        : cause instanceof Error
          ? `cannot read the archive: ${cause.message}`
          : 'cannot read the archive';
    return { ok: false, problems: [...problems, message] };
  }
  let header: BackupHeader | undefined;
  let manifest: BackupManifest | undefined;
  try {
    header = JSON.parse(headerText) as BackupHeader;
  } catch {
    problems.push('the archive has no readable backup header (is it an XO backup?)');
  }
  try {
    manifest = JSON.parse(manifestText) as BackupManifest;
  } catch {
    problems.push('the archive has no readable manifest (it may be truncated)');
  }
  if (header !== undefined && header.format !== BACKUP_FORMAT) problems.push(`unknown backup format "${String(header.format)}"`);
  if (header !== undefined && manifest !== undefined) {
    for (const k of ['instanceId', 'schemaVersion', 'createdAt'] as const)
      if (header[k] !== manifest[k]) problems.push(`the header and manifest disagree on ${k}`);
    const listed = new Set<string>();
    for (const f of manifest.files) {
      listed.add(f.path);
      const got = seen.get(f.path);
      if (got === undefined) problems.push(`${f.path} is listed but missing`);
      else if (got.size !== f.size || got.sha256 !== f.sha256)
        problems.push(`${f.path} does not match its recorded hash (the archive was altered or damaged)`);
    }
    for (const p of seen.keys()) if (!listed.has(p)) problems.push(`${p} is in the archive but not in the manifest`);
    for (const d of manifest.directories) if (!dirsSeen.has(d)) problems.push(`folder ${d} is listed but missing`);
  }
  return {
    ok: problems.length === 0,
    ...(header !== undefined ? { header } : {}),
    ...(manifest !== undefined ? { manifest } : {}),
    problems,
  };
}

export interface RestoreOptions {
  readonly file: string;
  readonly dataDir: string;
  /** Replace a non-empty data directory. The old one is moved aside (never deleted) and its new location reported. */
  readonly force?: boolean;
  readonly now?: () => Date;
  readonly latestSchemaVersion?: number;
  readonly lock?: Omit<LockOptions, 'purpose'>;
}

export interface RestoreResult {
  readonly header: BackupHeader;
  readonly files: number;
  readonly bytes: number;
  /** Where the directory that was replaced now is (only with `force`). */
  readonly replacedDirMovedTo?: string;
}

export async function restoreBackup(opts: RestoreOptions): Promise<RestoreResult> {
  const v = await verifyBackup(opts.file);
  if (!v.ok || v.header === undefined || v.manifest === undefined) {
    throw new BackupError(`the backup failed verification; nothing was written:\n  - ${v.problems.join('\n  - ')}`);
  }
  const latest = opts.latestSchemaVersion ?? LATEST_SCHEMA_VERSION;
  if (v.header.schemaVersion > latest) {
    throw new BackupError(
      `the backup is at schema ${v.header.schemaVersion}, newer than this XO understands (${latest}); restore it with a newer XO`,
    );
  }
  const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-');
  const target = opts.dataDir.replace(/[\\/]+$/, '');
  let movedTo: string | undefined;
  if (await exists(target)) {
    const entries = await readdir(target);
    if (entries.length > 0) {
      if (opts.force !== true)
        throw new BackupError(`${target} is not empty; restore into an empty folder, or pass --force to move it aside first`);
      // Refuses while the instance runs; the lock moves aside with the folder and is removed there.
      await acquireInstanceLock(target, { ...opts.lock, purpose: 'restore' });
      movedTo = `${target}.replaced-${stamp}`;
      await rename(target, movedTo);
      await rm(join(movedTo, LOCK_FILE), { force: true });
    } else await rm(target, { recursive: true });
  }
  const staging = `${target}.restoring-${stamp}`;
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const expected = new Map(v.manifest.files.map((f) => [f.path, f]));
  let files = 0;
  let bytes = 0;
  try {
    await readTar(createReadStream(opts.file).pipe(createGunzip()), async (entry) => {
      if (!safeArchivePath(entry.path)) throw new BackupError(`unsafe path ${entry.path}`);
      if (!entry.path.startsWith('data')) return undefined;
      const rel = entry.path === 'data' ? '' : entry.path.slice('data/'.length);
      const dest = rel === '' ? staging : join(staging, ...rel.split('/'));
      if (entry.type === 'directory') {
        await mkdir(dest, { recursive: true, mode: 0o700 });
        return undefined;
      }
      const want = expected.get(entry.path);
      if (want === undefined) throw new BackupError(`${entry.path} appeared that verification did not see`);
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      const out = createWriteStream(dest, { flags: 'wx', mode: (entry.mode & 0o700) | 0o600 });
      const hash = createHash('sha256');
      const pass = new PassThrough();
      const written = pipeline(pass, out);
      return {
        write: async (c) => {
          hash.update(c);
          if (!pass.write(c)) await new Promise<void>((r) => pass.once('drain', r));
        },
        end: async () => {
          pass.end();
          await written;
          if (hash.digest('hex') !== want.sha256) throw new BackupError(`${entry.path} changed between verification and restore`);
          files++;
          bytes += want.size;
        },
      };
    });
    if ((await readInstance(staging)) === undefined)
      throw new BackupError('the backup holds no instance.json; it is not an instance backup');
    await rename(staging, target);
  } catch (cause) {
    await rm(staging, { recursive: true, force: true });
    if (movedTo !== undefined && !(await exists(target))) await rename(movedTo, target).catch(() => undefined);
    throw cause;
  }
  return { header: v.header, files, bytes, ...(movedTo !== undefined ? { replacedDirMovedTo: movedTo } : {}) };
}

/** Files and bytes under a directory (for status and erasure receipts). */
export async function directoryUsage(dir: string): Promise<{ readonly files: number; readonly bytes: number }> {
  let files = 0;
  let bytes = 0;
  const visit = async (p: string) => {
    let s;
    try {
      s = await lstat(p);
    } catch {
      return;
    }
    if (s.isDirectory()) for (const n of await readdir(p)) await visit(join(p, n));
    else {
      files++;
      bytes += s.size;
    }
  };
  await visit(dir);
  return { files, bytes };
}
