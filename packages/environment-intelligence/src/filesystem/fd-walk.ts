import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, open, readFile, readdir, readlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { err, ok, type Result } from '@xo/types';
import { DiscoveryErrorCode, discoveryError, type DiscoveryError } from '../errors.js';

/**
 * INTERNAL (not exported from the package index): the filesystem operations
 * the local connector performs, behind one small object so tests can inject
 * races at exact points between a check and the following use. Production
 * code always uses {@link NODE_FS_OPS}. Nothing here widens the public API.
 *
 * `procFdDir`, `mountinfoPath` and `platform` are part of the seam so a test
 * can simulate a host without procfs or a non-Linux platform deterministically.
 */
export interface FsOps {
  open(path: string, flags: number): Promise<FileHandle>;
  readdir(path: string): Promise<string[]>;
  lstat(path: string): Promise<BigIntStats>;
  readlink(path: string): Promise<string>;
  readText(path: string): Promise<string>;
  readonly procFdDir: string;
  readonly mountinfoPath: string;
  readonly platform: NodeJS.Platform;
}

export const NODE_FS_OPS: FsOps = Object.freeze({
  open: (path: string, flags: number) => open(path, flags),
  readdir: (path: string) => readdir(path),
  lstat: (path: string) => lstat(path, { bigint: true }),
  readlink: (path: string) => readlink(path),
  readText: (path: string) => readFile(path, 'utf8'),
  procFdDir: '/proc/self/fd',
  mountinfoPath: '/proc/self/mountinfo',
  platform: process.platform,
});

/** Options of the connector that are not part of its public contract. */
export interface InternalConnectorOptions {
  readonly fsOps?: FsOps;
  /** Maximum simultaneously open descriptors during one operation. Default {@link DEFAULT_FD_BUDGET}. */
  readonly fdBudget?: number;
}

export const DEFAULT_FD_BUDGET = 64;

export const O_DIR_FLAGS = (): number | undefined =>
  typeof constants.O_DIRECTORY === 'number' && typeof constants.O_NOFOLLOW === 'number'
    ? constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    : undefined;

// ---------------------------------------------------------------------------------------------------------------
// Descriptor-anchored traversal (F1).
//
// WHAT THIS IS: a userspace, per-component walk. The approved root is opened once; every later lookup is ONE
// component resolved relative to a descriptor we hold, addressed as `/proc/self/fd/<fd>/<name>` and opened with
// O_NOFOLLOW (|O_DIRECTORY). A directory swapped for a symlink after we hold its descriptor cannot redirect us,
// because we never resolve a multi-component path again.
//
// WHAT THIS IS NOT: `openat2(RESOLVE_BENEATH|NO_SYMLINKS|NO_MAGICLINKS|NO_XDEV)`. That resolves a whole path in a
// single kernel call. This design uses a magic link (`/proc/self/fd/N`, exactly what NO_MAGICLINKS forbids) as its
// anchor, enforces mount limits with a st_dev compare plus a /proc/self/mountinfo snapshot instead of NO_XDEV,
// and has the residual races below. It does NOT provide complete race-free containment.
//
// RESIDUAL RACES (documented, not closed):
//  R1 The root (or an ancestor) swapped between `realpath` and the root `open`. Narrowed by comparing
//     `readlink(/proc/self/fd/<root>)` with the authorized real path; not atomic.
//  R2 An entry swapped between `lstat` and the child `open`. It still resolves beneath the held parent
//     descriptor (it cannot leave the root); dev/ino comparison detects most swaps; the lstat->open window remains.
//  R3 A directory whose descriptor we hold is renamed out of the root afterwards; we keep reading that directory.
//  R4 A mount created AFTER the mountinfo snapshot. A cross-filesystem mount is still caught by the st_dev check;
//     a same-filesystem bind mount created after the snapshot is not.
//  R7 Dependence on procfs magic-link semantics; without them the hardened operations fail closed.
// ---------------------------------------------------------------------------------------------------------------

