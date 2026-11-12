import { join } from 'node:path';
import { readdir, unlink } from 'node:fs/promises';
import { ensureDir, isErrno, readJson, sha256Hex, writeJsonAtomic } from './fs-util.js';

/**
 * Bounded, operator-only record of recent sign-ins that verified at Google but have no XO binding, so an
 * operator can see which `(issuer, sub)` to bind. It is NOT a login-attempt log and NOT provisioning.
 *
 * Stored per entry: canonical issuer, `sub`, and the time of the latest attempt: nothing else. No email, no
 * token, no code, no client-supplied text. Entries are written only AFTER an ID token's signature, issuer,
 * audience, expiry and nonce all verified, so unauthenticated callers cannot fill it with chosen values.
 * Bounded by count (oldest evicted) and by age. There is no API route that reads it: it is read only by
 * `scripts/manage-oidc-bindings.ts unbound`, with filesystem access to the sessions directory.
 */

export const UNBOUND_MAX_ENTRIES = 100;
export const UNBOUND_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface UnboundAttempt {
  readonly issuer: string;
  readonly subject: string;
  readonly at: string;
}

export class FsUnboundLog {
  private readonly dir: string;
  constructor(
    rootDir: string,
    private readonly now: () => number = (): number => Date.now(),
    private readonly maxEntries = UNBOUND_MAX_ENTRIES,
    private readonly retentionMs = UNBOUND_RETENTION_MS,
  ) {
    this.dir = join(rootDir, 'unbound-logins');
  }

  private nameFor(issuer: string, subject: string): string {
    return `${sha256Hex(JSON.stringify([issuer, subject]))}.json`;
  }

  async record(issuer: string, subject: string): Promise<void> {
    await ensureDir(this.dir);
    const entries = await this.readAll();
    const mine = this.nameFor(issuer, subject);
    const live = entries.filter((e) => this.fresh(e.entry));
    // Evict expired entries, then the oldest, to stay within the bound (a re-attempt by a known pair replaces itself).
    const others = live.filter((e) => e.name !== mine).sort((a, b) => Date.parse(a.entry.at) - Date.parse(b.entry.at));
    const keep = this.maxEntries - 1;
    const doomed = [...entries.filter((e) => !this.fresh(e.entry)), ...others.slice(0, Math.max(0, others.length - keep))];
    for (const d of doomed) await unlink(join(this.dir, d.name)).catch(() => undefined);
    await writeJsonAtomic(this.dir, mine, { issuer, subject, at: new Date(this.now()).toISOString() } satisfies UnboundAttempt);
  }

  async list(): Promise<UnboundAttempt[]> {
    const all = await this.readAll();
    return all
      .map((e) => e.entry)
      .filter((e) => this.fresh(e))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }

  /** Called when an operator binds the pair: the discovery entry has served its purpose. */
  async forget(issuer: string, subject: string): Promise<void> {
    await unlink(join(this.dir, this.nameFor(issuer, subject))).catch(() => undefined);
  }

  private fresh(e: UnboundAttempt): boolean {
    return Date.parse(e.at) > this.now() - this.retentionMs;
  }

  private async readAll(): Promise<{ name: string; entry: UnboundAttempt }[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (cause) {
      if (isErrno(cause, 'ENOENT')) return [];
      throw cause;
    }
    const out: { name: string; entry: UnboundAttempt }[] = [];
    for (const name of names) {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
      const entry = await readJson<UnboundAttempt>(join(this.dir, name)).catch(() => undefined);
      if (entry === undefined || typeof entry.issuer !== 'string' || typeof entry.subject !== 'string' || typeof entry.at !== 'string')
        continue;
      if (this.nameFor(entry.issuer, entry.subject) !== name) continue; // must match its own name
      out.push({ name, entry: { issuer: entry.issuer, subject: entry.subject, at: entry.at } });
    }
    return out;
  }
}
