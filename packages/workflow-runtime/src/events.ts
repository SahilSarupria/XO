import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, sha256Hex } from '@xo/workflow-ir';

/**
 * Inbound events for `wait` steps of kind `event`.
 *
 * An event is addressed by `(name, correlation)`: `name` is the event type a workflow waits for, `correlation` is the value of the workflow input
 * named by the step's `correlationKey`. Properties this module guarantees (and the limits of each):
 *   - Buffered: an event that arrives before the run reaches its wait is kept (until `ttlMs`) and found when the wait starts.
 *   - Deduplicated by the sender's `eventId`: delivering the same id twice stores it once, including after it was consumed.
 *   - Consumed at most once: `claim` hands an event to exactly one claimant. A claim is recorded under the claimant's identity BEFORE the claimant
 *     journals it, so a crash between the two is recovered by the same claimant asking again; the event is never lost and never given to a second run.
 *   - The payload is untrusted data. It is flat (scalars only) and size-bounded; nothing here interprets it.
 * Not guaranteed: ordering across different events, or delivery to a run that never waits (such an event expires unused).
 */
export type EventScalar = string | number | boolean | null;

export interface InboundEvent {
  readonly name: string;
  readonly correlation: string;
  /** The sender's identifier for this event; the deduplication key. */
  readonly eventId: string;
  readonly payload: Readonly<Record<string, EventScalar>>;
  readonly receivedAt: string;
}

export type DeliverStatus = 'queued' | 'duplicate';

export interface EventInbox {
  deliver(e: Omit<InboundEvent, 'receivedAt'>): Promise<{ status: DeliverStatus }>;
  /** Takes the oldest unexpired event for `(name, correlation)` for `claimant`, or returns the one this claimant already took. */
  claim(name: string, correlation: string, claimant: string): Promise<InboundEvent | undefined>;
}

export const EVENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const MAX_EVENT_PAYLOAD_BYTES = 16 * 1024;

/** Returns what is wrong with an event, or undefined. Used by every delivery surface so they all refuse the same things. */
export function eventProblem(e: { name: unknown; correlation: unknown; eventId: unknown; payload: unknown }): string | undefined {
  if (typeof e.name !== 'string' || !EVENT_NAME.test(e.name)) return 'name must be 1-128 characters: letters, digits, . _ : -';
  if (typeof e.correlation !== 'string' || e.correlation.length < 1 || e.correlation.length > 256)
    return 'correlation must be a string of 1-256 characters';
  if (typeof e.eventId !== 'string' || !EVENT_ID.test(e.eventId)) return 'eventId must be 1-128 characters: letters, digits, . _ : -';
  const p = e.payload;
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return 'payload must be an object';
  for (const [k, v] of Object.entries(p))
    if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) return `payload.${k} must be a string, number, boolean or null`;
    else if (typeof v === 'number' && !Number.isFinite(v)) return `payload.${k} must be finite`;
  if (Buffer.byteLength(JSON.stringify(p)) > MAX_EVENT_PAYLOAD_BYTES) return `payload exceeds ${MAX_EVENT_PAYLOAD_BYTES} bytes`;
  return undefined;
}

const addr = (name: string, correlation: string): string => sha256Hex(canonicalJson({ n: name, c: correlation })).slice(0, 24);
const eventKey = (name: string, correlation: string, eventId: string): string =>
  sha256Hex(canonicalJson({ n: name, c: correlation, e: eventId })).slice(0, 24);
const claimantKey = (claimant: string): string => sha256Hex(claimant).slice(0, 16);

function stamp(iso: string): string {
  return String(Date.parse(iso)).padStart(15, '0');
}

export interface InboxOptions {
  readonly now?: () => number;
  /** Events older than this are never handed out. Default 7 days. */
  readonly ttlMs?: number;
}

/**
 * Directory-backed inbox. Layout:
 *   pending/<addr>.<stamp>.<key>.json     delivered, not yet claimed
 *   claimed/<claimant>.<addr>.<stamp>.<key>.json   claimed (moved by an atomic rename; the first rename wins)
 * Single host: rename atomicity is what stops two claimants taking the same event; two hosts on a network share are not covered.
 */
