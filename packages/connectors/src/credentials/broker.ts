/**
 * UW-9 (ADR 0036) — the credential broker: the only way code gets a credential, and only for the call it makes.
 *
 * There is no `get`. `use(credentialId, need, fn)` checks the credential belongs to this tenant, is active, and was granted every
 * scope the use needs (least privilege at use, not only at consent); refreshes an OAuth access token that is about to expire;
 * then hands `fn` the secret wrapped in `Secret`, for that call. A refresh is single-flight in a process and compare-and-swap across
 * processes (the store's versioned writes), so a rotating refresh token is redeemed once. A refresh the provider refuses
 * (`invalid_grant`: revoked or expired at the provider) ends the credential as `expired` with the reason recorded, and nothing
 * uses it again until someone reconnects.
 */
import type { CredentialStore } from './store.js';
import {
  accountRefOf,
  CredentialStoreError,
  newCredentialId,
  type CredentialActor,
  type CredentialKind,
  type CredentialPublic,
  type CredentialSecrets,
} from './store.js';
import {
  OAuthError,
  OAUTH_PROVIDERS,
  refreshTokens,
  revokeAtProvider,
  type OAuthClientConfig,
  type OAuthDeps,
  type TokenSet,
} from './oauth.js';
import { Secret } from './secret.js';

const REFRESH_SKEW_MS = 120_000;

export type CredentialErrorCode = 'not_found' | 'not_active' | 'scope_insufficient' | 'kind_mismatch' | 'refresh_failed' | 'unavailable';

