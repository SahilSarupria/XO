import { createHmac, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, isErrno, readJson, writeJsonAtomic } from '../session/fs-util.js';

/**
 * Persisted sign-in throttling. Three layers, all applied identically whether or not the login name exists, so a
 * throttle never reveals an account:
 *
 *  1. pair      (login name, source address): after `PAIR_FREE_FAILURES` consecutive failures, an exponentially
 *               growing wait (1 s, 2 s, 4 s ... capped at 15 min). A success clears the pair.
 *  2. account   failures for one login name from ANY source: `ACCOUNT_WINDOW_MAX` inside 15 minutes imposes a 60 s
 *               wait on every source until the window clears. Deliberately a delay, never a lockout: a permanent
 *               lockout would let anyone who knows a login name deny that person service. The cost of this trade is
 *               that an attacker can slow a victim's sign-in for the window.
 *  3. global    `GLOBAL_MIN_FAILURES` failures spread over `GLOBAL_MIN_ACCOUNTS` distinct names inside 5 minutes is
 *               credential stuffing; every attempt then waits a short uniform interval.
 *
 * Counters are keyed by an HMAC (server-local secret) of the login name and source, never the name or address, and
 * the directory is bounded (stale entries swept, oldest removed past a cap) so unknown names cannot fill the disk.
 *
 * Limits of this design, stated plainly: counters are per HOST (a local directory). Concurrent writes from several
 * processes can lose an increment (this errs toward letting an attempt through, not toward blocking). Behind a reverse
 * proxy every client shares the proxy's address, so the pair layer acts as one shared cap there. This is not a
 * distributed rate limiter and must not be described as one.
 */
export const PAIR_FREE_FAILURES = 3;
export const PAIR_MAX_DELAY_S = 900;
export const ACCOUNT_WINDOW_MS = 15 * 60_000;
export const ACCOUNT_WINDOW_MAX = 20;
export const ACCOUNT_DELAY_S = 60;
export const GLOBAL_WINDOW_MS = 5 * 60_000;
export const GLOBAL_MIN_FAILURES = 50;
export const GLOBAL_MIN_ACCOUNTS = 20;
export const GLOBAL_DELAY_S = 5;
const MAX_FILES = 20_000;
const STALE_MS = 24 * 60 * 60_000;

export interface ThrottleDecision {
  readonly blocked: boolean;
  readonly retryAfterSeconds: number;
}

interface PairRecord {
  readonly consecutive: number;
  readonly blockedUntil: number;
}
interface AccountRecord {
  readonly failures: readonly number[];
}
interface GlobalRecord {
  readonly events: readonly { readonly t: number; readonly a: string }[];
}

