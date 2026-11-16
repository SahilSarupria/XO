import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RUN_ID, type CancelRequest, type JournalEntry, type RunStore, type RunStoreLike } from './journal.js';

/**
 * Run ownership with fencing tokens.
 *
 * A run is owned by one runner at a time through a lease. Each acquisition by a different owner (or after release or expiry)
 * issues a strictly larger fencing token. Journal writes carry the token and are checked, under a per-run mutex and in the same
 * critical section as the append, against the authority's current lease: a stale token, an expired lease or a different owner is
 * refused (LOST). The authority is the single arbiter; run it where the authoritative journal lives (the server).
 *
 * Guarantees: at most one owner can append to the authoritative journal at any time. NOT guaranteed: a runner that lost its lease
 * may already have an external call in flight; that call carries the run/step-derived idempotency key, so a system that honours
 * keys dedupes it against the takeover's repeat, and a system that does not may see a duplicate. This is at-least-once, not exactly-once.
 */

export interface Lease {
  readonly runId: string;
  readonly owner: string;
  readonly token: number;
  readonly expiresAt: number;
}

export type LeaseErrorCode = 'HELD' | 'LOST' | 'UNKNOWN';

export class LeaseError extends Error {
  constructor(
    readonly code: LeaseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LeaseError';
  }
}

/** The calls a runner needs; implemented by the in-process authority and by the HTTP client in @xo/sdk. */
export interface LeaseClient {
  acquire(runId: string, owner: string, ttlMs: number): Promise<Lease>;
  heartbeat(runId: string, owner: string, token: number, ttlMs: number): Promise<Lease>;
  release(runId: string, owner: string, token: number): Promise<void>;
}

interface Stored {
  owner: string | null;
  token: number;
  expiresAt: number;
}

export interface LeaseAuthorityOptions {
  /**
   * Several processes (API instances sharing one data volume) arbitrate the same runs. Every critical section then also holds
   * a per-run lock file created with O_EXCL, so the read-check-write of a lease, and a fenced append, are atomic across
   * processes, not only within this one. A lock file older than `staleLockMs` (default 30 s) belongs to a dead process and
   * is broken; critical sections are short (a read, a check, one append), far below that.
   */
  readonly crossProcess?: { readonly staleLockMs?: number; readonly waitMs?: number };
}

export class LeaseAuthority implements LeaseClient {
  private readonly chains = new Map<string, Promise<unknown>>();
  constructor(
    private readonly dir: string,
    private readonly store: RunStore,
    private readonly now: () => number = Date.now,
    private readonly options: LeaseAuthorityOptions = {},
  ) {}

  private async locked<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const cp = this.options.crossProcess;
    if (cp === undefined) return fn();
    await mkdir(this.dir, { recursive: true });
    const lockPath = join(this.dir, `${runId}.lock`);
    const deadline = Date.now() + (cp.waitMs ?? 10_000);
    for (;;) {
      try {
        const h = await open(lockPath, 'wx');
        await h.writeFile(`${process.pid}\n`);
        await h.close();
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const st = await stat(lockPath).catch(() => undefined);
        if (st !== undefined && Date.now() - st.mtimeMs > (cp.staleLockMs ?? 30_000)) await unlink(lockPath).catch(() => undefined);
        if (Date.now() > deadline) throw new LeaseError('HELD', `run ${runId} is being arbitrated by another process`);
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    try {
      return await fn();
    } finally {
      await unlink(lockPath).catch(() => undefined);
    }
  }

  private serial<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    if (!RUN_ID.test(runId)) return Promise.reject(new LeaseError('UNKNOWN', 'invalid run id'));
    const next = (this.chains.get(runId) ?? Promise.resolve()).then(() => this.locked(runId, fn));
    this.chains.set(
      runId,
      next.catch(() => undefined),
    );
    return next;
  }

  private async load(runId: string): Promise<Stored> {
    try {
      const v = JSON.parse(await readFile(join(this.dir, `${runId}.lease.json`), 'utf8')) as Stored;
      if (!Number.isInteger(v.token) || v.token < 0) throw new Error('bad token');
      return v;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { owner: null, token: 0, expiresAt: 0 };
      // an unreadable lease file must never be treated as "no lease" (that could hand out a duplicate token)
      throw new LeaseError('UNKNOWN', `lease state for ${runId} is unreadable`);
    }
  }

