import { createRequire } from 'node:module';

/**
 * UW-15 (ADR 0044) — what a schedule needs beyond a timer: the slot a time falls in, what to do about slots that passed while nothing
 * was running, and a lease so only one process fires. Pure functions plus a lease store behind an interface (a distributed lease can
 * implement the same interface later).
 */
export const slotOf = (nowMs: number, everyMs: number): number => Math.floor(nowMs / everyMs);

/** `run_latest`: after downtime run only the most recent missed slot (if it is recent enough) and record the rest as skipped. `skip`: run none of them. */
export type MissedSlotPolicy = 'run_latest' | 'skip';
export const DAY_MS = 86_400_000;

export interface MissedSlotPlan {
  /** The missed slot to run now, or undefined. */
  readonly run: number | undefined;
  /** Missed slots that will not be run: record each as `skipped: missed`. */
  readonly skipped: readonly number[];
}

/**
 * Slots strictly between the last one fired and the current one are MISSED. Nothing is missed on time or one slot late.
 * `run_latest` runs the latest missed slot when its end is within `maxAgeMs` (default 24 h) of now; every other missed slot is skipped.
 */
export function missedSlotPlan(input: {
  readonly lastFiredMs: number | undefined;
  readonly nowMs: number;
  readonly everyMs: number;
  readonly policy: MissedSlotPolicy;
  readonly maxAgeMs?: number;
}): MissedSlotPlan {
  const { lastFiredMs, nowMs, everyMs, policy } = input;
  if (lastFiredMs === undefined || Number.isNaN(lastFiredMs)) return { run: undefined, skipped: [] };
  const first = slotOf(lastFiredMs, everyMs) + 1;
  const last = slotOf(nowMs, everyMs) - 1;
  if (last < first) return { run: undefined, skipped: [] };
  const missed: number[] = [];
  // Bounded: a very long outage lists at most the newest 10 000 slots (older ones are skipped without being named).
  for (let s = Math.max(first, last - 9_999); s <= last; s++) missed.push(s);
  if (policy === 'skip') return { run: undefined, skipped: missed };
  const latest = missed[missed.length - 1]!;
  const recent = nowMs - (latest + 1) * everyMs <= (input.maxAgeMs ?? DAY_MS);
  return recent ? { run: latest, skipped: missed.slice(0, -1) } : { run: undefined, skipped: missed };
}

// ------------------------------------------------------------------ leases
export interface Lease {
  readonly name: string;
  readonly holder: string;
  /** Increases every time the lease changes hands: lets a writer refuse a stale holder. */
  readonly fence: number;
  readonly expiresAtMs: number;
}

export interface LeaseStore {
  /** Takes the lease if it is free, expired or already ours (then it is extended). Undefined while someone else holds it. */
  acquire(name: string, holder: string, ttlMs: number, nowMs: number): Promise<Lease | undefined>;
  /** Gives it up now (only if we hold it). */
  release(name: string, holder: string): Promise<void>;
}

export class MemoryLeaseStore implements LeaseStore {
  private readonly rows = new Map<string, Lease>();
  async acquire(name: string, holder: string, ttlMs: number, nowMs: number): Promise<Lease | undefined> {
    const cur = this.rows.get(name);
    if (cur !== undefined && cur.holder !== holder && cur.expiresAtMs > nowMs) return undefined;
    const lease: Lease = {
      name,
      holder,
      fence: cur === undefined ? 1 : cur.holder === holder ? cur.fence : cur.fence + 1,
      expiresAtMs: nowMs + ttlMs,
    };
    this.rows.set(name, lease);
    return lease;
  }
  async release(name: string, holder: string): Promise<void> {
    if (this.rows.get(name)?.holder === holder) this.rows.delete(name);
  }
}

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { get(...p: (string | number)[]): unknown; run(...p: (string | number)[]): unknown };
  close(): void;
}

/**
 * A lease in one SQLite file (Node's built-in `node:sqlite`): every instance on this machine that points at the same data directory
 * agrees on who may fire schedules. Takes the write lock (`BEGIN IMMEDIATE`) so two processes cannot both read "free" and both take it.
 */
export class SqliteLeaseStore implements LeaseStore {
  private readonly db: SqliteDb;
  constructor(path: string) {
    const moduleName = 'node:sqlite';
    const { DatabaseSync } = createRequire(import.meta.url)(moduleName) as { DatabaseSync: new (p: string) => SqliteDb };
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, holder TEXT NOT NULL, fence INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL)',
    );
  }
  async acquire(name: string, holder: string, ttlMs: number, nowMs: number): Promise<Lease | undefined> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const cur = this.db.prepare('SELECT holder, fence, expires_at_ms AS exp FROM leases WHERE name = ?').get(name) as
        { holder: string; fence: number; exp: number } | undefined;
      if (cur !== undefined && cur.holder !== holder && cur.exp > nowMs) {
        this.db.exec('COMMIT');
        return undefined;
      }
      const fence = cur === undefined ? 1 : cur.holder === holder ? cur.fence : cur.fence + 1;
      this.db
        .prepare(
          'INSERT INTO leases (name, holder, fence, expires_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, fence = excluded.fence, expires_at_ms = excluded.expires_at_ms',
        )
        .run(name, holder, fence, nowMs + ttlMs);
      this.db.exec('COMMIT');
      return { name, holder, fence, expiresAtMs: nowMs + ttlMs };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  async release(name: string, holder: string): Promise<void> {
    this.db.prepare('DELETE FROM leases WHERE name = ? AND holder = ?').run(name, holder);
  }
  close(): void {
    this.db.close();
  }
}
