/**
 * UW-12a — reading a connected local folder for a workspace source connection.
 *
 * Read-only, bounded and scope-guarded, built on Environment Intelligence's filesystem scope guard (`resolveRoot`, `resolveInside`):
 *   - the approved root is the REAL path (a symlinked root cannot widen what is read) and must lie inside one of the operator's
 *     allowed roots (`XO_SOURCE_FOLDER_ROOTS`); with none configured, folders cannot be connected at all;
 *   - symbolic links are never followed, at any depth; hard-linked files and special files are skipped;
 *   - secret stores and credential-looking files (EI's lists) are never listed or read, only counted;
 *   - a file is opened with O_NOFOLLOW, checked to be a regular file of the size it was listed at, and (where the platform shows it)
 *     its open descriptor is proven to point inside the root, so a file swapped for a link between listing and reading is refused;
 *   - listing is bounded in files, depth and bytes, and says when it stopped early.
 *
 * Nothing is ever written, moved or deleted in the folder.
 */
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { EXCLUDED_DIRECTORY_NAMES, SENSITIVE_FILE_PATTERNS, isInside, resolveInside, resolveRoot } from '@xo/environment-intelligence';

export interface FolderLimits {
  readonly maxFiles: number;
  readonly maxDepth: number;
  /** A single file larger than this is listed as too large and never read. */
  readonly maxFileBytes: number;
  /** All listed files together. */
  readonly maxTotalBytes: number;
}

export const DEFAULT_FOLDER_LIMITS: FolderLimits = Object.freeze({
  maxFiles: 2000,
  maxDepth: 8,
  maxFileBytes: 50 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
});

export interface FolderItem {
  /** Path relative to the root, `/`-separated. */
  readonly key: string;
  readonly name: string;
  /** Lower case, with the dot (`.xlsx`). */
  readonly extension: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
}

export type FolderSkipReason =
  | 'unsupported_format'
  | 'hidden'
  | 'sensitive_name'
  | 'excluded_directory'
  | 'symlink_not_followed'
  | 'not_regular_file'
  | 'hard_linked_file'
  | 'too_large'
  | 'too_deep'
  | 'unreadable';

export interface FolderListing {
  readonly items: readonly FolderItem[];
  /** How many entries were skipped, by reason. Names of skipped entries are never reported. */
  readonly skipped: Readonly<Partial<Record<FolderSkipReason, number>>>;
  /** Set when a limit stopped the listing early: what was listed is a prefix, so absence of an item proves nothing. */
  readonly truncated?: 'max_files' | 'max_total_bytes';
}

export type FolderErrorCode = 'root_not_allowed' | 'root_invalid' | 'root_unavailable' | 'outside_scope' | 'item_changed' | 'item_missing';