  private async save(runId: string, s: Stored): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = join(this.dir, `${runId}.lease.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(s));
    await rename(tmp, file);
  }

  acquire(runId: string, owner: string, ttlMs: number): Promise<Lease> {
    return this.serial(runId, async () => {
      const s = await this.load(runId);
      const t = this.now();
      const live = s.owner !== null && t <= s.expiresAt;
      if (live && s.owner !== owner)
        throw new LeaseError('HELD', `run ${runId} is leased to ${s.owner} until ${new Date(s.expiresAt).toISOString()}`);
      // same owner re-acquiring a live lease keeps its token; anything else is a new epoch with a larger token
      const token = live ? s.token : s.token + 1;
      const next: Stored = { owner, token, expiresAt: t + ttlMs };
      await this.save(runId, next);
      return { runId, owner, token, expiresAt: next.expiresAt };
    });
  }

  heartbeat(runId: string, owner: string, token: number, ttlMs: number): Promise<Lease> {
    return this.serial(runId, async () => {
      const s = await this.load(runId);
      if (s.owner !== owner || s.token !== token)
        throw new LeaseError('LOST', `lease for ${runId} is no longer yours (token ${token}, current ${s.token})`);
      const next: Stored = { owner, token, expiresAt: this.now() + ttlMs };
      await this.save(runId, next);
      return { runId, owner, token, expiresAt: next.expiresAt };
    });
  }

  release(runId: string, owner: string, token: number): Promise<void> {
    return this.serial(runId, async () => {
      const s = await this.load(runId);
      if (s.owner === owner && s.token === token) await this.save(runId, { owner: null, token: s.token, expiresAt: 0 });
    });
  }

  async current(runId: string): Promise<Lease | undefined> {
    const s = await this.serial(runId, () => this.load(runId));
    return s.owner === null ? undefined : { runId, owner: s.owner, token: s.token, expiresAt: s.expiresAt };
  }

  /** Throws LOST unless (owner, token) is the current, unexpired lease. Used to fence replication pushes at the authoritative ledger. */
  assertCurrent(runId: string, owner: string, token: number): Promise<void> {
    return this.serial(runId, async () => {
      const s = await this.load(runId);
      if (s.owner !== owner || s.token !== token || this.now() > s.expiresAt)
        throw new LeaseError('LOST', `fenced: token ${token} is not the current lease for ${runId}`);
    });
  }

  /** Append that is valid only while the caller still holds the current, unexpired lease. Check and write share one critical section. */
  fencedAppend(runId: string, owner: string, token: number, type: string, data: Readonly<Record<string, unknown>>): Promise<JournalEntry> {
    return this.serial(runId, async () => {
      const s = await this.load(runId);
      if (s.owner !== owner || s.token !== token)
        throw new LeaseError('LOST', `fenced: token ${token} is stale (current ${s.token}); stop and reconcile`);
      if (this.now() > s.expiresAt)
        throw new LeaseError('LOST', `fenced: lease expired at ${new Date(s.expiresAt).toISOString()}; stop and reconcile`);
      return this.store.append(runId, type, data);
    });
  }
}

/** A journal whose writes are fenced by the lease the runner currently holds for each run. */
export class LeasedRunStore implements RunStoreLike {
  private readonly tokens = new Map<string, { owner: string; token: number }>();
  constructor(
    private readonly authority: LeaseAuthority,
    private readonly store: RunStore,
  ) {}
  attach(runId: string, owner: string, token: number): void {
    this.tokens.set(runId, { owner, token });
  }
  detach(runId: string): void {
    this.tokens.delete(runId);
  }
  create(runId: string): Promise<boolean> {
    return this.store.create(runId);
  }
  append(runId: string, type: string, data: Readonly<Record<string, unknown>>): Promise<JournalEntry> {
    const t = this.tokens.get(runId);
    if (t === undefined) return Promise.reject(new LeaseError('LOST', `no lease held for ${runId}; refusing to write`));
    return this.authority.fencedAppend(runId, t.owner, t.token, type, data);
  }
  read(runId: string): Promise<JournalEntry[]> {
    return this.store.read(runId);
  }
  list(): Promise<string[]> {
    return this.store.list();
  }
  /** Not fenced: recording a cancel request is how someone without the lease asks the holder to stop (ADR 0024). */
  requestCancel(runId: string, request: CancelRequest): Promise<{ readonly recorded: boolean; readonly request: CancelRequest }> {
    return this.store.requestCancel(runId, request);
  }
  cancelRequest(runId: string): Promise<CancelRequest | undefined> {
    return this.store.cancelRequest(runId);
  }
}
