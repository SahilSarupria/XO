import { mkdir, open, readdir, readFile } from 'node:fs/promises';
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
 * One process may write a run at a time. Cross-process exclusion is the lease protocol (section F), not this class.
 */
export class RunStore implements RunStoreLike {
  private readonly tails = new Map<string, { seq: number; hash: string }>();
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

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
    const prior = this.queues.get(runId) ?? Promise.resolve();
    const next = prior.then(() => this.appendNow(runId, type, data));
    this.queues.set(
      runId,
      next.catch(() => undefined),
    );
    return next;
  }

  private async appendNow(runId: string, type: string, data: Readonly<Record<string, unknown>>): Promise<JournalEntry> {
    let tail = this.tails.get(runId);
    if (tail === undefined) {
      await this.repairTornTail(runId);
      const entries = await this.read(runId);
      const last = entries.at(-1);
      tail = { seq: last?.seq ?? 0, hash: last?.hash ?? GENESIS };
    }
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
    this.tails.set(runId, { seq: entry.seq, hash: entry.hash });
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

  async read(runId: string): Promise<JournalEntry[]> {
    let text: string;
    try {
      text = await readFile(join(this.path(runId), 'journal.jsonl'), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
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
   * Appends entries produced elsewhere (ledger replication). Every entry must extend the current tail exactly: right seq, right
   * prev hash, valid own hash. Anything else is refused whole; nothing is merged or rewritten.
   */
  async ingest(runId: string, entries: readonly JournalEntry[]): Promise<void> {
    const prior = this.queues.get(runId) ?? Promise.resolve();
    const next = prior.then(async () => {
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
      this.tails.set(runId, { seq, hash: prev });
    });
    this.queues.set(
      runId,
      next.catch(() => undefined),
    );
    return next;
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
