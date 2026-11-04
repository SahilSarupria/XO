import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalJson } from '@xo/capability-layer';

export interface LedgerEntry {
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly data: unknown;
  readonly prev: string;
  readonly hash: string;
}

const GENESIS = '0'.repeat(64);
const hashOf = (seq: number, ts: string, type: string, data: unknown, prev: string): string =>
  createHash('sha256')
    .update(`${seq}|${ts}|${type}|${canonicalJson(data)}|${prev}`)
    .digest('hex');

export interface VerifyResult {
  readonly ok: boolean;
  readonly entries: number;
  readonly brokenAt?: number;
  readonly reason?: string;
}

export function verifyEntries(entries: readonly LedgerEntry[]): VerifyResult {
  let prev = GENESIS;
  for (const [i, e] of entries.entries()) {
    if (e.seq !== i + 1)
      return { ok: false, entries: entries.length, brokenAt: e.seq, reason: `sequence gap or reorder at position ${i + 1}` };
    if (e.prev !== prev)
      return {
        ok: false,
        entries: entries.length,
        brokenAt: e.seq,
        reason: 'prev hash does not match the preceding entry (entry removed or inserted)',
      };
    if (hashOf(e.seq, e.ts, e.type, e.data, e.prev) !== e.hash)
      return { ok: false, entries: entries.length, brokenAt: e.seq, reason: 'entry content does not match its hash (entry edited)' };
    prev = e.hash;
  }
  return { ok: true, entries: entries.length };
}

/**
 * Append-only, hash-chained JSONL audit log. Each entry commits to the previous
 * one, so editing, deleting, inserting or reordering any past entry breaks every
 * later hash — tamper-*evident* (not tamper-proof: an attacker who can rewrite
 * the whole file can rebuild the chain, which is why the head hash can be
 * anchored elsewhere via {@link head}). Opening a ledger verifies it first and
 * refuses to continue on a broken chain rather than appending to a lie.
 */
export class HashChainLedger {
  private last = GENESIS;
  private seq = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly cache: LedgerEntry[] = [];

  private constructor(
    private readonly path: string,
    private readonly now: () => Date,
  ) {}

  static async open(path: string, now: () => Date = () => new Date()): Promise<HashChainLedger> {
    await mkdir(dirname(path), { recursive: true });
    const ledger = new HashChainLedger(path, now);
    const raw = await readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? '' : Promise.reject(e)));
    const entries = raw
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as LedgerEntry);
    const v = verifyEntries(entries);
    if (!v.ok) throw new Error(`ledger ${path} failed verification at entry ${v.brokenAt}: ${v.reason}`);
    ledger.cache.push(...entries);
    const lastEntry = entries[entries.length - 1];
    if (lastEntry !== undefined) {
      ledger.last = lastEntry.hash;
      ledger.seq = lastEntry.seq;
    }
    return ledger;
  }

  static async verifyFile(path: string): Promise<VerifyResult> {
    const raw = await readFile(path, 'utf8');
    try {
      return verifyEntries(
        raw
          .split('\n')
          .filter((l) => l.trim() !== '')
          .map((l) => JSON.parse(l) as LedgerEntry),
      );
    } catch (e) {
      return { ok: false, entries: 0, reason: `unparseable ledger: ${(e as Error).message}` };
    }
  }

  /** Hash of the newest entry — publish/anchor this externally to make rewriting history detectable. */
  get head(): string {
    return this.last;
  }

  entries(): readonly LedgerEntry[] {
    return this.cache;
  }

  append(type: string, data: unknown): Promise<LedgerEntry> {
    const run = async (): Promise<LedgerEntry> => {
      const seq = this.seq + 1;
      const ts = this.now().toISOString();
      const entry: LedgerEntry = { seq, ts, type, data, prev: this.last, hash: hashOf(seq, ts, type, data, this.last) };
      await appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
      this.seq = seq;
      this.last = entry.hash;
      this.cache.push(entry);
      return entry;
    };
    const p = this.tail.then(run, run); // strictly serialized: a failed write must not let a later one skip the chain
    this.tail = p.catch(() => undefined);
    return p;
  }
}
