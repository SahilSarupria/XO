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

/** Per-entry outcomes that skip the entry (reported in `skipped`), never stop the walk. */
export type SkipReason = 'symlink_not_followed' | 'mount_boundary' | 'entry_changed' | 'unreadable_entry' | 'missing' | 'not_a_directory';

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

  private async openHandle(path: string, flags: number): Promise<FileHandle> {
    this.budget.reserve();
    const h = await this.ops.open(path, flags);
    this.budget.opened();
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
  async openChildDir(parent: DirNode, name: string, expected?: BigIntStats): Promise<ChildDir> {
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
      h = await this.openHandle(this.proc(parent, name), flags);
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
  private async walkToParent(segments: readonly string[]): Promise<Result<DirNode, DiscoveryError>> {
    let cur: DirNode = this.root;
    for (const seg of segments.slice(0, -1)) {
      const next = await this.openChildDir(cur, seg);
      await this.release(cur);
      if (next.kind === 'skip') return err(keyError(next.reason));
      cur = next.node;
    }
    return ok(cur);
  }

  /** Pass 1 of acquisition: verify the whole key resolves beneath the root (no read, no open of the final component). */
  async verifyKey(segments: readonly string[]): Promise<Result<true, DiscoveryError>> {
    const parent = await this.walkToParent(segments);
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

  /** Pass 2 of acquisition: open the final component relative to its held parent. The caller closes the handle with `closeHandle`. */
  async openFileForKey(segments: readonly string[]): Promise<Result<FileHandle, DiscoveryError>> {
    const parent = await this.walkToParent(segments);
    if (!parent.ok) return parent;
    try {
      const last = segments[segments.length - 1] ?? '';
      if (!isValidComponent(last)) return err(keyError('unreadable_entry'));
      if (this.nested.has(`${parent.value.abs}/${last}`)) return err(keyError('mount_boundary'));
      let h: FileHandle;
      try {
        h = await this.openHandle(this.proc(parent.value, last), constants.O_RDONLY | constants.O_NOFOLLOW);
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
    default:
      return discoveryError(DiscoveryErrorCode.SCOPE_VIOLATION, 'resource is outside the authorized scope', { reason });
  }
}
