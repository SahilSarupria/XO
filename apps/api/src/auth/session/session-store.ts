import { join } from 'node:path';
import { readdir, unlink } from 'node:fs/promises';
import { CREDENTIAL_BODY, ensureDir, isErrno, moveExclusive, randomCredential, readJson, sha256Hex, writeJsonAtomic } from './fs-util.js';

/**
 * Opaque, server-side XO sessions.
 *
 * Two credentials per session, both 256-bit CSPRNG values whose plaintext is returned once and never stored
 * (only SHA-256 digests are, as file names):
 *   - `xoas_…` access credential, valid 15 minutes, presented as the API bearer token;
 *   - `xoar_…` refresh credential, valid 30 days, single-use (rotating), presented only to /auth/refresh.
 *
 * A session "family" is created at sign-in and survives rotations. Revoking the family (logout, refresh-
 * credential reuse, operator action) invalidates every credential in it at once, because every request
 * checks the family record.
 *
 * Reuse detection: a refresh credential is consumed by an atomic rename into `refresh-used/`. Presenting a
 * credential that is found there (already used) revokes its whole family. A client racing itself (two
 * simultaneous refreshes with the same credential) is indistinguishable from a replay and loses its
 * session; that is the safe side of the trade and is documented.
 *
 * What is NOT stored here: the user's identity attributes beyond `(issuer, subject)`, the XO principal, or
 * any permission. The principal is re-derived from the identity binding on every request, so binding
 * changes and revocations apply immediately without touching sessions.
 *
 * Crash behaviour: each file is written atomically. A crash during a rotation after the old refresh
 * credential was consumed but before the new ones were written leaves the family with no usable refresh
 * credential: the client must sign in again. No state in which an unauthorised credential is accepted is
 * reachable by a crash.
 *
 * Supported deployment: one host, local POSIX filesystem (atomic rename). See fs-util.ts.
 */

export const ACCESS_PREFIX = 'xoas_';
export const REFRESH_PREFIX = 'xoar_';
export const ACCESS_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const FAMILY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export type SessionFailure = 'invalid' | 'expired';

interface FamilyRecord {
  readonly familyId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly createdAt: string;
  readonly absoluteExpiresAt: string;
  /**
   * Password sessions only: the account's `passwordVersion` when this family was created. A family whose epoch no longer
   * matches its account is dead (see `SessionGate`), which is how a password change ends every other session without
   * scanning them. Absent on Google sessions.
   */
  readonly credentialEpoch?: number;
  /** Authentication methods that produced this session, e.g. `['pwd']`. A future second factor adds to this list (`['pwd','otp']`) without changing the session model. */
  readonly methods?: readonly string[];
  readonly revokedAt?: string;
  readonly revokedReason?: string;
}
interface AccessRecord {
  readonly familyId: string;
  readonly expiresAt: string;
}
interface RefreshRecord {
  readonly familyId: string;
  readonly expiresAt: string;
}

export interface IssuedSession {
  readonly accessCredential: string;
  readonly refreshCredential: string;
  readonly accessExpiresAt: string;
  readonly refreshExpiresAt: string;
}

export interface SessionIdentity {
  readonly familyId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly credentialEpoch?: number;
  readonly methods?: readonly string[];
}

export type AuthenticateResult =
  { readonly ok: true; readonly session: SessionIdentity } | { readonly ok: false; readonly reason: SessionFailure };
export type RotateResult =
  | { readonly ok: true; readonly session: SessionIdentity; readonly issued: IssuedSession }
  | { readonly ok: false; readonly reason: SessionFailure };

function identityOf(f: FamilyRecord): SessionIdentity {
  return {
    familyId: f.familyId,
    issuer: f.issuer,
    subject: f.subject,
    ...(f.credentialEpoch !== undefined ? { credentialEpoch: f.credentialEpoch } : {}),
    ...(f.methods !== undefined ? { methods: f.methods } : {}),
  };
}

export interface SessionStoreOptions {
  readonly now?: () => number;
  readonly accessTtlMs?: number;
  readonly refreshTtlMs?: number;
}

