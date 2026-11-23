import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * UW-12b (ADR 0052 decision 1): the inbox is always computed from the runs. This cache only remembers what a file (or a small folder)
 * yielded the last time its identity (name, size and modification time) was what it is now, so a read re-derives only what changed and
 * can never disagree with the runs for longer than one read. An unreadable cache is ignored and rebuilt.
 */
interface CacheFile {
  readonly v: 1;
  readonly files: Record<string, { readonly fp: string; readonly entries: unknown }>;
}

/** The identity of every file in a folder (names, sizes, modification times); empty when the folder is missing. */
export async function folderIdentity(dir: string): Promise<string> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const parts: string[] = [];
  for (const n of names.sort()) {
    const s = await stat(join(dir, n)).catch(() => undefined);
    if (s !== undefined) parts.push(`${n}:${s.isDirectory() ? 'd' : s.size}:${Math.trunc(s.mtimeMs)}`);
  }
  return parts.join('|');
}

export class InboxCache {
  /** How many entries this instance had to derive (a test reads it; a hit costs nothing). */
  derived = 0;
  private files: CacheFile['files'] = {};
  private readonly used = new Set<string>();
  private dirty = false;
  private loaded = false;

  constructor(
    private readonly path: string,
    /** Off: every read derives everything (the full walk the cache must always equal). */
    private readonly enabled = true,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.enabled) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<CacheFile>;
      if (parsed.v === 1 && parsed.files !== null && typeof parsed.files === 'object') this.files = parsed.files;
      else this.dirty = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.dirty = true; // unreadable: rebuilt below, never trusted
    }
  }

  /** The entries for `key`, from the cache when `identity` is unchanged, otherwise derived and remembered. */
  async memo<T>(key: string, identity: string, derive: () => Promise<T>): Promise<T> {
    await this.load();
    this.used.add(key);
    const hit = this.files[key];
    if (this.enabled && hit !== undefined && hit.fp === identity) return hit.entries as T;
    this.derived++;
    const entries = await derive();
    if (this.enabled) {
      this.files[key] = { fp: identity, entries };
      this.dirty = true;
    }
    return entries;
  }

  /** Forgets what this read did not touch and writes the file by temp-and-rename (best effort: a failed write costs only speed). */
  async save(): Promise<void> {
    if (!this.enabled) return;
    for (const k of Object.keys(this.files))
      if (!this.used.has(k)) {
        delete this.files[k];
        this.dirty = true;
      }
    if (!this.dirty) return;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify({ v: 1, files: this.files } satisfies CacheFile), { mode: 0o600 });
      await rename(tmp, this.path);
    } catch {
      /* the cache is an optimisation */
    }
  }
}

export const etagOf = (value: unknown): string => `"${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)}"`;