/** A failure that stops the whole operation (never a per-entry skip). Carries the public error. */
export class FdWalkFatal extends Error {
  constructor(readonly error: DiscoveryError) {
    super(error.message);
  }
}

const fatal = (code: DiscoveryErrorCode, message: string, context: Record<string, string | number | boolean | null> = {}): FdWalkFatal =>
  new FdWalkFatal(discoveryError(code, message, context));

export const errnoCode = (e: unknown): string | null =>
  typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : null;

const ABORTED = Symbol('xo.fd-walk.aborted');

/**
 * Races a pending operation against an abort signal. Resolves/rejects with the operation's own outcome, or rejects
 * with {@link ABORTED} as soon as the signal fires. The underlying operation is NOT cancelled (libuv cannot cancel an
 * in-flight open); the caller owns cleaning up whatever it eventually produces.
 */
function raceAbort<T>(op: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return op;
  if (signal.aborted) return Promise.reject(ABORTED);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    op.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

const cancelled = (): FdWalkFatal =>
  fatal(DiscoveryErrorCode.CANCELLED, 'cancelled while opening a resource', { reason: 'open_cancelled' });

/**
 * Flags for the final component of an acquisition. O_NONBLOCK so opening a FIFO with no writer returns instead of
 * blocking a worker thread; O_NOCTTY so opening a terminal device cannot make it our controlling terminal;
 * O_NOFOLLOW so a symlink is never followed. All three are checked for presence: if the platform lacks any of
 * them, acquisition fails closed rather than opening a special file with weaker flags.
 */
export const O_FILE_FLAGS = (): number | undefined =>
  typeof constants.O_NONBLOCK === 'number' && typeof constants.O_NOFOLLOW === 'number'
    ? constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW | (typeof constants.O_NOCTTY === 'number' ? constants.O_NOCTTY : 0)
    : undefined;

/** Per-entry outcomes that skip the entry (reported in `skipped`), never stop the walk. */
export type SkipReason =
  | 'symlink_not_followed'
  | 'mount_boundary'
  | 'entry_changed'
  | 'unreadable_entry'
  | 'missing'
  | 'not_a_directory'
  | 'not_regular_file'
  | 'hard_linked_file';

export function isValidComponent(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0');
}

/** Unescapes the octal escapes mountinfo uses for space, tab, newline and backslash. */
function unescapeMountPath(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/**
 * Parses `/proc/self/mountinfo` into mount point paths. STRICT: any line that does not have the documented shape,
 * or a file with no lines at all, is an error, so "I could not read it reliably" is never mistaken for "no mounts".
 */
export function parseMountPoints(text: string): Result<readonly string[], string> {
  const points: string[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const f = line.split(' ');
    const sep = f.indexOf('-');
    if (sep < 6 || f.length - sep < 4) return err('malformed mountinfo line');
    if (!/^\d+$/.test(f[0] ?? '') || !/^\d+$/.test(f[1] ?? '') || !/^\d+:\d+$/.test(f[2] ?? '')) return err('malformed mountinfo ids');
    const mp = unescapeMountPath(f[4] ?? '');
    if (!mp.startsWith('/')) return err('malformed mountinfo mount point');
    points.push(mp);
  }
  if (points.length === 0) return err('empty mountinfo');
  return ok(points);
}

class Budget {
  private count = 0;
  constructor(readonly limit: number) {}
  get open(): number {
    return this.count;
  }
  reserve(): void {
    if (this.count >= this.limit)
      throw fatal(DiscoveryErrorCode.LIMIT_EXCEEDED, 'too many directories open at once', { reason: 'fd_budget', limit: this.limit });
  }
  opened(): void {
    this.count += 1;
  }
  closed(): void {
    this.count -= 1;
  }
}

export interface DirNode {
  readonly handle: FileHandle;
  /** Logical absolute path (for mount-point comparison and diagnostics only; never used to open anything). */
  readonly abs: string;
}

export type ChildDir = { readonly kind: 'dir'; readonly node: DirNode } | { readonly kind: 'skip'; readonly reason: SkipReason };

export class AnchoredTree {
  private readonly tracked = new Set<FileHandle>();
  private constructor(
    private readonly ops: FsOps,
    private readonly budget: Budget,
    readonly realRoot: string,
    readonly root: DirNode,
    private readonly rootDev: bigint,
    private readonly nested: ReadonlySet<string>,
  ) {}

  /**
   * Opens and verifies the anchor. Throws {@link FdWalkFatal}; on any failure no descriptor is left open.
   * Order: availability probe (no request path touched) -> root open -> type/readlink anchor check -> mountinfo scan.
   */
  static async open(ops: FsOps, realRoot: string, budgetLimit: number = DEFAULT_FD_BUDGET): Promise<AnchoredTree> {
    const unavailable = (detail: string): FdWalkFatal =>
      fatal(DiscoveryErrorCode.UNSUPPORTED_OPERATION, 'descriptor-anchored traversal is not available on this host', {
        reason: 'fd_traversal_unavailable',
        platform: ops.platform,
        detail,
      });
    // F6: hardened content acquisition is Linux-only. Windows is refused explicitly (its reparse-point/junction and
    // path semantics are not handled by this connector); other non-Linux hosts (macOS) lack the /proc anchor. Neither
    // falls back to a weaker path-based read; the refusal is reported before any request path is touched.
    if (ops.platform === 'win32')
      throw fatal(DiscoveryErrorCode.UNSUPPORTED_OPERATION, 'filesystem content acquisition is not supported on Windows', {
        reason: 'fd_traversal_unavailable',
        platform: ops.platform,
        detail: 'platform_windows_unsupported',
      });
    if (ops.platform !== 'linux') throw unavailable('platform_not_linux');
    const dirFlags = O_DIR_FLAGS();
    if (dirFlags === undefined) throw unavailable('missing_open_flags');
    try {
      const probe = await ops.lstat(ops.procFdDir);
      if (!probe.isDirectory()) throw unavailable('proc_fd_not_a_directory');
    } catch (e) {
      if (e instanceof FdWalkFatal) throw e;
      throw unavailable('proc_fd_unreadable');
    }
    const budget = new Budget(budgetLimit);
    budget.reserve();
    let handle: FileHandle;
    try {
      handle = await ops.open(realRoot, dirFlags);
    } catch (e) {
      const code = errnoCode(e);
      if (code === 'ELOOP' || code === 'ENOTDIR')
        throw fatal(DiscoveryErrorCode.SCOPE_VIOLATION, 'approved root changed after authorization', {
          reason: 'root_changed',
          errno: code,
        });
      if (code === 'ENOENT') throw fatal(DiscoveryErrorCode.SOURCE_UNAVAILABLE, 'approved root does not exist', { errno: code });
      throw fatal(DiscoveryErrorCode.CONNECTION_FAILED, 'approved root is not readable', { errno: code });
    }
    budget.opened();
    const closeRoot = async (): Promise<void> => {
      try {
        await handle.close();
      } catch {
        /* nothing useful to do */
      }
    };
    try {
      const st = await handle.stat({ bigint: true });
      if (!st.isDirectory())
        throw fatal(DiscoveryErrorCode.SCOPE_VIOLATION, 'approved root changed after authorization', { reason: 'root_changed' });
      let anchored: string;
      try {
        anchored = await ops.readlink(`${ops.procFdDir}/${handle.fd}`);
      } catch {
        throw unavailable('proc_fd_readlink_failed');
      }
      if (anchored !== realRoot)
        throw fatal(DiscoveryErrorCode.SCOPE_VIOLATION, 'approved root changed after authorization', { reason: 'root_changed' });
      let text: string;
      try {
        text = await ops.readText(ops.mountinfoPath);
      } catch {
        throw fatal(DiscoveryErrorCode.CONNECTION_FAILED, 'mount information is not available, so nested mounts cannot be excluded', {
          reason: 'mountinfo_unavailable',
        });
      }
      const parsed = parseMountPoints(text);
      if (!parsed.ok)
        throw fatal(DiscoveryErrorCode.CONNECTION_FAILED, 'mount information could not be parsed, so nested mounts cannot be excluded', {
          reason: 'mountinfo_unavailable',
        });
      const prefix = `${realRoot}/`;
      const nested = new Set(parsed.value.filter((p) => p.startsWith(prefix)));
      const tree = new AnchoredTree(ops, budget, realRoot, { handle, abs: realRoot }, st.dev, nested);
      tree.tracked.add(handle);
      return tree;
    } catch (e) {
      await closeRoot();
      budget.closed();
      throw e;
    }
  }

  private proc(node: DirNode, name?: string): string {
    return name === undefined ? `${this.ops.procFdDir}/${node.handle.fd}` : `${this.ops.procFdDir}/${node.handle.fd}/${name}`;
  }

  private async openHandle(path: string, flags: number, signal?: AbortSignal): Promise<FileHandle> {
    this.budget.reserve();
    // The slot is held for the whole life of the open, including an abandoned one, so stalled opens stay bounded
    // by the descriptor budget instead of accumulating.
    this.budget.opened();
    const pending = this.ops.open(path, flags);
    let h: FileHandle;
    try {
      h = await raceAbort(pending, signal);
    } catch (e) {
      if (e === ABORTED) {
        // Abandoned: when (if) the open finishes, close its descriptor and free the slot. Never read from it.
        pending.then(
          async (late) => {
            try {
              await late.close();
            } catch {
              /* nothing useful to do */
            }
            this.budget.closed();
          },
          () => this.budget.closed(),
        );
        throw cancelled();
      }
      this.budget.closed();
      throw e;
    }
    this.tracked.add(h);
    return h;
  }

  async closeHandle(h: FileHandle): Promise<void> {
    if (!this.tracked.delete(h)) return;
    this.budget.closed();
    try {
      await h.close();
    } catch {
      /* closing failed; the descriptor is not usable either way */
    }
  }

  /** Closes everything still open (every exit path calls this in a `finally`). */
  async close(): Promise<void> {
    for (const h of [...this.tracked]) await this.closeHandle(h);
  }

  async release(node: DirNode): Promise<void> {
    if (node !== this.root) await this.closeHandle(node.handle);
  }

  /** Entry names of a held directory, via its descriptor. */
  async list(node: DirNode): Promise<string[]> {
    return this.ops.readdir(this.proc(node));
  }

  async lstatChild(node: DirNode, name: string): Promise<BigIntStats> {
    if (!isValidComponent(name))
      throw fatal(DiscoveryErrorCode.SCOPE_VIOLATION, 'resource is outside the authorized scope', { reason: 'invalid_component' });
    return this.ops.lstat(this.proc(node, name));
  }

  isNestedMount(abs: string): boolean {
    return this.nested.has(abs);
  }

  isOtherDevice(st: BigIntStats): boolean {
    return st.dev !== this.rootDev;
  }

  /** Opens a child directory relative to a held descriptor. `expected` (the enumeration lstat) must match dev+ino. */
  async openChildDir(parent: DirNode, name: string, expected?: BigIntStats, signal?: AbortSignal): Promise<ChildDir> {
    if (!isValidComponent(name))
      throw fatal(DiscoveryErrorCode.SCOPE_VIOLATION, 'resource is outside the authorized scope', { reason: 'invalid_component' });
    const abs = `${parent.abs}/${name}`;
    if (this.nested.has(abs)) return { kind: 'skip', reason: 'mount_boundary' };
    const flags = O_DIR_FLAGS();
    if (flags === undefined)
      throw fatal(DiscoveryErrorCode.UNSUPPORTED_OPERATION, 'descriptor-anchored traversal is not available on this host', {
        reason: 'fd_traversal_unavailable',
        platform: this.ops.platform,
      });
    let h: FileHandle;
    try {
      h = await this.openHandle(this.proc(parent, name), flags, signal);
    } catch (e) {
      if (e instanceof FdWalkFatal) throw e;
      const code = errnoCode(e);
      if (code === 'EMFILE' || code === 'ENFILE')
        throw fatal(DiscoveryErrorCode.LIMIT_EXCEEDED, 'the process is out of file descriptors', { reason: 'fd_exhausted', errno: code });
      if (code === 'ELOOP') return { kind: 'skip', reason: 'symlink_not_followed' };
      if (code === 'ENOENT') return { kind: 'skip', reason: 'missing' };
      if (code === 'ENOTDIR') {
        // O_DIRECTORY|O_NOFOLLOW reports a symlink as ENOTDIR on Linux; tell the two apart for an honest reason.
        try {
          const st = await this.ops.lstat(this.proc(parent, name));
          return { kind: 'skip', reason: st.isSymbolicLink() ? 'symlink_not_followed' : 'not_a_directory' };
        } catch {
          return { kind: 'skip', reason: 'entry_changed' };
        }
      }
      return { kind: 'skip', reason: 'unreadable_entry' };
    }
    let st: BigIntStats;
    try {
      st = await h.stat({ bigint: true });
    } catch {
      await this.closeHandle(h);
      return { kind: 'skip', reason: 'unreadable_entry' };
    }
    if (!st.isDirectory()) {
      await this.closeHandle(h);
      return { kind: 'skip', reason: 'entry_changed' };
    }
    if (st.dev !== this.rootDev) {
      await this.closeHandle(h);
      return { kind: 'skip', reason: 'mount_boundary' };
    }
    if (expected !== undefined && (expected.dev !== st.dev || expected.ino !== st.ino)) {
      await this.closeHandle(h);
      return { kind: 'skip', reason: 'entry_changed' };
    }
    return { kind: 'dir', node: { handle: h, abs } };
  }

  /**
   * Walks all but the last segment of a resource key, holding at most the current directory and its child.
   * Returns the directory node that contains the final component (the caller must `release` it).
   */
  private async walkToParent(segments: readonly string[], signal?: AbortSignal): Promise<Result<DirNode, DiscoveryError>> {
    let cur: DirNode = this.root;
    for (const seg of segments.slice(0, -1)) {
      let next: ChildDir;
      try {
        next = await this.openChildDir(cur, seg, undefined, signal);
      } finally {
        if (cur !== this.root) await this.closeHandle(cur.handle);
      }
      if (next.kind === 'skip') return err(keyError(next.reason));
      cur = next.node;
    }
    return ok(cur);
  }

  /** Pass 1 of acquisition: verify the whole key resolves beneath the root (no read, no open of the final component). */
  async verifyKey(segments: readonly string[], signal?: AbortSignal): Promise<Result<true, DiscoveryError>> {
    const parent = await this.walkToParent(segments, signal);
    if (!parent.ok) return parent;
    try {
      const last = segments[segments.length - 1] ?? '';
      const abs = `${parent.value.abs}/${last}`;
      if (this.nested.has(abs)) return err(keyError('mount_boundary'));
      let st: BigIntStats;
      try {
        st = await this.lstatChild(parent.value, last);
      } catch (e) {
        if (e instanceof FdWalkFatal) throw e;
        return err(keyError(errnoCode(e) === 'ENOENT' ? 'missing' : 'unreadable_entry'));
      }
      if (st.isSymbolicLink()) return err(keyError('symlink_not_followed'));
      if (st.dev !== this.rootDev) return err(keyError('mount_boundary'));
      return ok(true);
    } finally {
      await this.release(parent.value);
    }
  }

  /**
   * Pass 2 of acquisition: open the final component relative to its held parent. The caller closes the handle with
   * `closeHandle`. F3: the entry is lstat'ed and must be a regular file BEFORE it is opened (so a FIFO or device is never
   * opened in the normal case); it is then opened O_NONBLOCK|O_NOCTTY|O_NOFOLLOW (so a swap to a FIFO between the lstat
   * and the open still cannot block); and the opened descriptor is fstat'ed and must be the same regular file. The
   * descriptor, not the path, is the authority: a mismatch closes it without a single byte having been read.
   */
  async openFileForKey(segments: readonly string[], signal?: AbortSignal): Promise<Result<FileHandle, DiscoveryError>> {
    const parent = await this.walkToParent(segments, signal);
    if (!parent.ok) return parent;
    try {
      const last = segments[segments.length - 1] ?? '';
      if (!isValidComponent(last)) return err(keyError('unreadable_entry'));
      if (this.nested.has(`${parent.value.abs}/${last}`)) return err(keyError('mount_boundary'));
      const flags = O_FILE_FLAGS();
      if (flags === undefined)
        throw fatal(DiscoveryErrorCode.UNSUPPORTED_OPERATION, 'safe file open flags are not available on this host', {
          reason: 'file_open_flags_unavailable',
          platform: this.ops.platform,
        });
      let pre: BigIntStats;
      try {
        pre = await this.lstatChild(parent.value, last);
      } catch (e) {
        if (e instanceof FdWalkFatal) throw e;
        return err(keyError(errnoCode(e) === 'ENOENT' ? 'missing' : 'unreadable_entry'));
      }
      if (pre.isSymbolicLink()) return err(keyError('symlink_not_followed'));
      if (!pre.isFile()) return err(keyError('not_regular_file'));
      if (pre.nlink > 1n) return err(keyError('hard_linked_file'));
      let h: FileHandle;
      try {
        h = await this.openHandle(this.proc(parent.value, last), flags, signal);
      } catch (e) {
        if (e instanceof FdWalkFatal) throw e;
        const code = errnoCode(e);
        return err(
          code === 'ELOOP'
            ? keyError('symlink_not_followed')
            : discoveryError(DiscoveryErrorCode.SOURCE_UNAVAILABLE, 'resource could not be opened', { errno: code }),
        );
      }
      try {
        const st = await h.stat({ bigint: true });
        if (st.dev !== this.rootDev) {
          await this.closeHandle(h);
          return err(keyError('mount_boundary'));
        }
        if (!st.isFile()) {
          await this.closeHandle(h);
          return err(keyError('not_regular_file'));
        }
        // F5: the descriptor, not the earlier lstat, decides. A link added since the lstat, or a different inode
        // swapped in, is rejected before any byte is read.
        if (st.nlink > 1n) {
          await this.closeHandle(h);
          return err(keyError('hard_linked_file'));
        }
        if (st.ino !== pre.ino || st.dev !== pre.dev) {
          await this.closeHandle(h);
          return err(keyError('entry_changed'));
        }
      } catch {
        await this.closeHandle(h);
        return err(keyError('unreadable_entry'));
      }
      return ok(h);
    } finally {
      await this.release(parent.value);
    }
  }
}

function keyError(reason: SkipReason): DiscoveryError {
  switch (reason) {
    case 'missing':
      return discoveryError(DiscoveryErrorCode.SOURCE_UNAVAILABLE, 'resource no longer exists', { errno: 'ENOENT' });
    case 'unreadable_entry':
    case 'not_a_directory':
      return discoveryError(DiscoveryErrorCode.CONNECTION_FAILED, 'resource could not be inspected', { reason });
    case 'not_regular_file':
      return discoveryError(DiscoveryErrorCode.UNSUPPORTED_OPERATION, 'resource is not a regular file', { reason });
    case 'hard_linked_file':
      return discoveryError(DiscoveryErrorCode.UNSUPPORTED_OPERATION, 'resource has multiple hard links and is not acquired', { reason });
    case 'entry_changed':
      return discoveryError(DiscoveryErrorCode.SOURCE_UNAVAILABLE, 'resource changed while being opened', { reason });
    default:
      return discoveryError(DiscoveryErrorCode.SCOPE_VIOLATION, 'resource is outside the authorized scope', { reason });
  }
}
