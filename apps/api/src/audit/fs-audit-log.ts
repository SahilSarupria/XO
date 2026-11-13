import { randomUUID } from 'node:crypto';
import { checkAnchors, type AnchorCheck, type AuditAnchorSink, type PurgedRange } from './anchor.js';
import type { BlobStore } from '@xo/storage';
import { ErrorCode } from '@xo/errors';
import {
  computeEntryHash,
  GENESIS_HASH,
  type AuditActor,
  type AuditEntry,
  type AuditEventInput,
  type AuditEventType,
  type AuditResult,
  type AuditVerification,
} from './audit-entry.js';

const ENTRY_PREFIX = 'entries/';
const HEAD_KEY = 'head.json';
/** UW-1: the purge pointer. Absent until the first purge. */
const BASE_KEY = 'base.json';
const DAY_MS = 86_400_000;

function entryKey(seq: number): string {
  return `${ENTRY_PREFIX}${String(seq).padStart(12, '0')}.json`;
}

interface Head {
  readonly seq: number;
  readonly hash: string;
}

/** UW-1: entries 1..seq were purged; the chain continues from `hash`; `purgeEventSeq` is the `audit.purged` record that says so. */
interface Base {
  readonly seq: number;
  readonly hash: string;
  readonly purgeEventSeq: number;
}

export interface AuditPurgeRequest {
  /** Entries older than this many days are removed. Must be a positive integer (the operator's declared retention). */
  readonly retentionDays: number;
  /** Who ran the purge (an operator, recorded in the purge record). */
  readonly actor: AuditActor;
  /** Report what would be removed without changing anything. */
  readonly dryRun?: boolean;
}

export interface AuditPurgeResult {
  readonly removed: number;
  /** Highest purged seq after this call (0 if the log has never been purged). */
  readonly purgedThroughSeq: number;
  readonly cutoff: string;
  /** The `audit.purged` record, when entries were removed. */
  readonly event?: AuditEntry;
}

function decode<T>(bytes: Uint8Array): T | undefined {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return undefined;
  }
}

export interface AuditQuery {
  readonly event?: AuditEventType;
  readonly result?: AuditResult;
  readonly actorIdentityId?: string;
  readonly since?: string;
  readonly until?: string;
  /** Return entries strictly older than this seq (newest-first paging). */
  readonly beforeSeq?: number;
  readonly limit?: number;
}

const queues = new Map<string, Promise<unknown>>();

/**
 * Append-only audit log over a `BlobStore` (one JSON object per entry, plus a small head pointer).
 *
 * Appends to one workspace are serialized through a process-wide queue keyed by `queueKey`, because a fresh
 * `FsAuditLog` is built per request (same as every other store here) and the chain needs a single writer. Multiple
 * server *processes* sharing one directory are not supported; `verify()` would report the resulting fork.
 */
export class FsAuditLog {
  constructor(
    private readonly store: BlobStore,
    private readonly workspaceId: string,
    private readonly now: () => Date = () => new Date(),
    /** UW-1 — where chain heads are anchored after each append; undefined = unanchored (see anchor.ts). */
    private readonly anchor?: AuditAnchorSink,
  ) {}

  /** UW-1 — the anchor scope of this log. */
  get anchorScope(): string {
    return `workspace:${this.workspaceId}`;
  }

  append(input: AuditEventInput): Promise<AuditEntry> {
    return this.serialized(() => this.appendLocked(input));
  }

