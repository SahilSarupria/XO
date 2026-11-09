import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';

/**
 * Who may call the API, and for what.
 *
 * - A token is 32 random bytes (`xo_` + 43 base64url characters). Only its SHA-256 is stored; the token itself exists once, when it is created.
 *   (A fast hash is correct here: the secret already has 256 bits of entropy, so there is nothing to brute-force or to stretch.)
 * - A token carries SCOPES. A route needs one scope; `admin` satisfies any. A route nobody mapped needs `admin` (deny by default).
 * - A token may expire, may be revoked (immediately, or at a future moment to allow an overlap when rotating), and is rotated by issuing a new one.
 * - The store is a JSON file that must not be readable by group or others (POSIX), is replaced atomically, and is re-read when it changes, so a
 *   revocation takes effect without restarting the server. A file that cannot be read or parsed DENIES EVERYTHING rather than falling back to anything.
 */
export const SCOPES = ['read', 'run', 'approve', 'lease', 'ledger-sync', 'admin'] as const;
export type Scope = (typeof SCOPES)[number];

export const TOKEN_FORMAT = /^xo_[A-Za-z0-9_-]{43}$/;
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:~-]{0,63}$/;

export type AuthFailure = 'malformed' | 'unknown' | 'expired' | 'revoked' | 'unavailable';
export type AuthResult =
  | { readonly ok: true; readonly client: { readonly id: string; readonly scopes: ReadonlySet<Scope> } }
  | { readonly ok: false; readonly reason: AuthFailure };

export interface TokenAuthority {
  authenticate(bearerToken: string, nowMs: number): AuthResult;
}

export interface ClientRecord {
  readonly id: string;
  readonly hash: string;
  readonly scopes: readonly Scope[];
  readonly createdAt: string;
  readonly expiresAt?: string;
  /** The token stops working at this instant (immediately when set to "now"). */
  readonly revokedAt?: string;
  readonly note?: string;
}

interface FileShape {
  readonly version: 1;
  readonly clients: readonly ClientRecord[];
}

export class TokenFileError extends Error {}

const hashOf = (token: string): string => `sha256:${createHash('sha256').update(token).digest('hex')}`;

export function newToken(): string {
  return `xo_${randomBytes(32).toString('base64url')}`;
}

function validateRecord(r: unknown, i: number): ClientRecord {
  const where = `clients[${i}]`;
  if (typeof r !== 'object' || r === null || Array.isArray(r)) throw new TokenFileError(`${where} must be an object`);
  const o = r as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (!['id', 'hash', 'scopes', 'createdAt', 'expiresAt', 'revokedAt', 'note'].includes(k))
      throw new TokenFileError(`${where}: unknown key "${k}"`);
  if (typeof o['id'] !== 'string' || !CLIENT_ID.test(o['id'])) throw new TokenFileError(`${where}: invalid id`);
  if (typeof o['hash'] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(o['hash']))
    throw new TokenFileError(`${where} (${o['id']}): hash must be sha256:<64 hex>`);
  if (!Array.isArray(o['scopes']) || o['scopes'].length === 0)
    throw new TokenFileError(`${where} (${o['id']}): scopes must be a non-empty list`);
  for (const s of o['scopes'])
    if (!SCOPES.includes(s as Scope)) throw new TokenFileError(`${where} (${o['id']}): unknown scope "${String(s)}"`);
  for (const k of ['createdAt', 'expiresAt', 'revokedAt'] as const)
    if (o[k] !== undefined && (typeof o[k] !== 'string' || Number.isNaN(Date.parse(o[k] as string))))
      throw new TokenFileError(`${where} (${o['id']}): ${k} is not a date`);
  if (typeof o['createdAt'] !== 'string') throw new TokenFileError(`${where} (${o['id']}): createdAt is required`);
  return o as unknown as ClientRecord;
}

/** The shared parser: strict and total. Anything unexpected is an error, never a partial load. */
export function parseTokenFile(text: string): readonly ClientRecord[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new TokenFileError('token file is not valid JSON');
  }
  const o = raw as { version?: unknown; clients?: unknown } | null;
  if (typeof o !== 'object' || o === null || o.version !== 1 || !Array.isArray(o.clients))
    throw new TokenFileError('token file must be {"version":1,"clients":[...]}');
  const records = o.clients.map(validateRecord);
  const ids = new Set<string>();
  const hashes = new Set<string>();
  for (const r of records) {
    if (ids.has(r.id)) throw new TokenFileError(`duplicate client id "${r.id}"`);
    if (hashes.has(r.hash)) throw new TokenFileError(`two clients share a token hash ("${r.id}")`);
    ids.add(r.id);
    hashes.add(r.hash);
  }
  return records;
}

export interface FileTokenStoreOptions {
  /** Skip the owner-only permission check (tests on filesystems without POSIX modes). Never set in production. */
  readonly skipPermissionCheck?: boolean;
  /** How often the file's change time is checked on authentication. Default 1000 ms. */
  readonly reloadCheckMs?: number;
  readonly now?: () => number;
}

