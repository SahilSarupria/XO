import { JournalCorruptError, type JournalEntry, type RunStoreLike } from './journal.js';

/**
 * Anchoring of run journals. A run's hash chain detects an edited or removed middle entry, but someone who can rewrite a whole run directory can
 * rebuild a consistent chain, or cut a run short. Publishing `(runId, seq, hash)` to a place that person cannot also edit makes both detectable:
 * verification fails if the journal is shorter than an anchored position, has a different hash there, or the run is gone.
 *
 * A sink is structurally the same as the `@xo/automation` ledger sinks (`FileAnchorSink`, `WebhookAnchorSink`), which can be passed in directly;
 * `runId` is an extra field they write through. What this does NOT give: protection when the sink itself is writable by the attacker, anchors for
 * entries appended after the last anchor (a run can be cut back to its last anchor undetected), or any ordering guarantee between runs.
 */
export interface RunAnchor {
  readonly runId: string;
  readonly seq: number;
  readonly hash: string;
  readonly at: string;
}

export interface RunAnchorSink {
  readonly id: string;
  publish(anchor: RunAnchor): Promise<void>;
}

export interface AnchoredStoreOptions {
  /** Anchor every N-th entry as well as every run end, escalation, approval decision, received event, connector outcome and ambiguous effect. Default 25. */
  readonly every?: number;
  /** A sink that does not answer in this time counts as failed. Default 5000 ms. */
  readonly timeoutMs?: number;
  /** Called for every sink failure. Anchoring never stops a run (like the desk ledger): a failure is counted, reported here, and the run goes on. */
  readonly onFailure?: (sink: string, anchor: RunAnchor, error: Error) => void;
  readonly now?: () => Date;
}

const ANCHOR_ON = new Set(['run_finished', 'effect_ambiguous', 'escalation', 'approval_decided', 'event_received', 'call_outcome']);

export class AnchoredRunStore implements RunStoreLike {
  failures = 0;
  published = 0;
  private readonly every: number;
  private readonly timeoutMs: number;
  constructor(
    private readonly inner: RunStoreLike,
    private readonly sinks: readonly RunAnchorSink[],
    private readonly o: AnchoredStoreOptions = {},
  ) {
    this.every = o.every ?? 25;
    this.timeoutMs = o.timeoutMs ?? 5000;
    if (!Number.isInteger(this.every) || this.every < 1) throw new Error('anchor interval must be a positive integer');
    if (sinks.length === 0) throw new Error('AnchoredRunStore needs at least one sink');
  }

  create(runId: string): Promise<boolean> {
    return this.inner.create(runId);
  }
  read(runId: string): Promise<JournalEntry[]> {
    return this.inner.read(runId);
  }
  list(): Promise<string[]> {
    return this.inner.list();
  }

  async append(runId: string, type: string, data: Readonly<Record<string, unknown>>): Promise<JournalEntry> {
    const e = await this.inner.append(runId, type, data);
    if (e.seq % this.every === 0 || ANCHOR_ON.has(type))
      await this.publish({ runId, seq: e.seq, hash: e.hash, at: (this.o.now?.() ?? new Date()).toISOString() });
    return e;
  }

  private async publish(a: RunAnchor): Promise<void> {
    await Promise.all(
      this.sinks.map(async (s) => {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            s.publish(a),
            new Promise<never>(
              (_, rej) =>
                (timer = setTimeout(() => rej(new Error(`anchor sink did not answer within ${this.timeoutMs} ms`)), this.timeoutMs)),
            ),
          ]);
          this.published++;
        } catch (err) {
          this.failures++;
          this.o.onFailure?.(s.id, a, err instanceof Error ? err : new Error(String(err)));
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }),
    );
  }
}

export interface AnchorVerification {
  readonly ok: boolean;
  readonly anchors: number;
  readonly runs: number;
  readonly problems: readonly string[];
}

/** Checks every anchor against the journals: the run exists, its chain verifies, and the entry at the anchored position has the anchored hash. */
export async function verifyRunAnchors(store: RunStoreLike, anchors: readonly RunAnchor[]): Promise<AnchorVerification> {
  const problems: string[] = [];
  const byRun = new Map<string, RunAnchor[]>();
  for (const a of anchors) {
    if (typeof a.runId !== 'string' || !Number.isInteger(a.seq) || a.seq < 1 || typeof a.hash !== 'string') {
      problems.push(`malformed anchor: ${JSON.stringify(a).slice(0, 120)}`);
      continue;
    }
    byRun.set(a.runId, [...(byRun.get(a.runId) ?? []), a]);
  }
  for (const [runId, list] of byRun) {
    let entries: JournalEntry[];
    try {
      entries = await store.read(runId);
    } catch (e) {
      problems.push(
        e instanceof JournalCorruptError
          ? `run ${runId}: journal is corrupt (${e.message})`
          : `run ${runId}: cannot be read (${(e as Error).message})`,
      );
      continue;
    }
    if (entries.length === 0) {
      problems.push(`run ${runId}: journal is missing or empty but ${list.length} anchor(s) exist — run removed`);
      continue;
    }
    for (const a of list) {
      const e = entries[a.seq - 1];
      if (e === undefined)
        problems.push(`run ${runId}: anchor at seq ${a.seq} is beyond the journal's end (${entries.length}) — journal truncated`);
      else if (e.hash !== a.hash) problems.push(`run ${runId}: anchor at seq ${a.seq} does not match — history was rewritten`);
    }
  }
  return { ok: problems.length === 0, anchors: anchors.length, runs: byRun.size, problems };
}
