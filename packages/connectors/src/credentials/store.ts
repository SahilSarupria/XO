/**
 * UW-9 (ADR 0036) — the encrypted, per-tenant credential store.
 *
 * Encryption. Every credential's secret part (OAuth access and refresh tokens, an app password, an API key) is sealed with
 * AES-256-GCM under a key derived for its tenant: HKDF-SHA256(instance master key, salt "xo-credentials/1", info tenant id). The
 * additional authenticated data binds the ciphertext to the record that carries it (schema, credential id, tenant, kind, provider,
 * version), so a record copied into another tenant, or edited to name another tenant or credential, does not open. The master key
 * never lives in the data directory (the instance passes it in), so a copy of the data is not a copy of the credentials.
 *
 * Writes. A credential is a directory of immutable versions (`<id>/<version>.json`). A write creates version N+1 with an exclusive
 * create, so two writers (two processes refreshing the same token) cannot both win: the loser gets `CredentialConflict` and re-reads.
 * After a write the older versions are deleted except the one before (a reader in flight still finds it); revocation deletes every
 * version that held a secret.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const CREDENTIAL_SCHEMA = 'xo.credential/1';

export type CredentialKind = 'oauth2' | 'basic' | 'api_key';
export type CredentialState = 'active' | 'revoked' | 'expired';
export type CredentialEndReason = 'revoked' | 'refresh_failed' | 'provider_revoked';

/** The secret part: only ever stored sealed, only ever handed out wrapped in `Secret`. */
export interface CredentialSecrets {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly password?: string;
  readonly apiKey?: string;
}

export interface CredentialActor {
  readonly kind: string;
  readonly id: string;
}

/** Everything about a credential that is not secret. */
export interface CredentialPublic {
  readonly credentialId: string;
  readonly tenantId: string;
  readonly kind: CredentialKind;
  /** `google`, `microsoft`, `smtp`, `imap`, … */
  readonly provider: string;
  /** What it was connected for (`message.send`, …): the scopes requested were derived from these. */
  readonly capabilities: readonly string[];
  /** Scopes the provider actually granted (OAuth); empty for basic credentials. */
  readonly scopes: readonly string[];
  /** Which account, as its owner would recognise it (an email address). Kept in the tenant's store only, never in audit. */
  readonly accountLabel?: string;
  /** `sha256:` of the provider's stable account id: continuity checks and audit, without the id itself. */
  readonly accountRef?: string;
  /** Basic credentials: the user name and the server they are for. */
  readonly username?: string;
  readonly host?: string;
  readonly state: CredentialState;
  readonly createdAt: string;
  readonly createdBy: CredentialActor;
  readonly updatedAt: string;
  /** When the current access token stops working (OAuth). */
  readonly accessExpiresAt?: string;
  readonly endedAt?: string;
  readonly endedReason?: CredentialEndReason;
  /** Bumped on every write: refresh, rotation, revocation. */
  readonly version: number;
}

interface Sealed {
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

interface StoredCredential extends CredentialPublic {
  readonly schema: typeof CREDENTIAL_SCHEMA;
  readonly sealed?: Sealed;
}

export class CredentialStoreError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'tampered' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

export const CREDENTIAL_ID = /^crd_[0-9a-f]{24}$/;
export const newCredentialId = (): string => `crd_${randomBytes(12).toString('hex')}`;
export const accountRefOf = (provider: string, accountId: string): string =>
  `sha256:${createHash('sha256').update(`${provider}\u0000${accountId}`).digest('hex')}`;

const KEY_BYTES = 32;

/** The key a tenant's credentials are sealed under. */
export function tenantKey(masterKey: Uint8Array, tenantId: string): Buffer {
  if (masterKey.length !== KEY_BYTES) throw new CredentialStoreError('invalid', `the credentials master key must be ${KEY_BYTES} bytes`);
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.from('xo-credentials/1'), Buffer.from(tenantId, 'utf8'), KEY_BYTES));
}

const aadOf = (r: Pick<StoredCredential, 'credentialId' | 'tenantId' | 'kind' | 'provider' | 'version'>): Buffer =>
  Buffer.from(JSON.stringify([CREDENTIAL_SCHEMA, r.credentialId, r.tenantId, r.kind, r.provider, r.version]), 'utf8');

function seal(key: Buffer, r: Parameters<typeof aadOf>[0], secrets: CredentialSecrets): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aadOf(r));
  const data = Buffer.concat([c.update(JSON.stringify(secrets), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function unseal(key: Buffer, r: StoredCredential): CredentialSecrets {
  if (r.sealed === undefined) return {};
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(r.sealed.iv, 'base64'));
    d.setAAD(aadOf(r));
    d.setAuthTag(Buffer.from(r.sealed.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(r.sealed.data, 'base64')), d.final()]).toString('utf8')) as CredentialSecrets;
  } catch {
    // Wrong tenant, edited record, wrong key: indistinguishable on purpose, and never a partial read.
    throw new CredentialStoreError('tampered', `credential ${r.credentialId} does not open for this tenant`);
  }
}