export class FileTokenStore implements TokenAuthority {
  private byHash = new Map<string, ClientRecord>();
  private error: string | undefined;
  private lastSignature = '';
  private lastCheck = Number.NEGATIVE_INFINITY;

  private constructor(
    readonly path: string,
    private readonly o: FileTokenStoreOptions,
  ) {}

  /** Opens (creating an empty store if the file does not exist). Throws `TokenFileError` on a file that is unreadable, malformed or too permissive. */
  static open(path: string, o: FileTokenStoreOptions = {}): FileTokenStore {
    const s = new FileTokenStore(path, o);
    if (!existsSync(path)) s.write([]);
    s.load(true);
    return s;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private checkMode(): void {
    if (this.o.skipPermissionCheck === true || process.platform === 'win32') return;
    const mode = statSync(this.path).mode & 0o777;
    if ((mode & 0o077) !== 0)
      throw new TokenFileError(`${this.path} is accessible to other users (mode ${mode.toString(8)}); it must be 0600`);
  }

  private load(strict: boolean): void {
    try {
      this.checkMode();
      const st = statSync(this.path);
      const records = parseTokenFile(readFileSync(this.path, 'utf8'));
      this.byHash = new Map(records.map((r) => [r.hash, r]));
      this.error = undefined;
      this.lastSignature = `${st.mtimeMs}:${st.size}`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (strict) throw e instanceof TokenFileError ? e : new TokenFileError(msg);
      // a store that stops being readable or valid while the server runs denies EVERYTHING until it is fixed
      this.byHash = new Map();
      this.error = msg;
      this.lastSignature = '';
    }
    this.lastCheck = this.now();
  }

  /** Re-reads the file when it changed (checked at most every `reloadCheckMs`). */
  private refresh(): void {
    const t = this.now();
    if (t - this.lastCheck < (this.o.reloadCheckMs ?? 1000)) return;
    this.lastCheck = t;
    try {
      const st = statSync(this.path);
      if (`${st.mtimeMs}:${st.size}` !== this.lastSignature) this.load(false);
    } catch (e) {
      this.byHash = new Map();
      this.error = e instanceof Error ? e.message : String(e);
      this.lastSignature = '';
    }
  }

  /** Why the store is denying everything, or undefined when it is healthy. Surfaced to operators, never to callers. */
  get unavailableReason(): string | undefined {
    return this.error;
  }

  authenticate(bearerToken: string, nowMs: number): AuthResult {
    this.refresh();
    if (this.error !== undefined) return { ok: false, reason: 'unavailable' };
    if (!TOKEN_FORMAT.test(bearerToken)) return { ok: false, reason: 'malformed' };
    // lookup by the hash of what was presented: a prefix of the secret never selects anything, so there is nothing to time
    const presented = hashOf(bearerToken);
    const rec = this.byHash.get(presented);
    if (rec === undefined) return { ok: false, reason: 'unknown' };
    const a = Buffer.from(rec.hash);
    const b = Buffer.from(presented);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'unknown' };
    if (rec.revokedAt !== undefined && nowMs >= Date.parse(rec.revokedAt)) return { ok: false, reason: 'revoked' };
    if (rec.expiresAt !== undefined && nowMs >= Date.parse(rec.expiresAt)) return { ok: false, reason: 'expired' };
    return { ok: true, client: { id: rec.id, scopes: new Set(rec.scopes) } };
  }

  // ── management (used by `xo token`; the server itself only reads) ─────────────────────────────────────────────────────────

  list(): readonly ClientRecord[] {
    this.load(true);
    return [...this.byHash.values()];
  }

  /** Creates a client and returns its token. The token is returned ONCE and is not recoverable. */
  create(id: string, scopes: readonly Scope[], opts: { readonly ttlMs?: number; readonly note?: string } = {}): string {
    if (!CLIENT_ID.test(id)) throw new TokenFileError(`invalid client id "${id}"`);
    if (scopes.length === 0 || scopes.some((s) => !SCOPES.includes(s)))
      throw new TokenFileError(`scopes must be a non-empty subset of ${SCOPES.join(', ')}`);
    if (opts.ttlMs !== undefined && (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0)) throw new TokenFileError('ttl must be positive');
    const records = [...this.list()];
    if (records.some((r) => r.id === id)) throw new TokenFileError(`client "${id}" already exists (revoke or rotate it instead)`);
    const token = newToken();
    const t = this.now();
    records.push({
      id,
      hash: hashOf(token),
      scopes: [...new Set(scopes)],
      createdAt: new Date(t).toISOString(),
      ...(opts.ttlMs !== undefined ? { expiresAt: new Date(t + opts.ttlMs).toISOString() } : {}),
      ...(opts.note !== undefined ? { note: opts.note.slice(0, 200) } : {}),
    });
    this.write(records);
    this.load(true);
    return token;
  }