export class FolderError extends Error {
  constructor(
    readonly code: FolderErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The approved real root, after checking it against the operator's allowed roots. */
export async function approveRoot(root: string, allowedRoots: readonly string[]): Promise<string> {
  if (allowedRoots.length === 0)
    throw new FolderError('root_not_allowed', 'this instance allows no folders to be connected (the operator sets XO_SOURCE_FOLDER_ROOTS)');
  const r = await resolveRoot(root);
  if (!r.ok)
    throw new FolderError(
      r.error.code === 'EI_SOURCE_UNAVAILABLE' ? 'root_unavailable' : 'root_invalid',
      `the folder cannot be connected: ${r.error.message}`,
    );
  for (const allowed of allowedRoots) {
    let real: string;
    try {
      real = await realpath(allowed);
    } catch {
      continue; // an allowed root that does not exist allows nothing
    }
    if (isInside(real, r.value)) return r.value;
  }
  throw new FolderError('root_not_allowed', 'the folder is not inside a folder this instance allows to be connected');
}

const SENSITIVE = (name: string): boolean => SENSITIVE_FILE_PATTERNS.some((p) => p.test(name));

/** Lists the folder (bounded; never follows a link). `extensions` are the formats the workspace can read. */
export async function listFolder(
  realRoot: string,
  extensions: ReadonlySet<string>,
  limits: FolderLimits = DEFAULT_FOLDER_LIMITS,
): Promise<FolderListing> {
  const items: FolderItem[] = [];
  const skipped: Partial<Record<FolderSkipReason, number>> = {};
  const skip = (r: FolderSkipReason): void => {
    skipped[r] = (skipped[r] ?? 0) + 1;
  };
  let total = 0;
  let truncated: FolderListing['truncated'];
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(dir)).sort();
    } catch {
      skip('unreadable');
      return;
    }
    for (const name of names) {
      if (truncated !== undefined) return;
      const path = join(dir, name);
      const key = rel === '' ? name : `${rel}/${name}`;
      let st;
      try {
        st = await lstat(path);
      } catch {
        skip('unreadable');
        continue;
      }
      if (st.isSymbolicLink()) {
        skip('symlink_not_followed');
        continue;
      }
      if (st.isDirectory()) {
        if (EXCLUDED_DIRECTORY_NAMES.has(name)) skip('excluded_directory');
        else if (name.startsWith('.')) skip('hidden');
        else if (depth + 1 > limits.maxDepth) skip('too_deep');
        else await walk(path, key, depth + 1);
        continue;
      }
      if (!st.isFile()) {
        skip('not_regular_file');
        continue;
      }
      if (name.startsWith('.') || name.startsWith('~$')) {
        skip('hidden'); // dot files and Office lock files
        continue;
      }
      if (SENSITIVE(name)) {
        skip('sensitive_name');
        continue;
      }
      const extension = extname(name).toLowerCase();
      if (!extensions.has(extension)) {
        skip('unsupported_format');
        continue;
      }
      if (st.nlink > 1) {
        skip('hard_linked_file'); // the same bytes reachable from outside the root
        continue;
      }
      if (st.size > limits.maxFileBytes) {
        skip('too_large');
        continue;
      }
      if (items.length >= limits.maxFiles) {
        truncated = 'max_files';
        return;
      }
      if (total + st.size > limits.maxTotalBytes) {
        truncated = 'max_total_bytes';
        return;
      }
      total += st.size;
      items.push({ key, name, extension, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() });
    }
  };
  await walk(realRoot, '', 0);
  return { items, skipped, ...(truncated !== undefined ? { truncated } : {}) };
}

const FILE_FLAGS =
  typeof constants.O_NOFOLLOW === 'number'
    ? constants.O_RDONLY | constants.O_NOFOLLOW | (typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0)
    : undefined;

/** Reads one listed file. Refuses anything that is no longer the regular, in-root file of the size it was listed at. */
export async function readFolderItem(
  realRoot: string,
  item: FolderItem,
  limits: FolderLimits = DEFAULT_FOLDER_LIMITS,
): Promise<Uint8Array> {
  if (FILE_FLAGS === undefined) throw new FolderError('outside_scope', 'this platform cannot open files without following links');
  const inside = await resolveInside(realRoot, item.key);
  if (!inside.ok)
    throw new FolderError(
      inside.error.code === 'EI_SOURCE_UNAVAILABLE' ? 'item_missing' : 'outside_scope',
      `${basename(item.key)} cannot be read: ${inside.error.message}`,
    );
  let fh;
  try {
    fh = await open(inside.value, FILE_FLAGS);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new FolderError('item_missing', `${basename(item.key)} is no longer in the folder`);
    throw new FolderError('outside_scope', `${basename(item.key)} cannot be opened safely (${code ?? 'error'})`);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.nlink > 1) throw new FolderError('outside_scope', `${basename(item.key)} is not a plain file any more`);
    if (st.size > limits.maxFileBytes) throw new FolderError('item_changed', `${basename(item.key)} grew past the size limit`);
    // Where the platform exposes it, prove the descriptor itself points inside the root (closes the swap-after-check window).
    const fdPath = await readlink(`/proc/self/fd/${fh.fd}`).catch(() => undefined);
    if (fdPath !== undefined && !isInside(realRoot, fdPath))
      throw new FolderError('outside_scope', `${basename(item.key)} resolves outside the folder`);
    const bytes = await fh.readFile();
    if (bytes.length > limits.maxFileBytes) throw new FolderError('item_changed', `${basename(item.key)} grew past the size limit`);
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
  } finally {
    await fh.close();
  }
}

/** The folder's last segment: what is shown, never the full path. */
export const folderDisplayName = (realRoot: string): string => basename(realRoot);
