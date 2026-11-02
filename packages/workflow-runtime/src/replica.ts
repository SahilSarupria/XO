import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RUN_ID, type JournalEntry, type RunStore } from './journal.js';

export type IngestResult =
  | { readonly status: 'appended'; readonly appended: number; readonly tail: number }
  | { readonly status: 'duplicate'; readonly tail: number }
  | { readonly status: 'gap'; readonly tail: number; readonly detail: string }
  | { readonly status: 'fork'; readonly atSeq: number; readonly detail: string }
  | { readonly status: 'quarantined'; readonly detail: string }
  | { readonly status: 'invalid'; readonly detail: string };

export interface ForkEvent {
  readonly runId: string;
  readonly atSeq: number;
  readonly ours: string;
  readonly theirs: string;
}

/**
 * Server-side replica of a local run ledger. The local runner pushes its append-only hash chain; the replica verifies every link.
 * Identical entries are a no-op, a gap asks for the missing range, and an entry that conflicts with one already held (same
 * sequence number, different hash) is a FORK: it is never merged. The run is quarantined (further pushes refused until an operator
 * clears it), the fork is recorded durably and `onFork` fires so it can be escalated to a human.
 */
export class LedgerReplica {
  constructor(
    private readonly dir: string,
    private readonly store: RunStore,
    private readonly onFork?: (e: ForkEvent) => void | Promise<void>,
  ) {}

  private forkFile(runId: string): string {
    return join(this.dir, `${runId}.fork.json`);
  }

  async quarantined(runId: string): Promise<ForkEvent | undefined> {
    try {
      return JSON.parse(await readFile(this.forkFile(runId), 'utf8')) as ForkEvent;
    } catch {
      return undefined;
    }
  }

  async ingest(runId: string, entries: readonly JournalEntry[]): Promise<IngestResult> {
    if (!RUN_ID.test(runId)) return { status: 'invalid', detail: 'invalid run id' };
    if (entries.length === 0) return { status: 'invalid', detail: 'no entries' };
    if (entries.length > 5000) return { status: 'invalid', detail: 'too many entries in one push' };
    const q = await this.quarantined(runId);
    if (q !== undefined) return { status: 'quarantined', detail: `run is quarantined after a fork at seq ${q.atSeq}` };
    await this.store.create(runId);
    const have = await this.store.read(runId);
    const first = entries[0] as JournalEntry;
    if (first.seq > have.length + 1)
      return { status: 'gap', tail: have.length, detail: `have ${have.length} entries, push starts at ${first.seq}` };
    const fresh: JournalEntry[] = [];
    for (const e of entries) {
      const mine = have[e.seq - 1];
      if (mine === undefined) fresh.push(e);
      else if (mine.hash !== e.hash) {
        const ev: ForkEvent = { runId, atSeq: e.seq, ours: mine.hash, theirs: e.hash };
        await mkdir(this.dir, { recursive: true });
        await writeFile(this.forkFile(runId), JSON.stringify(ev));
        await this.onFork?.(ev);
        return { status: 'fork', atSeq: e.seq, detail: `entry ${e.seq} conflicts with the replicated chain; not merged` };
      }
    }
    if (fresh.length === 0) return { status: 'duplicate', tail: have.length };
    try {
      await this.store.ingest(runId, fresh);
    } catch (e) {
      return { status: 'invalid', detail: (e as Error).message };
    }
    return { status: 'appended', appended: fresh.length, tail: have.length + fresh.length };
  }
}