  /** Revokes at `atMs` (default: now). Revoking a client that is already revoked earlier changes nothing. */
  revoke(id: string, atMs: number = this.now()): void {
    const records = [...this.list()];
    const i = records.findIndex((r) => r.id === id);
    if (i < 0) throw new TokenFileError(`no client "${id}"`);
    const cur = records[i]!;
    if (cur.revokedAt !== undefined && Date.parse(cur.revokedAt) <= atMs) return;
    records[i] = { ...cur, revokedAt: new Date(atMs).toISOString() };
    this.write(records);
    this.load(true);
  }

  /**
   * Issues a replacement token with the same scopes under a new id (`<id>~<n>`) and revokes the old one after `overlapMs` (default 0: at once), so a deployment
   * can switch over without a gap. Returns the new client id and its token.
   */
  rotate(id: string, opts: { readonly ttlMs?: number; readonly overlapMs?: number } = {}): { readonly id: string; readonly token: string } {
    const old = this.list().find((r) => r.id === id);
    if (old === undefined) throw new TokenFileError(`no client "${id}"`);
    const base = id.replace(/~\d+$/, '');
    const taken = new Set(this.list().map((r) => r.id));
    let n = 2;
    while (taken.has(`${base}~${n}`)) n++;
    const newId = `${base}~${n}`;
    const token = this.create(newId, old.scopes, opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {});
    this.revoke(id, this.now() + (opts.overlapMs ?? 0));
    return { id: newId, token };
  }

  /** Atomic replace, owner-only, fsynced: a crash leaves the old file or the new one, never a torn one. */
  private write(records: readonly ClientRecord[]): void {
    const body = `${JSON.stringify({ version: 1, clients: records } satisfies FileShape, null, 2)}\n`;
    const tmp = `${this.path}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}

/** A fixed set of tokens held in memory (tests, embedding applications). */
export class StaticTokenAuthority implements TokenAuthority {
  private readonly byHash: Map<string, ClientRecord>;
  constructor(
    clients: readonly {
      readonly id: string;
      readonly token: string;
      readonly scopes: readonly Scope[];
      readonly expiresAtMs?: number;
      readonly revokedAtMs?: number;
    }[],
  ) {
    this.byHash = new Map(
      clients.map((c) => [
        hashOf(c.token),
        {
          id: c.id,
          hash: hashOf(c.token),
          scopes: c.scopes,
          createdAt: new Date(0).toISOString(),
          ...(c.expiresAtMs !== undefined ? { expiresAt: new Date(c.expiresAtMs).toISOString() } : {}),
          ...(c.revokedAtMs !== undefined ? { revokedAt: new Date(c.revokedAtMs).toISOString() } : {}),
        },
      ]),
    );
  }
  authenticate(bearerToken: string, nowMs: number): AuthResult {
    if (!TOKEN_FORMAT.test(bearerToken)) return { ok: false, reason: 'malformed' };
    const rec = this.byHash.get(hashOf(bearerToken));
    if (rec === undefined) return { ok: false, reason: 'unknown' };
    if (rec.revokedAt !== undefined && nowMs >= Date.parse(rec.revokedAt)) return { ok: false, reason: 'revoked' };
    if (rec.expiresAt !== undefined && nowMs >= Date.parse(rec.expiresAt)) return { ok: false, reason: 'expired' };
    return { ok: true, client: { id: rec.id, scopes: new Set(rec.scopes) } };
  }
}

/**
 * The scope a request needs, from method and path alone (so it is decided BEFORE any body is read). Deny by default: a route that is not listed here
 * needs `admin`. `public` is exactly `GET /v1/health`.
 */
export function requiredScope(method: string, pathname: string): Scope | 'public' {
  const p = pathname.split('/').filter((x) => x !== '');
  if (p[0] !== 'v1') return 'admin';
  const m = method.toUpperCase();
  if (p.length === 2 && p[1] === 'health' && pathname === '/v1/health') return m === 'GET' ? 'public' : 'admin';
  if (p[1] === 'decide' && p.length === 2) return m === 'POST' ? 'read' : 'admin';
  if (p[1] === 'workflows' && p[3] === 'runs' && p.length === 4) return m === 'POST' ? 'run' : m === 'GET' ? 'read' : 'admin';
  if (p[1] === 'runs' && p.length === 3) return m === 'GET' ? 'read' : 'admin';
  if (p[1] === 'runs' && p[3] === 'lease' && p.length === 4) return m === 'POST' ? 'lease' : 'admin';
  if (p[1] === 'ledger' && p.length === 3) return m === 'GET' || m === 'POST' ? 'ledger-sync' : 'admin';
  if (p[1] === 'approvals') return m === 'GET' ? 'read' : m === 'POST' ? 'approve' : 'admin';
  if (p[1] === 'loader' && p[2] === 'resolve' && p.length === 3) return m === 'POST' ? 'read' : 'admin';
  if (p[1] === 'receipts' && p.length === 2) return m === 'GET' ? 'read' : 'admin';
  return 'admin';
}

export const hasScope = (scopes: ReadonlySet<Scope>, need: Scope): boolean => scopes.has('admin') || scopes.has(need);
