import {
  buildAuthorizationUrl,
  createPkce,
  discoverProvider,
  exchangeCodeForIdentity,
  failAuth,
  okAuth,
  parseCallback,
  revokeRefreshToken,
  validateRedirectUri,
  type AuthFetch,
  type AuthResult,
  type OidcConfig,
  type ProviderEndpoints,
} from './oidc';
import type { SystemBrowserLogin } from './oidcSession';

/**
 * Google sign-in → XO session, from the desktop client's side. The trust boundaries:
 *
 *   Google authenticates the user  →  the XO API verifies Google's ID token and mints an XO session
 *   →  the XO API authorizes every later request.
 *
 * Studio's part is narrow and holds no secret: it fetches a server-issued single-use challenge, sends the user to
 * Google in the SYSTEM browser (code flow + PKCE S256 + `state`, with the challenge's nonce), receives the code on the
 * loopback listener, exchanges it at Google for an ID token, hands that ID token to the XO API ONCE, and keeps only
 * what the API returns: a 15-minute access credential (memory only) and a rotating refresh credential (OS keychain).
 *
 * What it never does: decode or trust the ID token; use it, or any Google token, as an API credential; request
 * `offline_access`; persist anything Google issued; or decide who the user is. Google's access token is discarded
 * unread. If Google returns a refresh token it is revoked best-effort and never stored; sign-in does not wait for
 * or depend on that revocation (its behaviour against the real Google service is NOT verified).
 */

export interface XoSessionTokens {
  readonly accessCredential: string;
  readonly accessExpiresAt: number;
  readonly refreshCredential: string;
}

type ApiFetch = (input: string, init?: RequestInit) => Promise<Response>;

interface WireSession {
  readonly accessCredential?: unknown;
  readonly accessExpiresAt?: unknown;
  readonly refreshCredential?: unknown;
}

const ACCESS = /^xoas_[A-Za-z0-9_-]{43}$/;
const REFRESH = /^xoar_[A-Za-z0-9_-]{43}$/;
const SKEW_MS = 60_000;

function parseSession(body: unknown): AuthResult<XoSessionTokens> {
  const o = (typeof body === 'object' && body !== null ? body : {}) as WireSession;
  const expires = typeof o.accessExpiresAt === 'string' ? Date.parse(o.accessExpiresAt) : NaN;
  if (
    typeof o.accessCredential !== 'string' ||
    !ACCESS.test(o.accessCredential) ||
    typeof o.refreshCredential !== 'string' ||
    !REFRESH.test(o.refreshCredential) ||
    !Number.isFinite(expires)
  ) {
    return failAuth('malformed', 'XO returned a session Studio could not read.');
  }
  return okAuth({ accessCredential: o.accessCredential, accessExpiresAt: expires, refreshCredential: o.refreshCredential });
}

/** Minimal client for the four XO session endpoints. Maps failures into the existing sign-in failure kinds. */
export class XoAuthApi {
  private readonly base: string;
  constructor(
    baseUrl: string | undefined,
    private readonly doFetch: ApiFetch,
  ) {
    this.base = (baseUrl ?? '/api').replace(/\/$/, '');
  }