export class FileEventInbox implements EventInbox {
  private readonly now: () => number;
  private readonly ttlMs: number;
  constructor(
    private readonly dir: string,
    o: InboxOptions = {},
  ) {
    this.now = o.now ?? Date.now;
    this.ttlMs = o.ttlMs ?? 7 * 24 * 3600 * 1000;
  }

  private async names(sub: string): Promise<string[]> {
    try {
      return await readdir(join(this.dir, sub));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  async deliver(e: Omit<InboundEvent, 'receivedAt'>): Promise<{ status: DeliverStatus }> {
    const problem = eventProblem(e);
    if (problem !== undefined) throw new Error(`invalid event: ${problem}`);
    const key = eventKey(e.name, e.correlation, e.eventId);
    // already delivered, whether it is still pending or was claimed already
    if ((await this.names('pending')).some((n) => n.endsWith(`.${key}.json`))) return { status: 'duplicate' };
    if ((await this.names('claimed')).some((n) => n.endsWith(`.${key}.json`))) return { status: 'duplicate' };
    const receivedAt = new Date(this.now()).toISOString();
    await mkdir(join(this.dir, 'pending'), { recursive: true });
    const file = `${addr(e.name, e.correlation)}.${stamp(receivedAt)}.${key}.json`;
    try {
      await writeFile(join(this.dir, 'pending', file), JSON.stringify({ ...e, receivedAt }), { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { status: 'duplicate' };
      throw err;
    }
    return { status: 'queued' };
  }

  async claim(name: string, correlation: string, claimant: string): Promise<InboundEvent | undefined> {
    const a = addr(name, correlation);
    const who = claimantKey(claimant);
    // a claim this claimant already made (crash between claiming and journalling) is returned again, never a second event
    const mine = (await this.names('claimed')).filter((n) => n.startsWith(`${who}.${a}.`)).sort();
    if (mine[0] !== undefined) return JSON.parse(await readFile(join(this.dir, 'claimed', mine[0]), 'utf8')) as InboundEvent;
    const pending = (await this.names('pending')).filter((n) => n.startsWith(`${a}.`)).sort(); // stamp is zero-padded: oldest first
    await mkdir(join(this.dir, 'claimed'), { recursive: true });
    for (const n of pending) {
      let ev: InboundEvent;
      try {
        ev = JSON.parse(await readFile(join(this.dir, 'pending', n), 'utf8')) as InboundEvent;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // someone else took it
        throw e; // a damaged pending event is an error to look at, not something to skip silently
      }
      if (this.now() - Date.parse(ev.receivedAt) > this.ttlMs) continue;
      try {
        await rename(join(this.dir, 'pending', n), join(this.dir, 'claimed', `${who}.${n}`));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // lost the race: the first rename wins
        throw e;
      }
      return ev;
    }
    return undefined;
  }
}

/** In-memory inbox with the same semantics, for tests and embedding. */
export class MemoryEventInbox implements EventInbox {
  private readonly pending: InboundEvent[] = [];
  private readonly seen = new Set<string>();
  private readonly claimed = new Map<string, InboundEvent>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  constructor(o: InboxOptions = {}) {
    this.now = o.now ?? Date.now;
    this.ttlMs = o.ttlMs ?? 7 * 24 * 3600 * 1000;
  }
  async deliver(e: Omit<InboundEvent, 'receivedAt'>): Promise<{ status: DeliverStatus }> {
    const problem = eventProblem(e);
    if (problem !== undefined) throw new Error(`invalid event: ${problem}`);
    const key = eventKey(e.name, e.correlation, e.eventId);
    if (this.seen.has(key)) return { status: 'duplicate' };
    this.seen.add(key);
    this.pending.push({ ...e, receivedAt: new Date(this.now()).toISOString() });
    return { status: 'queued' };
  }
  async claim(name: string, correlation: string, claimant: string): Promise<InboundEvent | undefined> {
    const k = `${claimant}\u0000${addr(name, correlation)}`;
    const prior = this.claimed.get(k);
    if (prior !== undefined) return prior;
    const i = this.pending.findIndex(
      (e) => e.name === name && e.correlation === correlation && this.now() - Date.parse(e.receivedAt) <= this.ttlMs,
    );
    if (i < 0) return undefined;
    const [ev] = this.pending.splice(i, 1) as [InboundEvent];
    this.claimed.set(k, ev);
    return ev;
  }
}