export class FsSessionStore {
  private readonly families: string;
  private readonly access: string;
  private readonly refresh: string;
  private readonly refreshUsed: string;
  private readonly now: () => number;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;
  private mutations = 0;

  constructor(rootDir: string, options: SessionStoreOptions = {}) {
    const base = join(rootDir, 'sessions');
    this.families = join(base, 'families');
    this.access = join(base, 'access');
    this.refresh = join(base, 'refresh');
    this.refreshUsed = join(base, 'refresh-used');
    this.now = options.now ?? ((): number => Date.now());
    this.accessTtl = options.accessTtlMs ?? ACCESS_TTL_MS;
    this.refreshTtl = options.refreshTtlMs ?? REFRESH_TTL_MS;
  }

  /** Start a new session family for a verified `(issuer, subject)`. */
  async create(
    issuer: string,
    subject: string,
    extra: { readonly credentialEpoch?: number; readonly methods?: readonly string[] } = {},
  ): Promise<IssuedSession & { readonly familyId: string }> {
    for (const d of [this.families, this.access, this.refresh, this.refreshUsed]) await ensureDir(d);
    await this.maybeSweep();
    const familyId = sha256Hex(randomCredential('fam_')).slice(0, 32);
    const created = this.now();
    const family: FamilyRecord = {
      familyId,
      issuer,
      subject,
      createdAt: new Date(created).toISOString(),
      absoluteExpiresAt: new Date(created + FAMILY_MAX_AGE_MS).toISOString(),
      ...(extra.credentialEpoch !== undefined ? { credentialEpoch: extra.credentialEpoch } : {}),
      ...(extra.methods !== undefined ? { methods: extra.methods } : {}),
    };
    await writeJsonAtomic(this.families, `${familyId}.json`, family);
    return { familyId, ...(await this.issue(familyId, Math.min(created + this.refreshTtl, created + FAMILY_MAX_AGE_MS))) };
  }

  private async issue(familyId: string, refreshExpiresMs: number): Promise<IssuedSession> {
    const accessCredential = randomCredential(ACCESS_PREFIX);
    const refreshCredential = randomCredential(REFRESH_PREFIX);
    const t = this.now();
    const accessExpiresAt = new Date(t + this.accessTtl).toISOString();
    const refreshExpiresAt = new Date(refreshExpiresMs).toISOString();
    // Write the refresh credential first: if the process dies between the two writes, the client holds
    // neither and signs in again; an access credential is never issued without a recorded refresh.
    await writeJsonAtomic(this.refresh, `${sha256Hex(refreshCredential)}.json`, {
      familyId,
      expiresAt: refreshExpiresAt,
    } satisfies RefreshRecord);
    await writeJsonAtomic(this.access, `${sha256Hex(accessCredential)}.json`, {
      familyId,
      expiresAt: accessExpiresAt,
    } satisfies AccessRecord);
    return { accessCredential, refreshCredential, accessExpiresAt, refreshExpiresAt };
  }

  private async family(familyId: string): Promise<FamilyRecord | undefined> {
    const f = await readJson<FamilyRecord>(join(this.families, `${familyId}.json`));
    if (f === undefined || f.familyId !== familyId || typeof f.issuer !== 'string' || typeof f.subject !== 'string') return undefined;
    return f;
  }

  private live(f: FamilyRecord): boolean {
    return f.revokedAt === undefined && Date.parse(f.absoluteExpiresAt) > this.now();
  }

  async authenticate(accessCredential: string): Promise<AuthenticateResult> {
    if (!accessCredential.startsWith(ACCESS_PREFIX) || !CREDENTIAL_BODY.test(accessCredential.slice(ACCESS_PREFIX.length)))
      return { ok: false, reason: 'invalid' };
    const rec = await readJson<AccessRecord>(join(this.access, `${sha256Hex(accessCredential)}.json`));
    if (rec === undefined || typeof rec.familyId !== 'string') return { ok: false, reason: 'invalid' };
    const family = await this.family(rec.familyId);
    if (family === undefined || !this.live(family)) return { ok: false, reason: 'invalid' };
    if (Date.parse(rec.expiresAt) <= this.now()) return { ok: false, reason: 'expired' };
    return { ok: true, session: identityOf(family) };
  }