  private async post(path: string, body: unknown, bearer?: string): Promise<{ status: number; json: unknown } | undefined> {
    try {
      const res = await this.doFetch(`${this.base}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(bearer !== undefined ? { Authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify(body),
        redirect: 'error',
      });
      let json: unknown;
      try {
        json = res.status === 204 ? undefined : await res.json();
      } catch {
        json = undefined;
      }
      return { status: res.status, json };
    } catch {
      return undefined;
    }
  }

  async createChallenge(): Promise<AuthResult<{ challengeId: string; nonce: string }>> {
    const r = await this.post('/auth/login-challenge', {});
    if (r === undefined) return failAuth('network', 'Could not reach XO.');
    if (r.status === 429 || r.status >= 500) return failAuth('network', 'XO is busy or unavailable. Try again shortly.');
    const o = r.json as { challengeId?: unknown; nonce?: unknown } | undefined;
    if (r.status !== 201 || typeof o?.challengeId !== 'string' || typeof o.nonce !== 'string' || o.nonce.length === 0) {
      return failAuth('provider_error', 'XO could not start the sign-in.');
    }
    return okAuth({ challengeId: o.challengeId, nonce: o.nonce });
  }

  async exchange(challengeId: string, idToken: string): Promise<AuthResult<XoSessionTokens>> {
    const r = await this.post('/auth/session', { challengeId, idToken });
    if (r === undefined) return failAuth('network', 'Could not reach XO.');
    if (r.status === 201) return parseSession(r.json);
    const code = (r.json as { error?: { code?: unknown } } | undefined)?.error?.code;
    if (code === 'XO_AUTH_IDENTITY_UNBOUND')
      return failAuth('provider_error', 'XO did not accept this sign-in. Your administrator may not have enabled XO for this account yet.');
    if (code === 'XO_AUTH_CHALLENGE_INVALID')
      return failAuth('provider_error', 'The sign-in took too long or was already used. Please try again.');
    if (r.status === 429 || r.status >= 500) return failAuth('network', 'XO is busy or unavailable. Try again shortly.');
    return failAuth('provider_error', 'XO did not accept this sign-in.');
  }

  /** `invalid_grant` only for a permanent verdict (the credential or identity was rejected); anything transient keeps the session. */
  async refresh(refreshCredential: string): Promise<AuthResult<XoSessionTokens>> {
    const r = await this.post('/auth/refresh', { refreshCredential });
    if (r === undefined) return failAuth('network', 'Could not reach XO.');
    if (r.status === 200) return parseSession(r.json);
    if (r.status === 401) return failAuth('invalid_grant', 'Your sign-in is no longer valid.');
    if (r.status === 429 || r.status >= 500) return failAuth('network', 'XO is busy or unavailable. Try again shortly.');
    return failAuth('provider_error', 'XO did not accept the refresh.');
  }

  /** Best effort: the local credential is cleared whether or not this reaches XO. */
  async logout(accessCredential: string): Promise<void> {
    await this.post('/auth/logout', {}, accessCredential);
  }
}

export interface XoSessionDeps {
  readonly api: XoAuthApi;
  readonly now: () => number;
  /** Persist a rotated refresh credential. Must not throw into the refresh path. */
  readonly onRefreshCredential?: (refreshCredential: string) => void;
  /** XO permanently rejected the session (revoked, expired, identity unbound). */
  readonly onEnded?: () => void;
}

/**
 * The XO session as the rest of the app sees it: `getAccessToken` for the API client, `signOut`. The access credential
 * lives in memory only; refresh is single-flight; a transient failure keeps the session and the stored credential;
 * only a permanent XO verdict ends it.
 */
export class XoSession {
  private tokens: XoSessionTokens;
  private inflight: Promise<AuthResult<string>> | undefined;
  private ended = false;

  constructor(
    private readonly deps: XoSessionDeps,
    initial: XoSessionTokens,
  ) {
    this.tokens = initial;
  }

  get refreshCredential(): string {
    return this.tokens.refreshCredential;
  }

  getAccessToken = (): Promise<AuthResult<string>> => {
    if (this.ended) return Promise.resolve(failAuth('invalid_grant', 'Your session has ended. Sign in again.'));
    if (this.tokens.accessExpiresAt - SKEW_MS > this.deps.now()) return Promise.resolve(okAuth(this.tokens.accessCredential));
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  };

  private async refresh(): Promise<AuthResult<string>> {
    const r = await this.deps.api.refresh(this.tokens.refreshCredential);
    if (!r.ok) {
      if (r.failure.kind === 'invalid_grant') {
        this.ended = true;
        this.deps.onEnded?.();
      }
      return r;
    }
    this.tokens = r.value;
    this.deps.onRefreshCredential?.(r.value.refreshCredential);
    return okAuth(r.value.accessCredential);
  }

  /** Marks the session ended locally first, then asks XO to revoke it (failure ignored). */
  async signOut(): Promise<void> {
    this.ended = true;
    await this.deps.api.logout(this.tokens.accessCredential);
  }
}

export interface GoogleSignInDeps {
  readonly config: OidcConfig;
  /** Fetch used for Google (discovery, token exchange, revocation). */
  readonly authFetch: AuthFetch;
  readonly api: XoAuthApi;
  readonly login: SystemBrowserLogin;
  readonly now: () => number;
  readonly crypto?: Crypto;
}

/** Full interactive sign-in. Returns XO session tokens only; nothing Google issued survives this function. */
export async function signInWithGoogle(d: GoogleSignInDeps): Promise<AuthResult<XoSessionTokens>> {
  const disc: AuthResult<ProviderEndpoints> = await discoverProvider(d.config, d.authFetch);
  if (!disc.ok) return disc;

  const challenge = await d.api.createChallenge();
  if (!challenge.ok) return challenge;

  let redirectUri: string;
  try {
    redirectUri = (await d.login.begin()).redirectUri;
  } catch {
    return failAuth('config', 'This device could not start a sign-in listener.');
  }
  const ru = validateRedirectUri(redirectUri);
  if (!ru.ok) return ru;

  const pkce = await createPkce(d.crypto);
  const url = buildAuthorizationUrl(disc.value, d.config, redirectUri, pkce, challenge.value.nonce);
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

  const grant = await exchangeCodeForIdentity(
    disc.value,
    d.config,
    { code: cb.value.code, verifier: pkce.verifier, redirectUri },
    d.authFetch,
  );
  if (!grant.ok) return grant;
  // Google may return a refresh token for an installed app. XO does not want it: revoke it best-effort, in the background, and never wait on it.
  if (grant.value.refreshToken !== undefined)
    void revokeRefreshToken(disc.value, d.config, grant.value.refreshToken, d.authFetch).catch(() => undefined);

  return d.api.exchange(challenge.value.challengeId, grant.value.idToken);
}

/** Restore from a stored XO refresh credential. The caller decides what to keep from the failure kind. */
export async function restoreXoSession(deps: XoSessionDeps, refreshCredential: string): Promise<AuthResult<XoSession>> {
  const r = await deps.api.refresh(refreshCredential);
  if (!r.ok) return r;
  deps.onRefreshCredential?.(r.value.refreshCredential);
  return okAuth(new XoSession(deps, r.value));
}