export class FsAttemptStore {
  private readonly dir: string;
  private key: Buffer | undefined;
  private writes = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    baseDir: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.dir = join(baseDir, 'attempts');
  }

  private async secret(): Promise<Buffer> {
    if (this.key !== undefined) return this.key;
    await ensureDir(this.dir);
    const path = join(this.dir, '.key');
    try {
      const h = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        await h.writeFile(randomBytes(32).toString('hex'), { encoding: 'utf8' });
        await h.sync();
      } finally {
        await h.close();
      }
    } catch (cause) {
      if (!isErrno(cause, 'EEXIST')) throw cause;
    }
    const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      this.key = Buffer.from((await h.readFile({ encoding: 'utf8' })).trim(), 'hex');
    } finally {
      await h.close();
    }
    if (this.key.length !== 32) throw new Error('throttle key file is corrupt');
    return this.key;
  }

  /** A keyed digest for audit/log fields that must correlate but never reveal the value (login names, source addresses). */
  async keyed(label: string, value: string): Promise<string> {
    return createHmac('sha256', await this.secret())
      .update(`${label}:${value}`)
      .digest('hex')
      .slice(0, 32);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async check(loginKey: string, source: string): Promise<ThrottleDecision> {
    const t = this.now();
    const [pairId, acctId] = await Promise.all([this.keyed('pair', `${loginKey}|${source}`), this.keyed('acct', loginKey)]);
    let wait = 0;

    const pair = await readJson<PairRecord>(join(this.dir, `p-${pairId}.json`));
    if (pair !== undefined && pair.blockedUntil > t) wait = Math.max(wait, pair.blockedUntil - t);

    const acct = await readJson<AccountRecord>(join(this.dir, `a-${acctId}.json`));
    const recent = (acct?.failures ?? []).filter((f) => t - f < ACCOUNT_WINDOW_MS);
    if (recent.length >= ACCOUNT_WINDOW_MAX) {
      const last = recent[recent.length - 1] as number;
      wait = Math.max(wait, last + ACCOUNT_DELAY_S * 1000 - t);
    }

    const global = await readJson<GlobalRecord>(join(this.dir, 'global.json'));
    const events = (global?.events ?? []).filter((e) => t - e.t < GLOBAL_WINDOW_MS);
    if (events.length >= GLOBAL_MIN_FAILURES && new Set(events.map((e) => e.a)).size >= GLOBAL_MIN_ACCOUNTS) {
      const last = events[events.length - 1] as { t: number };
      wait = Math.max(wait, last.t + GLOBAL_DELAY_S * 1000 - t);
    }
    return wait > 0 ? { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)) } : { blocked: false, retryAfterSeconds: 0 };
  }

  recordFailure(loginKey: string, source: string): Promise<void> {
    return this.serial(async () => {
      const t = this.now();
      const [pairId, acctId] = await Promise.all([this.keyed('pair', `${loginKey}|${source}`), this.keyed('acct', loginKey)]);

      const pair = await readJson<PairRecord>(join(this.dir, `p-${pairId}.json`));
      const consecutive = (pair?.consecutive ?? 0) + 1;
      const delayS = consecutive >= PAIR_FREE_FAILURES ? Math.min(2 ** (consecutive - PAIR_FREE_FAILURES), PAIR_MAX_DELAY_S) : 0;
      await writeJsonAtomic(this.dir, `p-${pairId}.json`, {
        consecutive,
        blockedUntil: delayS > 0 ? t + delayS * 1000 : 0,
      } satisfies PairRecord);

      const acct = await readJson<AccountRecord>(join(this.dir, `a-${acctId}.json`));
      const failures = [...(acct?.failures ?? []).filter((f) => t - f < ACCOUNT_WINDOW_MS), t].slice(-200);
      await writeJsonAtomic(this.dir, `a-${acctId}.json`, { failures } satisfies AccountRecord);

      const global = await readJson<GlobalRecord>(join(this.dir, 'global.json'));
      const events = [...(global?.events ?? []).filter((e) => t - e.t < GLOBAL_WINDOW_MS), { t, a: acctId.slice(0, 12) }].slice(-400);
      await writeJsonAtomic(this.dir, 'global.json', { events } satisfies GlobalRecord);

      if (++this.writes % 100 === 1) await this.sweep().catch(() => undefined);
    });
  }

  recordSuccess(loginKey: string, source: string): Promise<void> {
    return this.serial(async () => {
      const pairId = await this.keyed('pair', `${loginKey}|${source}`);
      await unlink(join(this.dir, `p-${pairId}.json`)).catch(() => undefined);
    });
  }

  private async sweep(): Promise<void> {
    const t = this.now();
    const names = (await readdir(this.dir)).filter((n) => /^[pa]-[0-9a-f]{32}\.json$/.test(n));
    const info: { name: string; mtime: number }[] = [];
    for (const name of names) {
      const s = await stat(join(this.dir, name)).catch(() => undefined);
      if (s !== undefined) info.push({ name, mtime: s.mtimeMs });
    }
    for (const f of info.filter((i) => t - i.mtime > STALE_MS)) await unlink(join(this.dir, f.name)).catch(() => undefined);
    const live = info.filter((i) => t - i.mtime <= STALE_MS).sort((a, b) => a.mtime - b.mtime);
    for (const f of live.slice(0, Math.max(0, live.length - MAX_FILES))) await unlink(join(this.dir, f.name)).catch(() => undefined);
  }
}
