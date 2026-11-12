import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { CREDENTIAL_BODY, ensureDir, moveExclusive, randomCredential, readJson, sha256Hex, writeJsonAtomic } from '../session/fs-util.js';
import { withLock } from './file-lock.js';

/**
 * Single-use, expiring tokens that let a person set a password without the operator ever learning it: the first
 * password ("setup") and an operator-assisted recovery ("reset"). There is no email delivery — an operator hands the
 * token over out of band.
 *
 *  - 256 random bits; only the SHA-256 DIGEST is stored (as the file name), never the token.
 *  - Redeemed by atomic rename: of any number of concurrent attempts exactly one wins.
 *  - At most ONE outstanding token per account; issuing another deletes the previous one.
 *  - Bound to the account's `passwordVersion`: any password change invalidates every outstanding token.
 *  - Unknown, expired, used, superseded and mismatched tokens are indistinguishable to the caller (`undefined`).
 */
export const TOKEN_PREFIX = 'xot_';
export const SETUP_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 30 * 60 * 1000;

export type TokenPurpose = 'setup' | 'reset';

export interface TokenRecord {
  readonly accountId: string;
  readonly purpose: TokenPurpose;
  readonly passwordVersion: number;
  readonly expiresAt: string;
  readonly issuedBy: string;
}

export class FsTokenStore {
  private readonly pending: string;
  private readonly used: string;
  private readonly byAccount: string;
  private readonly locks: string;

  constructor(
    baseDir: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.pending = join(baseDir, 'tokens');
    this.used = join(baseDir, 'tokens-used');
    this.byAccount = join(baseDir, 'tokens-by-account');
    this.locks = join(baseDir, 'locks');
  }

  /** Issues a token for `accountId`, superseding any outstanding one. The returned string is shown once and never stored. */
  issue(
    accountId: string,
    purpose: TokenPurpose,
    passwordVersion: number,
    issuedBy: string,
  ): Promise<{ readonly token: string; readonly expiresAt: string }> {
    return withLock(this.locks, `tok-${accountId}`, async () => {
      for (const d of [this.pending, this.used, this.byAccount]) await ensureDir(d);
      const previous = await readJson<{ digest?: unknown }>(join(this.byAccount, `${accountId}.json`));
      if (previous !== undefined && typeof previous.digest === 'string' && /^[0-9a-f]{64}$/.test(previous.digest)) {
        await unlink(join(this.pending, `${previous.digest}.json`)).catch(() => undefined);
      }
      const token = randomCredential(TOKEN_PREFIX);
      const digest = sha256Hex(token);
      const expiresAt = new Date(this.now() + (purpose === 'setup' ? SETUP_TTL_MS : RESET_TTL_MS)).toISOString();
      const record: TokenRecord = { accountId, purpose, passwordVersion, expiresAt, issuedBy };
      await writeJsonAtomic(this.pending, `${digest}.json`, record);
      await writeJsonAtomic(this.byAccount, `${accountId}.json`, { digest });
      return { token, expiresAt };
    });
  }

  /** Reads a pending token WITHOUT consuming it (so input can be validated before the one chance to redeem is spent). Same validity rules as `redeem`. */
  async peek(token: string): Promise<TokenRecord | undefined> {
    if (!token.startsWith(TOKEN_PREFIX) || !CREDENTIAL_BODY.test(token.slice(TOKEN_PREFIX.length))) return undefined;
    const file = join(this.pending, `${sha256Hex(token)}.json`);
    const record = await readJson<TokenRecord>(file);
    if (record === undefined || typeof record.accountId !== 'string') return undefined;
    if (Date.parse(record.expiresAt) <= this.now()) {
      // An expired token is spent for good: deleting it means no later clock change can bring it back.
      await unlink(file).catch(() => undefined);
      return undefined;
    }
    return record.purpose === 'setup' || record.purpose === 'reset' ? record : undefined;
  }

  /** Consumes the token if it is well-formed, pending and unexpired. Consumed even when expired, so it cannot be retried. */
  async redeem(token: string): Promise<TokenRecord | undefined> {
    if (!token.startsWith(TOKEN_PREFIX) || !CREDENTIAL_BODY.test(token.slice(TOKEN_PREFIX.length))) return undefined;
    const name = `${sha256Hex(token)}.json`;
    await ensureDir(this.used);
    const won = await moveExclusive(join(this.pending, name), join(this.used, name));
    if (!won) return undefined;
    const record = await readJson<TokenRecord>(join(this.used, name));
    if (record === undefined || typeof record.accountId !== 'string' || Date.parse(record.expiresAt) <= this.now()) return undefined;
    if (record.purpose !== 'setup' && record.purpose !== 'reset') return undefined;
    return record;
  }

  /** True when an unexpired token is outstanding for the account (operator status only; never reveals the token). */
  async hasOutstanding(accountId: string): Promise<boolean> {
    const ptr = await readJson<{ digest?: unknown }>(join(this.byAccount, `${accountId}.json`));
    if (ptr === undefined || typeof ptr.digest !== 'string' || !/^[0-9a-f]{64}$/.test(ptr.digest)) return false;
    const rec = await readJson<TokenRecord>(join(this.pending, `${ptr.digest}.json`));
    return rec !== undefined && Date.parse(rec.expiresAt) > this.now();
  }
}
