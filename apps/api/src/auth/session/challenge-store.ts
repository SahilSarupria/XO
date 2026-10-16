import { join } from 'node:path';
import { readdir, unlink } from 'node:fs/promises';
import { ensureDir, moveExclusive, randomCredential, readJson, sha256Hex, writeJsonAtomic, isErrno } from './fs-util.js';

/**
 * Single-use login challenges. A challenge binds one sign-in attempt to a server-chosen nonce that the
 * identity provider must echo inside the ID token, so an ID token minted for any other attempt (or
 * replayed later) is refused.
 *
 *  - The id is a 256-bit CSPRNG value; only its SHA-256 is used as the file name.
 *  - Lifetime is 5 minutes.
 *  - `consume` is an atomic `rename` out of the pending directory: of any number of concurrent callers
 *    with the same id, exactly one gets the record. Every other caller, and every later caller, gets
 *    nothing. A challenge is consumed whether or not the exchange that used it then succeeds.
 *  - The number of outstanding (unconsumed, unexpired) challenges is capped.
 */

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_ID = /^[A-Za-z0-9_-]{43}$/;

export interface ChallengeRecord {
  readonly nonce: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface IssuedChallenge extends ChallengeRecord {
  readonly challengeId: string;
}

export interface ChallengeStoreOptions {
  readonly maxOutstanding?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export class ChallengeCapReached extends Error {
  constructor() {
    super('too many outstanding login challenges');
  }
}

export class FsChallengeStore {
  private readonly pending: string;
  private readonly used: string;
  private readonly max: number;
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(rootDir: string, options: ChallengeStoreOptions = {}) {
    this.pending = join(rootDir, 'challenges', 'pending');
    this.used = join(rootDir, 'challenges', 'used');
    this.max = options.maxOutstanding ?? 500;
    this.ttl = options.ttlMs ?? CHALLENGE_TTL_MS;
    this.now = options.now ?? ((): number => Date.now());
  }

  async create(): Promise<IssuedChallenge> {
    await ensureDir(this.pending);
    await ensureDir(this.used);
    await this.sweep();
    const outstanding = (await readdir(this.pending)).filter((n) => n.endsWith('.json')).length;
    if (outstanding >= this.max) throw new ChallengeCapReached();
    const challengeId = randomCredential('');
    const nonce = randomCredential('');
    const createdAt = new Date(this.now());
    const record: ChallengeRecord = {
      nonce,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.ttl).toISOString(),
    };
    await writeJsonAtomic(this.pending, `${sha256Hex(challengeId)}.json`, record);
    return { challengeId, ...record };
  }

  /** The challenge's record if `challengeId` was pending and unexpired — consumed either way. `undefined` otherwise. */
  async consume(challengeId: string): Promise<ChallengeRecord | undefined> {
    if (!CHALLENGE_ID.test(challengeId)) return undefined;
    const name = `${sha256Hex(challengeId)}.json`;
    const usedPath = join(this.used, name);
    if (!(await moveExclusive(join(this.pending, name), usedPath))) return undefined;
    const record = await readJson<ChallengeRecord>(usedPath);
    if (record === undefined || typeof record.nonce !== 'string' || Date.parse(record.expiresAt) <= this.now()) return undefined;
    return record;
  }

  /** Remove expired pending challenges and old consumed markers. Bounded by what exists; failures are ignored. */
  async sweep(): Promise<void> {
    const cutoff = this.now() - this.ttl * 2;
    for (const [dir, expired] of [
      [this.pending, async (r: ChallengeRecord | undefined): Promise<boolean> => r === undefined || Date.parse(r.expiresAt) <= this.now()],
      [this.used, async (r: ChallengeRecord | undefined): Promise<boolean> => r === undefined || Date.parse(r.expiresAt) <= cutoff],
    ] as const) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (cause) {
        if (isErrno(cause, 'ENOENT')) continue;
        throw cause;
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const path = join(dir, name);
        const record = await readJson<ChallengeRecord>(path).catch(() => undefined);
        if (await expired(record)) await unlink(path).catch(() => undefined);
      }
    }
  }
}