  /** Every write to one workspace's log (appends and purges) runs one at a time, in order. */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.workspaceId) ?? Promise.resolve();
    const run = previous.then(work);
    queues.set(
      this.workspaceId,
      run.catch(() => undefined),
    );
    return run;
  }

  private async readBase(): Promise<Base | undefined> {
    const raw = await this.store.get(BASE_KEY);
    if (!raw.ok) {
      if (raw.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return undefined;
      throw raw.error;
    }
    const base = decode<Base>(raw.value);
    if (
      base === undefined ||
      !Number.isInteger(base.seq) ||
      base.seq < 1 ||
      typeof base.hash !== 'string' ||
      !Number.isInteger(base.purgeEventSeq)
    ) {
      throw new Error('audit log purge pointer is unreadable (run verify)');
    }
    return base;
  }

  private async readHead(): Promise<Head> {
    const raw = await this.store.get(HEAD_KEY);
    if (!raw.ok) {
      if (raw.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return { seq: 0, hash: GENESIS_HASH };
      throw raw.error;
    }
    const head = decode<Head>(raw.value);
    if (head === undefined || typeof head.seq !== 'number' || typeof head.hash !== 'string') {
      throw new Error('audit log head pointer is unreadable; refusing to append (run verify)');
    }
    return head;
  }

  /**
   * Crash recovery. An append writes the entry first and the head pointer second, so a crash between the two leaves a
   * valid entry the head does not yet point at. Appending on top of the stale head would overwrite that entry and lose
   * an event, so before every append the log adopts any such trailing entries — but only if each one is exactly what
   * the chain requires (right sequence number, links to the current head, hash recomputes). A trailing entry that fails
   * those checks is never adopted and never overwritten: the append is refused and `verify()` reports it.
   */
  private async adoptTrailingEntries(start: Head): Promise<Head> {
    let head = start;
    for (;;) {
      const next = await this.get(head.seq + 1);
      if (next === undefined) return head;
      const { hash, ...rest } = next;
      if (next.seq !== head.seq + 1 || next.prevHash !== head.hash || computeEntryHash(rest) !== hash) {
        throw new Error(`audit log has an unverifiable entry after seq ${head.seq}; refusing to append (run verify)`);
      }
      head = { seq: next.seq, hash };
      const headPut = await this.store.put(HEAD_KEY, JSON.stringify(head satisfies Head), { contentType: 'application/json' });
      if (!headPut.ok) throw headPut.error;
    }
  }

  private async appendLocked(input: AuditEventInput, options: { readonly strictAnchor?: boolean } = {}): Promise<AuditEntry> {
    const head = await this.adoptTrailingEntries(await this.readHead());
    const unsigned: Omit<AuditEntry, 'hash'> = {
      seq: head.seq + 1,
      eventId: randomUUID(),
      workspaceId: this.workspaceId,
      at: this.now().toISOString(),
      prevHash: head.hash,
      event: input.event,
      actor: input.actor,
      ...(input.target !== undefined ? { target: input.target } : {}),
      result: input.result,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
    };
    const entry: AuditEntry = { ...unsigned, hash: computeEntryHash(unsigned) };
    const put = await this.store.put(entryKey(entry.seq), JSON.stringify(entry), { contentType: 'application/json' });
    if (!put.ok) throw put.error;
    const headPut = await this.store.put(HEAD_KEY, JSON.stringify({ seq: entry.seq, hash: entry.hash } satisfies Head), {
      contentType: 'application/json',
    });
    if (!headPut.ok) throw headPut.error;
    if (this.anchor !== undefined) {
      const anchored = this.anchor.publish({
        scope: this.anchorScope,
        seq: entry.seq,
        hash: entry.hash,
        entryAt: entry.at,
        anchoredAt: this.now().toISOString(),
      });
      if (options.strictAnchor === true) {
        await anchored; // a purge is only carried out once its record is anchored
      } else {
        // The entry is already durable. A failed anchor is reported but does not fail the append: the next append's anchor covers
        // this entry too (anchors are cumulative along the chain).
        await anchored.catch((cause: unknown) => {
          process.stderr.write(`audit anchor for ${this.anchorScope} seq ${entry.seq} failed: ${String(cause)}\n`);
        });
      }
    }
    return entry;
  }

  /**
   * UW-1 — compare this chain against its anchors (no anchors, or no sink: `checked: 0`). Detects a consistently rewritten chain or a
   * truncated tail, which `verify()` alone cannot.
   */
  async verifyAnchors(purged?: PurgedRange): Promise<AnchorCheck> {
    if (this.anchor === undefined) return { checked: 0, highestAnchoredSeq: 0 };
    const anchors = await this.anchor.list(this.anchorScope);
    const head = await this.readHead();
    return checkAnchors(anchors, head.seq, async (seq) => (await this.get(seq))?.hash, purged);
  }

  /**
   * UW-1 — remove entries older than the operator's declared retention, as a recorded event.
   *
   * Only a prefix of the chain is ever removed, and only entries whose own time is before `now - retentionDays`. The purge first
   * appends an `audit.purged` record stating exactly what goes (through which seq and hash, the cutoff, the retention), anchors it
   * (when anchoring is configured; failure stops the purge before anything is removed), then moves the purge pointer and deletes the
   * entries. `verify()` then checks the chain from the pointer, checks the pointer against the record, and uses the anchors to prove
   * every removed entry predated the cutoff. A log that does not verify is never purged: that would destroy the evidence.
   */
  purge(request: AuditPurgeRequest): Promise<AuditPurgeResult> {
    return this.serialized(() => this.purgeLocked(request));
  }

  private async purgeLocked(request: AuditPurgeRequest): Promise<AuditPurgeResult> {
    if (!Number.isInteger(request.retentionDays) || request.retentionDays < 1 || request.retentionDays > 36500) {
      throw new Error('purge needs the declared retention in whole days (1 to 36500)');
    }
    const verification = await this.verify();
    if (!verification.ok) {
      throw new Error(
        `refusing to purge: the audit log does not verify (seq ${verification.brokenAt?.seq ?? '?'}: ${verification.brokenAt?.reason ?? '?'})`,
      );
    }
    const head = await this.readHead();
    const base = await this.readBase();
    const from = base?.seq ?? 0;
    const cutoff = new Date(this.now().getTime() - request.retentionDays * DAY_MS).toISOString();
    let through: AuditEntry | undefined;
    for (let seq = from + 1; seq <= head.seq; seq++) {
      const entry = await this.get(seq);
      if (entry === undefined) throw new Error(`audit entry ${seq} disappeared during purge`);
      if (entry.at >= cutoff) break;
      through = entry;
    }
    if (through === undefined || request.dryRun === true) {
      if (base !== undefined && request.dryRun !== true) await this.deletePurged(base.seq);
      return { removed: through === undefined ? 0 : through.seq - from, purgedThroughSeq: from, cutoff };
    }
    const event = await this.appendLocked(
      {
        event: 'audit.purged',
        actor: request.actor,
        target: { kind: 'audit_log', id: this.workspaceId },
        result: 'succeeded',
        detail: {
          fromSeq: from + 1,
          throughSeq: through.seq,
          throughHash: through.hash,
          throughAt: through.at,
          removed: through.seq - from,
          cutoff,
          retentionDays: request.retentionDays,
        },
      },
      { strictAnchor: true },
    );
    const next: Base = { seq: through.seq, hash: through.hash, purgeEventSeq: event.seq };
    const put = await this.store.put(BASE_KEY, JSON.stringify(next), { contentType: 'application/json' });
    if (!put.ok) throw put.error;
    await this.deletePurged(next.seq);
    return { removed: through.seq - from, purgedThroughSeq: next.seq, cutoff, event };
  }

  /** Delete every stored entry at or below the purge pointer (idempotent: also finishes a purge interrupted after the pointer moved). */
  private async deletePurged(throughSeq: number): Promise<void> {
    const keys = await this.store.list(ENTRY_PREFIX);
    if (!keys.ok) throw keys.error;
    for (const key of keys.value) {
      const seq = Number(key.slice(key.lastIndexOf('/') + 1).replace(/\.json$/, ''));
      if (Number.isInteger(seq) && seq >= 1 && seq <= throughSeq) {
        const deleted = await this.store.delete(key);
        if (!deleted.ok && deleted.error.code !== ErrorCode.STORAGE_OBJECT_NOT_FOUND) throw deleted.error;
      }
    }
  }

  /** UW-1 — the purge pointer, if the log was ever purged (for reporting). */
  async purgedThrough(): Promise<number> {
    return (await this.readBase())?.seq ?? 0;
  }

  async head(): Promise<Head> {
    return this.readHead();
  }

  async get(seq: number): Promise<AuditEntry | undefined> {
    const raw = await this.store.get(entryKey(seq));
    if (!raw.ok) return undefined;
    return decode<AuditEntry>(raw.value);
  }

  /** Newest first. Reads from the head backwards and stops at `limit` matches, so a page does not read the whole log. */
  async list(query: AuditQuery = {}): Promise<{ readonly entries: readonly AuditEntry[]; readonly nextBeforeSeq?: number }> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
    const head = await this.readHead();
    const out: AuditEntry[] = [];
    const floor = (await this.readBase())?.seq ?? 0;
    let seq = Math.min(head.seq, query.beforeSeq !== undefined ? query.beforeSeq - 1 : head.seq);
    for (; seq > floor && out.length < limit; seq--) {
      const entry = await this.get(seq);
      if (entry === undefined) continue; // a hole is reported by verify(), not hidden or fatal here
      if (query.event !== undefined && entry.event !== query.event) continue;
      if (query.result !== undefined && entry.result !== query.result) continue;
      if (query.actorIdentityId !== undefined && entry.actor.identityId !== query.actorIdentityId) continue;
      if (query.since !== undefined && entry.at < query.since) {
        // Entries are chronological: everything further back is older still.
        seq = 0;
        break;
      }
      if (query.until !== undefined && entry.at > query.until) continue;
      out.push(entry);
    }
    return { entries: out, ...(seq > floor ? { nextBeforeSeq: seq + 1 } : {}) };
  }

  /** Every entry, oldest first — for verification and export. */
  async all(): Promise<readonly AuditEntry[]> {
    const head = await this.readHead();
    const out: AuditEntry[] = [];
    for (let seq = ((await this.readBase())?.seq ?? 0) + 1; seq <= head.seq; seq++) {
      const entry = await this.get(seq);
      if (entry !== undefined) out.push(entry);
    }
    return out;
  }

  /**
   * Re-derives every hash and link from the stored entries. Never repairs anything. After a purge the chain is checked from the purge
   * pointer, and the pointer must match the `audit.purged` record it names. With anchoring configured, the chain is then compared with
   * the external anchors (detects a wholesale rewrite, a cut tail, or a purge of entries that were not yet old enough).
   */
  async verify(): Promise<AuditVerification> {
    const head = await this.readHead();
    const broken = (seq: number, reason: NonNullable<AuditVerification['brokenAt']>['reason'], extra: Partial<AuditVerification> = {}) =>
      ({ ok: false, entries: head.seq, headHash: head.hash, brokenAt: { seq, reason }, ...extra }) satisfies AuditVerification;
    let base: Base | undefined;
    try {
      base = await this.readBase();
    } catch {
      return broken(0, 'bad_purge');
    }
    const purgedInfo = base !== undefined ? { purgedThroughSeq: base.seq } : {};
    if (base !== undefined && (base.seq > head.seq || base.purgeEventSeq <= base.seq || base.purgeEventSeq > head.seq)) {
      return broken(base.purgeEventSeq, 'bad_purge', purgedInfo);
    }
    let prev = base?.hash ?? GENESIS_HASH;
    for (let seq = (base?.seq ?? 0) + 1; seq <= head.seq; seq++) {
      const raw = await this.store.get(entryKey(seq));
      if (!raw.ok) return broken(seq, 'missing_entry', purgedInfo);
      const entry = decode<AuditEntry>(raw.value);
      if (entry === undefined) return broken(seq, 'unreadable', purgedInfo);
      if (entry.seq !== seq) return broken(seq, 'bad_sequence', purgedInfo);
      if (entry.prevHash !== prev) return broken(seq, 'bad_link', purgedInfo);
      const { hash, ...rest } = entry;
      if (computeEntryHash(rest) !== hash) return broken(seq, 'bad_hash', purgedInfo);
      if (base !== undefined && seq === base.purgeEventSeq && !purgeRecordMatches(entry, base)) return broken(seq, 'bad_purge', purgedInfo);
      prev = hash;
    }
    // An entry sitting beyond the head is either a crash orphan (valid: the next append adopts it) or a forgery/corruption.
    const trailing = await this.get(head.seq + 1);
    if (trailing !== undefined) {
      const { hash, ...rest } = trailing;
      const reason =
        trailing.seq !== head.seq + 1
          ? 'bad_sequence'
          : trailing.prevHash !== head.hash
            ? 'bad_link'
            : computeEntryHash(rest) !== hash
              ? 'bad_hash'
              : undefined;
      if (reason !== undefined) return broken(head.seq + 1, reason, purgedInfo);
    }
    if (prev !== head.hash) return broken(head.seq, 'bad_link', purgedInfo);
    if (this.anchor === undefined) return { ok: true, entries: head.seq, headHash: head.hash, ...purgedInfo };
    // The chain is internally consistent. Only the external anchors can show it was rewritten wholesale or cut short.
    let anchors: AnchorCheck;
    try {
      const record = base !== undefined ? await this.get(base.purgeEventSeq) : undefined;
      const cutoff = record?.detail?.['cutoff'];
      anchors = await this.verifyAnchors(
        base !== undefined && typeof cutoff === 'string' ? { throughSeq: base.seq, cutoff, purgeEventSeq: base.purgeEventSeq } : undefined,
      );
    } catch {
      return broken(head.seq, 'anchor_unreadable', purgedInfo);
    }
    const anchoring = { checked: anchors.checked, highestAnchoredSeq: anchors.highestAnchoredSeq };
    if (anchors.mismatch !== undefined) {
      const reason = ANCHOR_REASON[anchors.mismatch.reason];
      return broken(anchors.mismatch.seq, reason, { ...purgedInfo, anchoring });
    }
    return { ok: true, entries: head.seq, headHash: head.hash, ...purgedInfo, anchoring };
  }
}

