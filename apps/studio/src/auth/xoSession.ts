import {
  buildAuthorizationUrl,
  createPkce,
  discoverProvider,
  failAuth,
  okAuth,
  parseCallback,
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
 * loopback listener, and hands the CODE and its PKCE verifier to the XO API. The API, which alone holds the OAuth client
 * secret Google requires, redeems the code at Google, verifies the ID token against this attempt's nonce, and returns
 * what Studio keeps: a 15-minute access credential (memory only) and a rotating refresh credential (OS keychain).
 *
 * What it never does: hold or send a client secret; talk to Google's token or revocation endpoints; see, decode or
 * trust any Google token; request `offline_access`; persist anything Google issued; or decide who the user is. The
 * only Google endpoint it fetches is OIDC discovery, to find the page it opens in the browser.
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

  /** Legacy/other-IdP path: the caller already holds an ID token. */
  async exchange(challengeId: string, idToken: string): Promise<AuthResult<XoSessionTokens>> {
    return this.sessionResult(await this.post('/auth/session', { challengeId, idToken }), false);
  }

  /** Google path: the API redeems the authorization code (it holds the client secret) and returns the XO session. */
  async exchangeCode(challengeId: string, code: string, codeVerifier: string, redirectUri: string): Promise<AuthResult<XoSessionTokens>> {
    return this.sessionResult(await this.post('/auth/session', { challengeId, code, codeVerifier, redirectUri }), true);
  }

  private sessionResult(r: { status: number; json: unknown } | undefined, explainRefusal: boolean): AuthResult<XoSessionTokens> {
    if (r === undefined) return failAuth('network', 'Could not reach XO.');
    if (r.status === 201) return parseSession(r.json);
    const e = (r.json as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
    const code = e?.code;
    if (code === 'XO_AUTH_IDENTITY_UNBOUND')
      return failAuth('provider_error', 'XO did not accept this sign-in. Your administrator may not have enabled XO for this account yet.');
    if (code === 'XO_AUTH_CHALLENGE_INVALID')
      return failAuth('provider_error', 'The sign-in took too long or was already used. Please try again.');
    // 501 is a permanent "not configured on this server", not a transient outage: say so before the generic 5xx rule.
    if (explainRefusal && r.status === 501)
      return failAuth('provider_error', 'This XO server is not set up for desktop Google sign-in yet. Ask your administrator.');
    if (r.status === 429 || r.status >= 500) return failAuth('network', 'XO is busy or unavailable. Try again shortly.');
    if (explainRefusal) {
      // The API's own fixed, non-secret sentence (for example that Google refused the sign-in, with Google's error code).
      const m = e?.message;
      if (code === 'XO_AUTH_TOKEN_INVALID' && typeof m === 'string' && /^[\x20-\x7e]{1,200}$/.test(m))
        return failAuth('provider_error', `XO could not complete the Google sign-in: ${m}.`);
    }
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
  /** Fetch used for Google OIDC discovery (the only Google endpoint Studio itself calls). */
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

  // Studio never redeems the code itself: Google requires a client secret for that, and a distributed app cannot hold one.
  return d.api.exchangeCode(challenge.value.challengeId, cb.value.code, pkce.verifier, redirectUri);
}

/** Restore from a stored XO refresh credential. The caller decides what to keep from the failure kind. */
export async function restoreXoSession(deps: XoSessionDeps, refreshCredential: string): Promise<AuthResult<XoSession>> {
  const r = await deps.api.refresh(refreshCredential);
  if (!r.ok) return r;
  deps.onRefreshCredential?.(r.value.refreshCredential);
  return okAuth(new XoSession(deps, r.value));
}