  /** Exchange a refresh credential for a new pair. Single-use; presenting a used one revokes the family. */
  async rotate(refreshCredential: string): Promise<RotateResult> {
    if (!refreshCredential.startsWith(REFRESH_PREFIX) || !CREDENTIAL_BODY.test(refreshCredential.slice(REFRESH_PREFIX.length)))
      return { ok: false, reason: 'invalid' };
    const name = `${sha256Hex(refreshCredential)}.json`;
    const usedPath = join(this.refreshUsed, name);
    const won = await moveExclusive(join(this.refresh, name), usedPath);
    if (!won) {
      // Not pending. If it was used before, this is a replay (or a client racing itself): kill the family.
      const earlier = await readJson<RefreshRecord>(usedPath);
      if (earlier !== undefined && typeof earlier.familyId === 'string') await this.revoke(earlier.familyId, 'refresh-reuse');
      return { ok: false, reason: 'invalid' };
    }
    const rec = await readJson<RefreshRecord>(usedPath);
    if (rec === undefined || typeof rec.familyId !== 'string') return { ok: false, reason: 'invalid' };
    const family = await this.family(rec.familyId);
    if (family === undefined || !this.live(family)) return { ok: false, reason: 'invalid' };
    if (Date.parse(rec.expiresAt) <= this.now()) return { ok: false, reason: 'expired' };
    const refreshExpiresMs = Math.min(this.now() + this.refreshTtl, Date.parse(family.absoluteExpiresAt));
    const issued = await this.issue(family.familyId, refreshExpiresMs);
    await this.maybeSweep();
    return { ok: true, session: identityOf(family), issued };
  }

  /** The identity of a LIVE (not revoked, not expired) family, or `undefined`. Used by routes that act on "the caller's own session". */
  async describe(familyId: string): Promise<SessionIdentity | undefined> {
    const family = await this.family(familyId);
    return family !== undefined && this.live(family) ? identityOf(family) : undefined;
  }

  /** Revoke a family (idempotent). */
  async revoke(familyId: string, reason: string): Promise<void> {
    const family = await this.family(familyId);
    if (family === undefined || family.revokedAt !== undefined) return;
    await writeJsonAtomic(this.families, `${familyId}.json`, {
      ...family,
      revokedAt: new Date(this.now()).toISOString(),
      revokedReason: reason,
    } satisfies FamilyRecord);
  }

  private async maybeSweep(): Promise<void> {
    if (++this.mutations % 50 !== 1) return;
    await this.sweep().catch(() => undefined);
  }

  /** Delete expired credential records and families past their absolute lifetime. Best effort. A deleted family reads as invalid, exactly like a revoked one. */
  async sweep(): Promise<void> {
    const t = this.now();
    for (const dir of [this.access, this.refresh, this.refreshUsed]) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (cause) {
        if (isErrno(cause, 'ENOENT')) continue;
        throw cause;
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const rec = await readJson<{ expiresAt?: string }>(join(dir, name)).catch(() => undefined);
        // Used refresh records are kept for as long as they could still be replayed (their own expiry) so reuse stays detectable.
        if (rec === undefined || typeof rec.expiresAt !== 'string' || Date.parse(rec.expiresAt) <= t)
          await unlink(join(dir, name)).catch(() => undefined);
      }
    }
    let familyNames: string[] = [];
    try {
      familyNames = await readdir(this.families);
    } catch (cause) {
      if (!isErrno(cause, 'ENOENT')) throw cause;
    }
    for (const name of familyNames) {
      if (!name.endsWith('.json')) continue;
      const f = await readJson<FamilyRecord>(join(this.families, name)).catch(() => undefined);
      if (f === undefined || Date.parse(f.absoluteExpiresAt) <= t - 24 * 60 * 60 * 1000)
        await unlink(join(this.families, name)).catch(() => undefined);
    }
  }
}