const ANCHOR_REASON = {
  truncated: 'anchor_truncated',
  rewritten: 'anchor_mismatch',
  purged_too_recent: 'anchor_purge_too_recent',
  unattested_purge: 'anchor_unattested_purge',
} as const satisfies Record<NonNullable<AnchorCheck['mismatch']>['reason'], NonNullable<AuditVerification['brokenAt']>['reason']>;

/** The `audit.purged` record a purge pointer names must state exactly that pointer, and must respect the retention it states. */
function purgeRecordMatches(entry: AuditEntry, base: Base): boolean {
  if (entry.event !== 'audit.purged') return false;
  const d = entry.detail ?? {};
  const cutoff = d['cutoff'];
  const throughAt = d['throughAt'];
  const retentionDays = d['retentionDays'];
  if (d['throughSeq'] !== base.seq || d['throughHash'] !== base.hash) return false;
  if (typeof cutoff !== 'string' || typeof throughAt !== 'string' || typeof retentionDays !== 'number') return false;
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || !(throughAt < cutoff)) return false;
  const kept = Date.parse(entry.at) - Date.parse(cutoff);
  return Number.isFinite(kept) && kept >= retentionDays * DAY_MS - CLOCK_TOLERANCE_MS;
}

/** A purge record is written right after its cutoff is computed; allow for a clock that steps back slightly in between. */
const CLOCK_TOLERANCE_MS = 1_000;
