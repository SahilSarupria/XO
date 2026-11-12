import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

/** `Algorithm.Argon2id`. The package exports a `const enum`, which `isolatedModules` cannot import; the value is fixed by the Argon2 spec's type ids (0 = d, 1 = i, 2 = id) and pinned by a test that checks the PHC prefix. */
const ARGON2ID = 2 as never;
import { normalizePassword } from './password-policy.js';

/**
 * Argon2id password hashing (`@node-rs/argon2`: prebuilt native binaries, no compile step). Output is a PHC string
 * carrying algorithm, version, parameters and a random per-hash salt, so verification needs nothing but the string.
 *
 * All hashing goes through a counting semaphore with a bounded queue. Memory-hard hashing is itself a denial-of-
 * service lever (each call holds tens of MiB), so at most `concurrency` run at once, at most `queueLimit` wait, and
 * anything beyond that is refused with `PasswordHasherBusyError` (the route answers 503) instead of hanging.
 */
export interface Argon2Params {
  readonly memoryKiB: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

export class PasswordHasherBusyError extends Error {
  constructor() {
    super('the password hasher is saturated');
  }
}

export class PasswordHasher {
  private running = 0;
  private readonly waiters: Array<() => void> = [];
  private dummy: Promise<string> | undefined;

  constructor(
    private readonly params: Argon2Params,
    private readonly concurrency = 2,
    private readonly queueLimit = 32,
  ) {}

  private async acquire(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running++;
      return;
    }
    if (this.waiters.length >= this.queueLimit) throw new PasswordHasherBusyError();
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next !== undefined)
      next(); // hand the slot straight to the next waiter
    else this.running--;
  }

  private async limited<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  /** Hashes the NFKC-normalized password. */
  hash(password: string): Promise<string> {
    return this.limited(() =>
      argonHash(normalizePassword(password), {
        algorithm: ARGON2ID,
        memoryCost: this.params.memoryKiB,
        timeCost: this.params.timeCost,
        parallelism: this.params.parallelism,
      }),
    );
  }

  /** `false` for a wrong password AND for a malformed stored hash (never throws on bad data). Throws only `PasswordHasherBusyError`. */
  verify(storedHash: string, password: string): Promise<boolean> {
    return this.limited(async () => {
      try {
        return await argonVerify(storedHash, normalizePassword(password));
      } catch {
        return false;
      }
    });
  }

  /**
   * Verifies `password` against a fixed hash made with THIS host's parameters and always returns false. Used for
   * logins that name no usable account, so "no such account" costs the same time as "wrong password".
   */
  async verifyAgainstDummy(password: string): Promise<false> {
    this.dummy ??= this.hash('xo-dummy-password-never-matches-anything');
    await this.verify(await this.dummy, password);
    return false;
  }

  /** True when `storedHash` is not Argon2id or was made with weaker parameters than the current ones (rehash on next successful sign-in). */
  needsRehash(storedHash: string): boolean {
    const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
    if (m === null) return true;
    return Number(m[1]) < this.params.memoryKiB || Number(m[2]) < this.params.timeCost || Number(m[3]) < this.params.parallelism;
  }
}
