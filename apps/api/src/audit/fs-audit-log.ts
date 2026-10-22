import { randomUUID } from 'node:crypto';
import type { BlobStore } from '@xo/storage';
import { ErrorCode } from '@xo/errors';
import {
  computeEntryHash,
  GENESIS_HASH,
  type AuditEntry,
  type AuditEventInput,
  type AuditEventType,
  type AuditResult,
  type AuditVerification,
} from './audit-entry.js';

const ENTRY_PREFIX = 'entries/';
const HEAD_KEY = 'head.json';

function entryKey(seq: number): string {
  return `${ENTRY_PREFIX}${String(seq).padStart(12, '0')}.json`;
}

interface Head {
  readonly seq: number;
  readonly hash: string;
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
  ) {}

  append(input: AuditEventInput): Promise<AuditEntry> {
    const previous = queues.get(this.workspaceId) ?? Promise.resolve();
    const run = previous.then(() => this.appendLocked(input));
    queues.set(
      this.workspaceId,
      run.catch(() => undefined),
    );
    return run;
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

  private async appendLocked(input: AuditEventInput): Promise<AuditEntry> {
    const head = await this.readHead();
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
    return entry;
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
    let seq = Math.min(head.seq, query.beforeSeq !== undefined ? query.beforeSeq - 1 : head.seq);
    for (; seq >= 1 && out.length < limit; seq--) {
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
    return { entries: out, ...(seq >= 1 ? { nextBeforeSeq: seq + 1 } : {}) };
  }

  /** Every entry, oldest first — for verification and export. */
  async all(): Promise<readonly AuditEntry[]> {
    const head = await this.readHead();
    const out: AuditEntry[] = [];
    for (let seq = 1; seq <= head.seq; seq++) {
      const entry = await this.get(seq);
      if (entry !== undefined) out.push(entry);
    }
    return out;
  }

  /** Re-derives every hash and link from the stored entries. Never repairs anything. */
  async verify(): Promise<AuditVerification> {
    const head = await this.readHead();
    let prev = GENESIS_HASH;
    for (let seq = 1; seq <= head.seq; seq++) {
      const raw = await this.store.get(entryKey(seq));
      if (!raw.ok) return { ok: false, entries: head.seq, headHash: head.hash, brokenAt: { seq, reason: 'missing_entry' } };
      const entry = decode<AuditEntry>(raw.value);
      if (entry === undefined) return { ok: false, entries: head.seq, headHash: head.hash, brokenAt: { seq, reason: 'unreadable' } };
      if (entry.seq !== seq) return { ok: false, entries: head.seq, headHash: head.hash, brokenAt: { seq, reason: 'bad_sequence' } };
      if (entry.prevHash !== prev) return { ok: false, entries: head.seq, headHash: head.hash, brokenAt: { seq, reason: 'bad_link' } };
      const { hash, ...rest } = entry;
      if (computeEntryHash(rest) !== hash) return { ok: false, entries: head.seq, headHash: head.hash, brokenAt: { seq, reason: 'bad_hash' } };
      prev = hash;
    }
    if (prev !== head.hash) return { ok: false, entries: head.seq, headHash: head.hash, brokenAt: { seq: head.seq, reason: 'bad_link' } };
    return { ok: true, entries: head.seq, headHash: head.hash };
  }
}
