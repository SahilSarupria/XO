import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, isErrno, readJson, sha256Hex, writeJsonAtomic } from '../session/fs-util.js';
import { withLock } from './file-lock.js';

/**
 * One file per password account, plus a login-name index. Records are 0600 in 0700 directories. The hash lives ONLY
 * here; no log, audit event, response or error ever contains it (see `service.ts`).
 */
export interface PasswordAccount {
  readonly accountId: string;
  /** NFKC-normalized, lower-cased. A label an operator chose; not a verified email address. */
  readonly loginName: string;
  /** PHC string. Absent until the first password is set through a setup token. */
  readonly hash?: string;
  /** Bumped by every password change or reset. Sessions and outstanding tokens are bound to it. */
  readonly passwordVersion: number;
  readonly state: 'active' | 'disabled';
  readonly createdAt: string;
  readonly passwordChangedAt?: string;
}

export const ACCOUNT_ID = /^acct_[0-9a-f]{32}$/;

export class LoginNameTakenError extends Error {
  constructor() {
    super('that login name is already in use');
  }
}

const nameFile = (normalized: string) => `${sha256Hex(`login:${normalized}`)}.json`;

export class FsAccountStore {
  private readonly accounts: string;
  private readonly names: string;
  private readonly locks: string;

  constructor(baseDir: string) {
    this.accounts = join(baseDir, 'accounts');
    this.names = join(baseDir, 'names');
    this.locks = join(baseDir, 'locks');
  }

  async get(accountId: string): Promise<PasswordAccount | undefined> {
    if (!ACCOUNT_ID.test(accountId)) return undefined;
    const a = await readJson<PasswordAccount>(join(this.accounts, `${accountId}.json`));
    if (a === undefined || a.accountId !== accountId || typeof a.loginName !== 'string' || !Number.isInteger(a.passwordVersion))
      return undefined;
    if (a.state !== 'active' && a.state !== 'disabled') return undefined;
    return a;
  }

  async findByLogin(normalizedLoginName: string): Promise<PasswordAccount | undefined> {
    const idx = await readJson<{ accountId?: unknown }>(join(this.names, nameFile(normalizedLoginName)));
    if (idx === undefined || typeof idx.accountId !== 'string') return undefined;
    const account = await this.get(idx.accountId);
    return account !== undefined && account.loginName === normalizedLoginName ? account : undefined;
  }

  /** Creates an account with no password. Throws `LoginNameTakenError` if the name exists (exclusive create: one winner among concurrent callers). */
  async create(normalizedLoginName: string, now: Date): Promise<PasswordAccount> {
    await ensureDir(this.names);
    const accountId = `acct_${randomBytes(16).toString('hex')}`;
    const indexPath = join(this.names, nameFile(normalizedLoginName));
    let handle;
    try {
      handle = await open(indexPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    } catch (cause) {
      if (isErrno(cause, 'EEXIST')) throw new LoginNameTakenError();
      throw cause;
    }
    try {
      await handle.writeFile(JSON.stringify({ accountId }), { encoding: 'utf8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
    const account: PasswordAccount = {
      accountId,
      loginName: normalizedLoginName,
      passwordVersion: 0,
      state: 'active',
      createdAt: now.toISOString(),
    };
    await writeJsonAtomic(this.accounts, `${accountId}.json`, account);
    return account;
  }

  /** Removes a half-created account (operator CLI rollback only). */
  async discard(account: PasswordAccount): Promise<void> {
    await unlink(join(this.accounts, `${account.accountId}.json`)).catch(() => undefined);
    await unlink(join(this.names, nameFile(account.loginName))).catch(() => undefined);
  }

  /** Read-modify-write under a cross-process lock. `mutate` returns the next record, or `undefined` to abort without writing. */
  update(accountId: string, mutate: (current: PasswordAccount) => PasswordAccount | undefined): Promise<PasswordAccount | undefined> {
    return withLock(this.locks, accountId, async () => {
      const current = await this.get(accountId);
      if (current === undefined) return undefined;
      const next = mutate(current);
      if (next === undefined) return undefined;
      await writeJsonAtomic(this.accounts, `${accountId}.json`, next);
      return next;
    });
  }

  async list(): Promise<readonly PasswordAccount[]> {
    const files = await readdir(this.accounts).catch(() => [] as string[]);
    const out: PasswordAccount[] = [];
    for (const f of files) {
      const m = /^(acct_[0-9a-f]{32})\.json$/.exec(f);
      const a = m === null ? undefined : await this.get(m[1] as string);
      if (a !== undefined) out.push(a);
    }
    return out.sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1));
  }
}
