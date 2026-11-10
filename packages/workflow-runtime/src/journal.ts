import { mkdir, open, readdir, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, sha256Hex } from '@xo/workflow-ir';

export interface JournalEntry {
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly prev: string;
  readonly hash: string;
}

export class JournalCorruptError extends Error {
  constructor(
    readonly runId: string,
    detail: string,
  ) {
    super(`journal for ${runId} is corrupt: ${detail}`);
    this.name = 'JournalCorruptError';
  }
}

/** What the runner needs from a journal. `RunStore` is the local disk implementation; leased and remote stores implement it too. */
export interface RunStoreLike {
  create(runId: string): Promise<boolean>;
  append(runId: string, type: string, data: Readonly<Record<string, unknown>>): Promise<JournalEntry>;
  read(runId: string): Promise<JournalEntry[]>;
  list(): Promise<string[]>;
}

export const RUN_ID = /^[A-Za-z0-9_-]{1,96}$/;
const GENESIS = '0'.repeat(64);

/**
 * Append-only, hash-chained, fsynced per-run journal on disk (`<dir>/<runId>/journal.jsonl`). It is both the
 * replay source for crash recovery and the tamper-evident run ledger: each entry commits to the previous one, so
 * edits, deletions and reordering are detected on read. A torn final line (crash mid-append) is dropped; a bad
 * hash anywhere else is a hard error and the run is not resumed.
 *
 * Segments: when the active file reaches `segmentBytes` it is sealed by an atomic rename to `journal.<000001>.jsonl` and a fresh
 * `journal.jsonl` starts. The chain runs across segments unchanged, so `read` verifies the whole run and a deleted, reordered or edited
 * segment is a hard error. Appending never loads the run: it needs only the cached or last-on-disk tail entry. Memory held by the store
 * itself is bounded: at most `maxTrackedRuns` cached tails (least recently used evicted) and no queue entry for an idle run.
 * `window` reads only the newest entries. What bounds memory for a caller is the window; `read` still returns the whole run.
 *
 * One process may write a run at a time. Cross-process exclusion is the lease protocol (section F), not this class.
 */
export interface RunStoreOptions {
  /** Seal the active segment once it holds at least this many bytes. Default 4 MiB. 0 disables sealing. */
  readonly segmentBytes?: number;
  /** Cached tails kept in memory. Default 1024. */
  readonly maxTrackedRuns?: number;
}

const SEGMENT = /^journal\.(\d{6})\.jsonl$/;