const pad = (v: number): string => String(v).padStart(10, '0');

export interface LoadedCredential {
  readonly record: CredentialPublic;
  readonly secrets: CredentialSecrets;
}

/** One tenant's credentials under one directory. */
export class CredentialStore {
  private readonly key: Buffer;

  constructor(
    private readonly root: string,
    readonly tenantId: string,
    masterKey: Uint8Array,
  ) {
    this.key = tenantKey(masterKey, tenantId);
  }

  private dir(id: string): string {
    if (!CREDENTIAL_ID.test(id)) throw new CredentialStoreError('not_found', `credential ${id} does not exist`);
    return join(this.root, id);
  }

  private async versions(id: string): Promise<number[]> {
    try {
      return (await readdir(this.dir(id)))
        .map((f) => /^(\d{10})\.json$/.exec(f)?.[1])
        .filter((x): x is string => x !== undefined)
        .map(Number)
        .sort((a, b) => a - b);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  private async readVersion(id: string, v: number): Promise<StoredCredential> {
    const r = JSON.parse(await readFile(join(this.dir(id), `${pad(v)}.json`), 'utf8')) as StoredCredential;
    if (r.schema !== CREDENTIAL_SCHEMA || r.credentialId !== id || r.version !== v)
      throw new CredentialStoreError('tampered', `credential ${id} version ${v} is not what it claims to be`);
    // A record moved from another tenant's store names that tenant: it is not this tenant's, whatever else it says.
    if (r.tenantId !== this.tenantId) throw new CredentialStoreError('not_found', `credential ${id} does not exist`);
    return r;
  }

  /** The current version, opened. A credential of another tenant, or one that does not open, is `not_found` / `tampered`. */
  async load(id: string): Promise<LoadedCredential> {
    let r: StoredCredential | undefined;
    // A version pruned between listing and reading (a concurrent write) is retried against the new listing.
    for (let attempt = 0; r === undefined; attempt++) {
      const last = (await this.versions(id)).at(-1);
      if (last === undefined) throw new CredentialStoreError('not_found', `credential ${id} does not exist`);
      try {
        r = await this.readVersion(id, last);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || attempt >= 3) throw e;
      }
    }
    const { schema: _s, sealed: _x, ...record } = r;
    return { record, secrets: unseal(this.key, r) };
  }

  async list(): Promise<readonly CredentialPublic[]> {
    let ids: string[];
    try {
      ids = (await readdir(this.root)).filter((f) => CREDENTIAL_ID.test(f));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const out: CredentialPublic[] = [];
    for (const id of ids.sort()) {
      try {
        out.push((await this.load(id)).record);
      } catch (e) {
        if (!(e instanceof CredentialStoreError)) throw e; // a foreign or broken record is simply not listed
      }
    }
    return out;
  }

  /**
   * Writes version `expectedVersion + 1` (0 creates). Exclusive create: a concurrent writer of the same version loses with
   * `conflict`. Returns the record as stored.
   */
  async write(
    next: Omit<CredentialPublic, 'version' | 'tenantId'>,
    secrets: CredentialSecrets | undefined,
    expectedVersion: number,
  ): Promise<CredentialPublic> {
    const id = next.credentialId;
    const dir = this.dir(id);
    const current = (await this.versions(id)).at(-1) ?? 0;
    if (current !== expectedVersion)
      throw new CredentialStoreError('conflict', `credential ${id} changed (version ${current}, expected ${expectedVersion})`);
    const version = expectedVersion + 1;
    const base = { ...next, tenantId: this.tenantId, version };
    const stored: StoredCredential = {
      schema: CREDENTIAL_SCHEMA,
      ...base,
      ...(secrets !== undefined && Object.keys(secrets).length > 0 ? { sealed: seal(this.key, base, secrets) } : {}),
    };
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.${pad(version)}.${randomBytes(4).toString('hex')}.tmp`);
    const fh = await open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(JSON.stringify(stored));
      await fh.sync();
    } finally {
      await fh.close();
    }
    // Publish with `link`: it creates the final name only if it does not exist, atomically and with the whole content, so a
    // reader never sees a partial version and two writers of the same version cannot both win.
    const final = join(dir, `${pad(version)}.json`);
    try {
      await link(tmp, final);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST')
        throw new CredentialStoreError('conflict', `credential ${id} was written by someone else (version ${version})`);
      throw e;
    } finally {
      await rm(tmp, { force: true });
    }
    const { schema: _s, sealed: _x, ...record } = stored;
    return record;
  }

  /** Deletes versions that are no longer needed: every one before `keepFrom` (a version that held a secret leaves the disk). */
  async prune(id: string, keepFrom: number): Promise<void> {
    for (const v of await this.versions(id)) if (v < keepFrom) await rm(join(this.dir(id), `${pad(v)}.json`), { force: true });
  }
}