export class CredentialError extends Error {
  constructor(
    readonly code: CredentialErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface CredentialNeed {
  /** Every scope the use needs (compared after the provider's normalisation). */
  readonly scopes?: readonly string[];
  readonly kind?: CredentialKind;
  /** Short, non-secret description for the audit trail: `connector:email.send`. */
  readonly purpose: string;
}

/** What `fn` receives: the secrets this credential has, each wrapped. */
export interface CredentialHandle {
  readonly record: CredentialPublic;
  readonly accessToken?: Secret;
  readonly password?: Secret;
  readonly apiKey?: Secret;
}

export interface CredentialEvent {
  readonly type:
    | 'credential.created'
    | 'credential.refreshed'
    | 'credential.refresh_failed'
    | 'credential.revoked'
    | 'credential.rotated'
    | 'credential.use_denied';
  readonly credentialId: string;
  readonly provider: string;
  readonly actor?: CredentialActor;
  readonly reason?: string;
  readonly accountRef?: string;
}

export interface BrokerOptions {
  readonly store: CredentialStore;
  /** OAuth client configuration per provider id. A provider without one cannot be refreshed or revoked here. */
  readonly clients: Readonly<Record<string, OAuthClientConfig | undefined>>;
  readonly oauth?: OAuthDeps;
  readonly now?: () => Date;
  /** Records what happened. Never given a secret. */
  readonly onEvent?: (e: CredentialEvent) => Promise<void> | void;
}

const SYSTEM: CredentialActor = { kind: 'system', id: 'credential-broker' };

export class CredentialBroker {
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly now: () => Date;

  constructor(private readonly o: BrokerOptions) {
    this.now = o.now ?? (() => new Date());
  }

  get tenantId(): string {
    return this.o.store.tenantId;
  }

  list(): Promise<readonly CredentialPublic[]> {
    return this.o.store.list();
  }

  async describe(credentialId: string): Promise<CredentialPublic> {
    return (await this.load(credentialId)).record;
  }

  private async load(id: string): ReturnType<CredentialStore['load']> {
    try {
      return await this.o.store.load(id);
    } catch (e) {
      // Another tenant's credential, a tampered one and a missing one look the same from here.
      if (e instanceof CredentialStoreError) throw new CredentialError('not_found', `credential ${id} does not exist`);
      throw e;
    }
  }

  private emit(e: CredentialEvent): Promise<void> {
    return Promise.resolve(this.o.onEvent?.(e)).catch(() => undefined);
  }

  /** Stores the tokens of a completed consent (the scopes already checked by the caller against what was asked for). */
  async storeOAuth(a: {
    readonly provider: 'google' | 'microsoft';
    readonly capabilities: readonly string[];
    readonly scopes: readonly string[];
    readonly account: { readonly id: string; readonly label?: string };
    readonly tokens: TokenSet;
    readonly by: CredentialActor;
  }): Promise<CredentialPublic> {
    if (a.tokens.refreshToken === undefined)
      throw new CredentialError(
        'unavailable',
        'the provider returned no refresh token, so the connection would stop working within the hour',
      );
    const now = this.now();
    const record = await this.o.store.write(
      {
        credentialId: newCredentialId(),
        kind: 'oauth2',
        provider: a.provider,
        capabilities: [...a.capabilities].sort(),
        scopes: [...a.scopes].sort(),
        ...(a.account.label !== undefined ? { accountLabel: a.account.label } : {}),
        accountRef: accountRefOf(a.provider, a.account.id),
        state: 'active',
        createdAt: now.toISOString(),
        createdBy: a.by,
        updatedAt: now.toISOString(),
        accessExpiresAt: new Date(now.getTime() + a.tokens.expiresInSec * 1000).toISOString(),
      },
      { accessToken: a.tokens.accessToken, refreshToken: a.tokens.refreshToken },
      0,
    );
    await this.emit({
      type: 'credential.created',
      credentialId: record.credentialId,
      provider: a.provider,
      actor: a.by,
      ...(record.accountRef !== undefined ? { accountRef: record.accountRef } : {}),
    });
    return record;
  }

  /** A user name and an app password (or API key) for a server that does not offer OAuth (SMTP/IMAP tiers 2 and 3). */
  async storeBasic(a: {
    readonly provider: string;
    readonly capabilities: readonly string[];
    readonly username: string;
    readonly host: string;
    readonly password: string;
    readonly label?: string;
    readonly by: CredentialActor;
  }): Promise<CredentialPublic> {
    if (a.password === '') throw new CredentialError('unavailable', 'a password is required');
    const now = this.now().toISOString();
    const record = await this.o.store.write(
      {
        credentialId: newCredentialId(),
        kind: 'basic',
        provider: a.provider,
        capabilities: [...a.capabilities].sort(),
        scopes: [],
        username: a.username,
        host: a.host,
        ...(a.label !== undefined ? { accountLabel: a.label } : {}),
        accountRef: accountRefOf(a.provider, `${a.username}@${a.host}`),
        state: 'active',
        createdAt: now,
        createdBy: a.by,
        updatedAt: now,
      },
      { password: a.password },
      0,
    );
    await this.emit({ type: 'credential.created', credentialId: record.credentialId, provider: a.provider, actor: a.by });
    return record;
  }

  /** Replaces a basic credential's password. The old one is deleted from disk once the new one is written. */
  async rotateBasic(credentialId: string, password: string, by: CredentialActor): Promise<CredentialPublic> {
    const { record } = await this.load(credentialId);
    if (record.kind !== 'basic')
      throw new CredentialError('kind_mismatch', 'only a password credential is rotated this way; reconnect an OAuth one');
    if (record.state !== 'active') throw new CredentialError('not_active', `credential ${credentialId} is ${record.state}`);
    if (password === '') throw new CredentialError('unavailable', 'a password is required');
    const next = await this.o.store.write({ ...record, updatedAt: this.now().toISOString() }, { password }, record.version);
    await this.o.store.prune(credentialId, next.version);
    await this.emit({ type: 'credential.rotated', credentialId, provider: record.provider, actor: by });
    return next;
  }

  /**
   * Revokes: at the provider when it has an endpoint for it, and always here — every stored version that held a secret is deleted
   * and the credential is `revoked`. Revocation only ever reduces authority, so a provider that cannot be reached does not stop it.
   */
  async revoke(
    credentialId: string,
    by: CredentialActor,
  ): Promise<{
    readonly credential: CredentialPublic;
    readonly providerRevocation: 'performed' | 'not_available' | 'failed' | 'not_applicable';
  }> {
    const { record, secrets } = await this.load(credentialId);
    let providerRevocation: 'performed' | 'not_available' | 'failed' | 'not_applicable' = 'not_applicable';
    if (record.kind === 'oauth2' && record.state === 'active') {
      const p = OAUTH_PROVIDERS[record.provider as 'google' | 'microsoft'];
      const token = secrets.refreshToken ?? secrets.accessToken;
      providerRevocation = p === undefined || token === undefined ? 'not_available' : await revokeAtProvider(p, token, this.o.oauth);
    }
    const now = this.now().toISOString();
    const next =
      record.state === 'revoked'
        ? record
        : await this.o.store.write(
            { ...record, state: 'revoked', updatedAt: now, endedAt: now, endedReason: 'revoked' },
            undefined,
            record.version,
          );
    await this.o.store.prune(credentialId, next.version);
    await this.emit({ type: 'credential.revoked', credentialId, provider: record.provider, actor: by, reason: providerRevocation });
    return { credential: next, providerRevocation };
  }

  /** The one way to use a credential. */
  async use<T>(credentialId: string, need: CredentialNeed, fn: (h: CredentialHandle) => Promise<T>): Promise<T> {
    let { record, secrets } = await this.load(credentialId);
    const deny = async (code: CredentialErrorCode, why: string): Promise<never> => {
      await this.emit({ type: 'credential.use_denied', credentialId, provider: record.provider, reason: `${code}: ${need.purpose}` });
      throw new CredentialError(code, why);
    };
    if (record.state !== 'active')
      return deny(
        'not_active',
        `credential ${credentialId} is ${record.state}${record.endedReason !== undefined ? ` (${record.endedReason.replace('_', ' ')})` : ''}; reconnect it`,
      );
    if (need.kind !== undefined && record.kind !== need.kind)
      return deny('kind_mismatch', `credential ${credentialId} is ${record.kind}, not ${need.kind}`);
    const norm = (s: string): string => (OAUTH_PROVIDERS[record.provider as 'google' | 'microsoft']?.normalizeScope(s) ?? s).toLowerCase();
    const granted = new Set(record.scopes.map(norm));
    const missing = (need.scopes ?? []).filter((s) => !granted.has(norm(s)));
    if (missing.length > 0) return deny('scope_insufficient', `credential ${credentialId} was not granted ${missing.join(', ')}`);

    if (
      record.kind === 'oauth2' &&
      (record.accessExpiresAt === undefined || Date.parse(record.accessExpiresAt) - this.now().getTime() < REFRESH_SKEW_MS)
    ) {
      try {
        await this.refresh(credentialId);
      } catch (e) {
        // The provider is unreachable: a token that has not expired yet still works; one that has does not.
        if (!(
          e instanceof CredentialError &&
          e.code === 'unavailable' &&
          record.accessExpiresAt !== undefined &&
          Date.parse(record.accessExpiresAt) > this.now().getTime()
        ))
          throw e;
      }
      ({ record, secrets } = await this.load(credentialId));
      if (record.state !== 'active') return deny('refresh_failed', `credential ${credentialId} could not be refreshed; reconnect it`);
    }
    return fn({
      record,
      ...(secrets.accessToken !== undefined ? { accessToken: new Secret(secrets.accessToken) } : {}),
      ...(secrets.password !== undefined ? { password: new Secret(secrets.password) } : {}),
      ...(secrets.apiKey !== undefined ? { apiKey: new Secret(secrets.apiKey) } : {}),
    });
  }

  /** Refreshes now (single-flight per credential in this process; compare-and-swap with other processes). */
  refresh(credentialId: string): Promise<void> {
    let flight = this.refreshing.get(credentialId);
    if (flight === undefined) {
      flight = this.refreshOnce(credentialId).finally(() => this.refreshing.delete(credentialId));
      this.refreshing.set(credentialId, flight);
    }
    return flight;
  }

  private async refreshOnce(credentialId: string): Promise<void> {
    const { record, secrets } = await this.load(credentialId);
    if (record.kind !== 'oauth2' || record.state !== 'active') return;
    const p = OAUTH_PROVIDERS[record.provider as 'google' | 'microsoft'];
    const client = this.o.clients[record.provider];
    if (p === undefined || client === undefined)
      throw new CredentialError('unavailable', `no OAuth client is configured for ${record.provider}`);
    if (secrets.refreshToken === undefined) return this.end(record, 'refresh_failed', 'no refresh token');
    let t: TokenSet;
    try {
      t = await refreshTokens(p, client, secrets.refreshToken, record.scopes, this.o.oauth);
    } catch (e) {
      if (e instanceof OAuthError && e.code === 'invalid_grant')
        return this.end(record, 'refresh_failed', 'the provider no longer honours the grant');
      throw new CredentialError('unavailable', e instanceof Error ? e.message : 'refresh failed');
    }
    // A refreshed grant may never be broader than the stored one.
    if (t.scopes !== undefined) {
      const had = new Set(record.scopes.map((s) => p.normalizeScope(s).toLowerCase()));
      const implicit = new Set(p.implicitScopes.map((s) => s.toLowerCase()));
      const wider = t.scopes.map((s) => p.normalizeScope(s).toLowerCase()).filter((s) => !had.has(s) && !implicit.has(s));
      if (wider.length > 0) return this.end(record, 'refresh_failed', `the provider widened the grant (${wider.join(', ')})`);
    }
    const now = this.now();
    try {
      const next = await this.o.store.write(
        { ...record, updatedAt: now.toISOString(), accessExpiresAt: new Date(now.getTime() + t.expiresInSec * 1000).toISOString() },
        // Rotation: a new refresh token replaces the old one; a provider that does not rotate keeps the old one valid.
        { accessToken: t.accessToken, refreshToken: t.refreshToken ?? secrets.refreshToken },
        record.version,
      );
      // The rotated-out refresh token leaves the disk now.
      await this.o.store.prune(credentialId, next.version);
    } catch (e) {
      // Another process refreshed first: its tokens are the current ones.
      if (e instanceof CredentialStoreError && e.code === 'conflict') return;
      throw e;
    }
    await this.emit({ type: 'credential.refreshed', credentialId, provider: record.provider, actor: SYSTEM });
  }

  private async end(record: CredentialPublic, reason: 'refresh_failed', detail: string): Promise<void> {
    const now = this.now().toISOString();
    try {
      const next = await this.o.store.write(
        { ...record, state: 'expired', updatedAt: now, endedAt: now, endedReason: reason },
        undefined,
        record.version,
      );
      await this.o.store.prune(record.credentialId, next.version);
    } catch (e) {
      if (!(e instanceof CredentialStoreError && e.code === 'conflict')) throw e;
      return;
    }
    await this.emit({
      type: 'credential.refresh_failed',
      credentialId: record.credentialId,
      provider: record.provider,
      actor: SYSTEM,
      reason: detail,
    });
  }
}

export type { CredentialSecrets };