export class RunStore implements RunStoreLike {
  private readonly tails = new Map<string, { seq: number; hash: string }>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly segmentBytes: number;
  private readonly maxTrackedRuns: number;
  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
    o: RunStoreOptions = {},
  ) {
    this.segmentBytes = o.segmentBytes ?? 4 * 1024 * 1024;
    this.maxTrackedRuns = Math.max(1, o.maxTrackedRuns ?? 1024);
    if (!Number.isInteger(this.segmentBytes) || this.segmentBytes < 0) throw new Error('segmentBytes must be a non-negative integer');
  }

  private setTail(runId: string, t: { seq: number; hash: string }): void {
    this.tails.delete(runId);
    this.tails.set(runId, t); // Map keeps insertion order: the first key is the least recently used
    while (this.tails.size > this.maxTrackedRuns) this.tails.delete(this.tails.keys().next().value as string);
  }

  private chain(runId: string, next: () => Promise<unknown>): Promise<unknown> {
    const prior = this.queues.get(runId) ?? Promise.resolve();
    const run = prior.then(next);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(runId, settled);
    void settled.then(() => {
      if (this.queues.get(runId) === settled) this.queues.delete(runId); // idle: nothing queued behind it
    });
    return run;
  }

  /** Sealed segment file names for a run, in order. A gap in the numbering is corruption (a segment was removed). */
  private async segments(runId: string): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.path(runId));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const sealed = names.filter((n) => SEGMENT.test(n)).sort();
    sealed.forEach((n, i) => {
      if (Number(SEGMENT.exec(n)![1]) !== i + 1)
        throw new JournalCorruptError(runId, `segment ${String(i + 1).padStart(6, '0')} is missing`);
    });
    return sealed;
  }

  private async sealIfFull(runId: string): Promise<void> {
    if (this.segmentBytes === 0) return;
    const active = join(this.path(runId), 'journal.jsonl');
    let size: number;
    try {
      size = (await stat(active)).size;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    if (size < this.segmentBytes) return;
    const n = (await this.segments(runId)).length + 1;
    await rename(active, join(this.path(runId), `journal.${String(n).padStart(6, '0')}.jsonl`));
  }

  private path(runId: string): string {
    if (!RUN_ID.test(runId)) throw new Error(`invalid run id "${runId}"`);
    return join(this.dir, runId);
  }

  /** At-most-once acceptance: creates the run directory atomically. Returns false if the run already exists. */
  async create(runId: string): Promise<boolean> {
    await mkdir(this.dir, { recursive: true });
    try {
      await mkdir(this.path(runId));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
  }

  async append(runId: string, type: string, data: Readonly<Record<string, unknown>>): Promise<JournalEntry> {
    return this.chain(runId, () => this.appendNow(runId, type, data)) as Promise<JournalEntry>;
  }

  private async appendNow(runId: string, type: string, data: Readonly<Record<string, unknown>>): Promise<JournalEntry> {
    let tail = this.tails.get(runId);
    if (tail === undefined) {
      await this.repairTornTail(runId);
      // Cold start reads only the newest entry (not the whole run); `read` and the runner's replay verify the full chain.
      const last = (await this.window(runId, 1)).at(-1);
      tail = { seq: last?.seq ?? 0, hash: last?.hash ?? GENESIS };
    }
    await this.sealIfFull(runId);
    const body = {
      seq: tail.seq + 1,
      ts: this.now().toISOString(),
      type,
      data: JSON.parse(canonicalJson(data)) as Record<string, unknown>,
      prev: tail.hash,
    };
    const entry: JournalEntry = { ...body, hash: sha256Hex(canonicalJson(body)) };
    const fh = await open(join(this.path(runId), 'journal.jsonl'), 'a');
    try {
      await fh.write(`${JSON.stringify(entry)}\n`);
      await fh.sync();
    } finally {
      await fh.close();
    }
    this.setTail(runId, { seq: entry.seq, hash: entry.hash });
    return entry;
  }

  /** Truncates a torn final line (crash mid-append) so the next append starts on a clean line boundary. */
  private async repairTornTail(runId: string): Promise<void> {
    const file = join(this.path(runId), 'journal.jsonl');
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return;
    }
    if (text === '' || text.endsWith('\n')) return;
    const fh = await open(file, 'r+');
    try {
      await fh.truncate(Buffer.byteLength(text.slice(0, text.lastIndexOf('\n') + 1)));
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  private async segmentTexts(runId: string): Promise<string[]> {
    const texts: string[] = [];
    for (const n of await this.segments(runId)) {
      const t = await readFile(join(this.path(runId), n), 'utf8');
      if (t === '' || !t.endsWith('\n')) throw new JournalCorruptError(runId, `sealed segment ${n} is empty or torn`);
      texts.push(t);
    }
    try {
      texts.push(await readFile(join(this.path(runId), 'journal.jsonl'), 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return texts;
  }

  async read(runId: string): Promise<JournalEntry[]> {
    const text = (await this.segmentTexts(runId)).join('');
    const lines = text.split('\n');
    const torn = !text.endsWith('\n') && text.length > 0;
    const out: JournalEntry[] = [];
    let prev = GENESIS;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (line === '') continue;
      let e: JournalEntry;
      try {
        e = JSON.parse(line) as JournalEntry;
      } catch {
        if (torn && i === lines.length - 1) break; // torn tail from a crash mid-append
        throw new JournalCorruptError(runId, `line ${i + 1} is not JSON`);
      }
      const { hash, ...body } = e;
      if (e.seq !== out.length + 1 || e.prev !== prev || sha256Hex(canonicalJson(body)) !== hash)
        throw new JournalCorruptError(runId, `chain breaks at seq ${e.seq}`);
      out.push(e);
      prev = hash;
    }
    return out;
  }

  /**
   * The newest `n` entries, reading only the last segment(s) needed. Each entry's own hash and the links between consecutive entries in the
   * window are checked; the link from the window's first entry back to the genesis is NOT (use `read` for a full verification). A torn final
   * line is ignored. Memory is bounded by `n` and the segment size, not by the run's length.
   */
  async window(runId: string, n: number): Promise<JournalEntry[]> {
    if (!Number.isInteger(n) || n < 1) throw new Error('window size must be a positive integer');
    const names = [...(await this.segments(runId)), 'journal.jsonl'];
    const got: JournalEntry[] = [];
    for (let i = names.length - 1; i >= 0 && got.length < n; i--) {
      let text: string;
      try {
        text = await readFile(join(this.path(runId), names[i] as string), 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw e;
      }
      const lines = text.split('\n');
      const torn = !text.endsWith('\n') && text.length > 0;
      const here: JournalEntry[] = [];
      for (let j = 0; j < lines.length; j++) {
        if (lines[j] === '') continue;
        try {
          here.push(JSON.parse(lines[j] as string) as JournalEntry);
        } catch {
          if (torn && j === lines.length - 1) break;
          throw new JournalCorruptError(runId, `${names[i]} line ${j + 1} is not JSON`);
        }
      }
      got.unshift(...here);
    }
    const out = got.slice(-n);
    for (let k = 0; k < out.length; k++) {
      const { hash, ...body } = out[k] as JournalEntry;
      const e = out[k] as JournalEntry;
      if (
        sha256Hex(canonicalJson(body)) !== hash ||
        (k > 0 && (e.prev !== (out[k - 1] as JournalEntry).hash || e.seq !== (out[k - 1] as JournalEntry).seq + 1))
      )
        throw new JournalCorruptError(runId, `chain breaks at seq ${e.seq}`);
    }
    return out;
  }

  /**
   * Appends entries produced elsewhere (ledger replication). Every entry must extend the current tail exactly: right seq, right
   * prev hash, valid own hash. Anything else is refused whole; nothing is merged or rewritten.
   */
  async ingest(runId: string, entries: readonly JournalEntry[]): Promise<void> {
    await this.chain(runId, async () => {
      await this.repairTornTail(runId);
      const have = await this.read(runId);
      let seq = have.at(-1)?.seq ?? 0;
      let prev = have.at(-1)?.hash ?? GENESIS;
      const lines: string[] = [];
      for (const e of entries) {
        const { hash, ...body } = e;
        if (e.seq !== seq + 1 || e.prev !== prev || sha256Hex(canonicalJson(body)) !== hash)
          throw new JournalCorruptError(runId, `replicated entry ${e.seq} does not extend the chain`);
        lines.push(JSON.stringify(e));
        seq = e.seq;
        prev = hash;
      }
      if (lines.length === 0) return;
      const fh = await open(join(this.path(runId), 'journal.jsonl'), 'a');
      try {
        await fh.write(`${lines.join('\n')}\n`);
        await fh.sync();
      } finally {
        await fh.close();
      }
      this.setTail(runId, { seq, hash: prev });
    });
  }

  async list(): Promise<string[]> {
    try {
      return (await readdir(this.dir, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && RUN_ID.test(d.name))
        .map((d) => d.name)
        .sort();
    } catch {
      return [];
    }
  }
}
