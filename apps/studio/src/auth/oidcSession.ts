import {
  createPkce,
  buildAuthorizationUrl,
  discoverProvider,
  exchangeCode,
  failAuth,
  okAuth,
  parseCallback,
  refreshTokens,
  revokeRefreshToken,
  validateRedirectUri,
  type AuthFetch,
  type AuthResult,
  type OidcConfig,
  type ProviderEndpoints,
  type TokenSet,
} from './oidc';

/** How a shell lets the user authenticate in the SYSTEM browser and returns the callback. */
export interface SystemBrowserLogin {
  /** Prepare a one-shot loopback listener; resolves with the redirect URI to register/use. */
  begin(): Promise<{ readonly redirectUri: string }>;
  openBrowser(url: string): Promise<void>;
  /** Resolves with the callback's raw query string; rejects on timeout/cancel. */
  awaitCallback(): Promise<string>;
}

export interface SessionDeps {
  readonly config: OidcConfig;
  readonly endpoints: ProviderEndpoints;
  readonly fetch: AuthFetch;
  readonly now: () => number;
  /** Persist a rotated refresh token. Must not throw into the refresh path. */
  readonly onRefreshToken?: (refreshToken: string) => void;
  /** The provider permanently rejected the session (revoked/expired refresh). */
  readonly onEnded?: () => void;
}

const SKEW_MS = 60_000;

/**
 * Access token lives in memory only. Refresh is single-flight. A transient failure keeps the
 * session (and the stored refresh token); only a permanent provider rejection ends it.
 */
export class OidcSession {
  private tokens: TokenSet;
  private inflight: Promise<AuthResult<string>> | undefined;
  private ended = false;

  constructor(
    private readonly deps: SessionDeps,
    initial: TokenSet,
  ) {
    this.tokens = initial;
  }

  get refreshToken(): string | undefined {
    return this.tokens.refreshToken;
  }

  getAccessToken = (): Promise<AuthResult<string>> => {
    if (this.ended) return Promise.resolve(failAuth('invalid_grant', 'Your session has ended. Sign in again.'));
    if (this.tokens.expiresAt - SKEW_MS > this.deps.now()) return Promise.resolve(okAuth(this.tokens.accessToken));
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  };

  private async refresh(): Promise<AuthResult<string>> {
    const rt = this.tokens.refreshToken;
    if (rt === undefined) return this.end('Your session expired. Sign in again.');
    const r = await refreshTokens(this.deps.endpoints, this.deps.config, rt, this.deps.fetch, this.deps.now());
    if (!r.ok) {
      if (r.failure.kind === 'invalid_grant') return this.end(r.failure.message);
      return r; // network / provider_error / malformed: nothing was decided, keep everything
    }
    this.tokens = r.value;
    if (r.value.refreshToken !== undefined && r.value.refreshToken !== rt) this.deps.onRefreshToken?.(r.value.refreshToken);
    return okAuth(r.value.accessToken);
  }

  private end(message: string): AuthResult<string> {
    this.ended = true;
    this.deps.onEnded?.();
    return failAuth('invalid_grant', message);
  }

  async signOut(): Promise<void> {
    const rt = this.tokens.refreshToken;
    this.ended = true;
    if (rt !== undefined) await revokeRefreshToken(this.deps.endpoints, this.deps.config, rt, this.deps.fetch);
  }
}

export interface SignInDeps {
  readonly config: OidcConfig;
  readonly fetch: AuthFetch;
  readonly login: SystemBrowserLogin;
  readonly now: () => number;
  readonly crypto?: Crypto;
}

/** Full interactive login: discovery → PKCE → system browser → validated callback → code exchange. */
export async function signInWithSystemBrowser(d: SignInDeps): Promise<AuthResult<{ tokens: TokenSet; endpoints: ProviderEndpoints }>> {
  const disc = await discoverProvider(d.config, d.fetch);
  if (!disc.ok) return disc;

  let redirectUri: string;
  try {
    redirectUri = (await d.login.begin()).redirectUri;
  } catch {
    return failAuth('config', 'This device could not start a sign-in listener.');
  }
  const ru = validateRedirectUri(redirectUri);
  if (!ru.ok) return ru;

  const pkce = await createPkce(d.crypto);
  const url = buildAuthorizationUrl(disc.value, d.config, redirectUri, pkce);
  try {
    await d.login.openBrowser(url);
  } catch {
    return failAuth('config', 'The system browser could not be opened.');
  }

  let query: string;
  try {
    query = await d.login.awaitCallback();
  } catch {
    return failAuth('cancelled', 'Sign-in was not completed.');
  }
  const cb = parseCallback(query, pkce.state);
  if (!cb.ok) return cb;

  const t = await exchangeCode(disc.value, d.config, { code: cb.value.code, verifier: pkce.verifier, redirectUri }, d.fetch, d.now());
  return t.ok ? okAuth({ tokens: t.value, endpoints: disc.value }) : t;
}

/** Restore from a stored refresh token. Nothing is persisted or discarded here; the caller decides from the failure kind. */
export async function restoreFromRefreshToken(d: Omit<SessionDeps, 'endpoints'>, refreshToken: string): Promise<AuthResult<OidcSession>> {
  const disc = await discoverProvider(d.config, d.fetch);
  if (!disc.ok) return disc;
  const t = await refreshTokens(disc.value, d.config, refreshToken, d.fetch, d.now());
  if (!t.ok) return t;
  const deps: SessionDeps = { ...d, endpoints: disc.value };
  if (t.value.refreshToken !== undefined && t.value.refreshToken !== refreshToken) d.onRefreshToken?.(t.value.refreshToken);
  return okAuth(new OidcSession(deps, t.value));
}
