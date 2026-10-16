/**
 * Provider-neutral OIDC Authorization Code + PKCE client logic for a PUBLIC client.
 *
 * Trust model (see docs/studio/AUTH_API_CONTRACT.md):
 *  - Studio holds no client secret and makes no identity decision. The XO API verifies the
 *    access token and derives the principal. On the generic path the ID token is never used or retained here.
 *    On the Google path (xoSession.ts) the ID token is carried ONCE to the XO API, which verifies it; Studio
 *    never decodes or trusts it, and it is never used as an API credential.
 *  - Studio only guarantees what a public client can: PKCE (S256), state binding of the
 *    callback to this attempt, strict issuer/endpoint validation, and safe token handling.
 *  - Nothing here touches storage, the DOM, or Tauri. Everything is injectable.
 */

export type AuthFailureKind =
  | 'config' //          invalid local configuration
  | 'discovery' //       provider metadata missing or untrustworthy
  | 'state_mismatch' //  callback not bound to this attempt
  | 'provider_error' //  provider refused (access_denied, ...)
  | 'invalid_grant' //   refresh/code permanently rejected: the session is over
  | 'network' //         transient: nothing was decided, keep credentials
  | 'cancelled' //       user closed/timed out the browser step
  | 'malformed'; //      response not what the protocol promises

export interface AuthFailure {
  readonly kind: AuthFailureKind;
  readonly message: string;
}
export type AuthResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: AuthFailure };
export const okAuth = <T>(value: T): AuthResult<T> => ({ ok: true, value });
export const failAuth = (kind: AuthFailureKind, message: string): AuthResult<never> => ({ ok: false, failure: { kind, message } });

export type AuthFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface OidcConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly audience?: string;
  /**
   * `google`: sign in with Google, then exchange the verified identity for an XO session (see xoSession.ts). Google
   * access tokens are opaque to XO and are never sent to the XO API. Absent: the generic provider-JWT path, unchanged.
   */
  readonly provider?: 'google';
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** https everywhere; plain http only for loopback (local dev IdP / RFC 8252 redirect). */
export function isSecureOrLoopbackUrl(u: URL): boolean {
  if (u.username !== '' || u.password !== '') return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && LOOPBACK.has(u.hostname);
}

export function parseOidcConfig(raw: unknown): AuthResult<OidcConfig> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return failAuth('config', 'OIDC settings must be an object.');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (/secret/i.test(k)) return failAuth('config', 'Studio is a public client: a client secret must never be configured here.');
  }
  const allowed = new Set(['issuer', 'clientId', 'scopes', 'audience', 'provider']);
  for (const k of Object.keys(o)) if (!allowed.has(k)) return failAuth('config', `Unknown OIDC setting "${k}".`);

  if (typeof o['issuer'] !== 'string') return failAuth('config', 'OIDC issuer is missing.');
  let issuer: URL;
  try {
    issuer = new URL(o['issuer']);
  } catch {
    return failAuth('config', 'OIDC issuer is not a valid URL.');
  }
  if (!isSecureOrLoopbackUrl(issuer)) return failAuth('config', 'OIDC issuer must be an https URL without embedded credentials.');
  if (issuer.search !== '' || issuer.hash !== '') return failAuth('config', 'OIDC issuer must not contain a query or fragment.');

  const clientId = o['clientId'];
  if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > 256 || /\s/.test(clientId)) {
    return failAuth('config', 'OIDC clientId is missing or invalid.');
  }
  // Google's own issuer always means the Google path: its access tokens are opaque to XO, so the generic provider-JWT
  // path cannot work with it, and the native launcher passes only issuer/clientId (it has no provider setting).
  const provider = o['provider'] ?? (o['issuer'] === 'https://accounts.google.com' ? 'google' : undefined);
  if (provider !== undefined && provider !== 'google') return failAuth('config', 'OIDC provider must be \"google\" or omitted.');
  let scopes: string[] = provider === 'google' ? ['openid'] : ['openid', 'offline_access'];
  if (o['scopes'] !== undefined) {
    if (!Array.isArray(o['scopes']) || o['scopes'].some((s) => typeof s !== 'string' || s.length === 0 || /\s/.test(s))) {
      return failAuth('config', 'OIDC scopes must be a list of scope names.');
    }
    scopes = o['scopes'] as string[];
  }
  if (!scopes.includes('openid')) return failAuth('config', 'OIDC scopes must include "openid".');
  if (o['audience'] !== undefined && (typeof o['audience'] !== 'string' || o['audience'].length === 0 || /\s/.test(o['audience']))) {
    return failAuth('config', 'OIDC audience is invalid.');
  }
  if (provider === 'google') {
    // Google signs the user in; XO issues its own session. Nothing here may ask Google for more than identity.
    if (o['audience'] !== undefined) return failAuth('config', 'The Google provider takes no audience setting.');
    if (scopes.includes('offline_access'))
      return failAuth('config', 'The Google provider must not request offline_access: XO keeps the session, not Google.');
  }
  return okAuth({
    // The issuer string is compared byte-for-byte with the provider's own claim, so it is kept exactly as configured.
    issuer: o['issuer'],
    clientId,
    scopes,
    ...(typeof o['audience'] === 'string' ? { audience: o['audience'] } : {}),
    ...(provider === 'google' ? { provider: 'google' as const } : {}),
  });
}

export interface ProviderEndpoints {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
}

function endpoint(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  try {
    const u = new URL(v);
    return isSecureOrLoopbackUrl(u) && u.hash === '' ? v : undefined;
  } catch {
    return undefined;
  }
}

export async function discoverProvider(config: OidcConfig, doFetch: AuthFetch): Promise<AuthResult<ProviderEndpoints>> {
  const url = `${config.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  let res: Response;
  try {
    res = await doFetch(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error' });
  } catch {
    return failAuth('network', 'Could not reach the identity provider.');
  }
  if (res.status >= 500) return failAuth('network', 'The identity provider is unavailable.');
  if (!res.ok) return failAuth('discovery', 'The identity provider did not publish its configuration.');
  let doc: unknown;
  try {
    doc = await res.json();
  } catch {
    return failAuth('discovery', 'The identity provider returned unreadable configuration.');
  }
  if (typeof doc !== 'object' || doc === null) return failAuth('discovery', 'The identity provider returned unreadable configuration.');
  const d = doc as Record<string, unknown>;
  if (d['issuer'] !== config.issuer) {
    return failAuth('discovery', 'The identity provider reported a different issuer than the one configured. Sign-in was stopped.');
  }
  const authorizationEndpoint = endpoint(d['authorization_endpoint']);
  const tokenEndpoint = endpoint(d['token_endpoint']);
  if (authorizationEndpoint === undefined || tokenEndpoint === undefined) {
    return failAuth('discovery', 'The identity provider did not publish secure authorization and token endpoints.');
  }
  const methods = d['code_challenge_methods_supported'];
  if (methods !== undefined && !(Array.isArray(methods) && methods.includes('S256'))) {
    return failAuth('discovery', 'The identity provider does not support PKCE (S256).');
  }
  const types = d['response_types_supported'];
  if (types !== undefined && !(Array.isArray(types) && types.includes('code'))) {
    return failAuth('discovery', 'The identity provider does not support the authorization code flow.');
  }
  const revocationEndpoint = endpoint(d['revocation_endpoint']);
  return okAuth({ authorizationEndpoint, tokenEndpoint, ...(revocationEndpoint !== undefined ? { revocationEndpoint } : {}) });
}

// ---- PKCE / state

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
  readonly state: string;
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomToken(c: Crypto, bytes: number): string {
  const a = new Uint8Array(bytes);
  c.getRandomValues(a);
  return b64url(a);
}

// No `nonce` is sent. A nonce only binds an ID token to a login, and Studio never reads the ID
// token. Some providers copy the request nonce into the ACCESS token as well, and the API
// refuses any access token carrying a `nonce` (that is how it tells an ID token from an access
// token), so sending one would make such a provider's tokens unusable for no security benefit.
// The code flow's integrity comes from PKCE (S256) and `state`.
export async function createPkce(c: Crypto = globalThis.crypto): Promise<Pkce> {
  const verifier = randomToken(c, 64); // 86 chars, within RFC 7636's 43..128
  const digest = await c.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)), state: randomToken(c, 32) };
}

/** Redirect must be a loopback http URL (RFC 8252) or https; never a bare custom value. */
export function validateRedirectUri(raw: string): AuthResult<string> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return failAuth('config', 'The sign-in redirect address is invalid.');
  }
  if (!isSecureOrLoopbackUrl(u) || u.hash !== '' || u.search !== '')
    return failAuth('config', 'The sign-in redirect address is not allowed.');
  return okAuth(raw);
}

export function buildAuthorizationUrl(
  endpoints: ProviderEndpoints,
  config: OidcConfig,
  redirectUri: string,
  p: Pkce,
  nonce?: string,
): string {
  const u = new URL(endpoints.authorizationEndpoint);
  const q = u.searchParams;
  q.set('response_type', 'code');
  q.set('client_id', config.clientId);
  q.set('redirect_uri', redirectUri);
  q.set('scope', config.scopes.join(' '));
  q.set('state', p.state);
  q.set('code_challenge', p.challenge);
  q.set('code_challenge_method', 'S256');
  if (config.audience !== undefined) q.set('audience', config.audience);
  // A nonce is sent only when the caller has a server-issued one to verify later (the Google path). Never invented here.
  if (nonce !== undefined) q.set('nonce', nonce);
  return u.toString();
}

/**
 * A callback is untrusted input until it matches the state of the attempt in progress.
 * Anything token-shaped in it (implicit-flow downgrade) is refused outright.
 */
export function parseCallback(query: string, expectedState: string): AuthResult<{ code: string }> {
  if (query.length > 4096) return failAuth('malformed', 'The sign-in response was too large.');
  const p = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  for (const forbidden of ['access_token', 'id_token', 'refresh_token', 'token']) {
    if (p.has(forbidden)) return failAuth('malformed', 'The sign-in response contained unexpected credentials and was ignored.');
  }
  const state = p.get('state');
  if (state === null || !constantTimeEqual(state, expectedState)) {
    return failAuth('state_mismatch', 'The sign-in response did not match this sign-in attempt and was ignored.');
  }
  const err = p.get('error');
  if (err !== null) {
    // Only a protocol error code is echoed, never provider-supplied free text.
    const code = /^[a-z_]{1,40}$/.test(err) ? err : 'error';
    return failAuth(
      'provider_error',
      code === 'access_denied' ? 'Sign-in was declined.' : `The identity provider refused sign-in (${code}).`,
    );
  }
  const code = p.get('code');
  if (code === null || code.length === 0 || code.length > 2048)
    return failAuth('malformed', 'The sign-in response had no authorization code.');
  return okAuth({ code });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---- token endpoint

export interface TokenSet {
  readonly accessToken: string;
  /** epoch ms */
  readonly expiresAt: number;
  readonly refreshToken?: string;
}

async function postToken(
  endpoints: ProviderEndpoints,
  body: URLSearchParams,
  doFetch: AuthFetch,
): Promise<AuthResult<Record<string, unknown>>> {
  let res: Response;
  try {
    res = await doFetch(endpoints.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      redirect: 'error',
    });
  } catch {
    return failAuth('network', 'Could not reach the identity provider.');
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  const obj = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : undefined;
  if (res.ok) {
    return obj === undefined ? failAuth('malformed', 'The identity provider returned an unreadable response.') : okAuth(obj);
  }
  if (res.status >= 500 || res.status === 429 || res.status === 408)
    return failAuth('network', 'The identity provider is temporarily unavailable.');
  // Permanent rejection of a grant: only the protocol's invalid_grant (or a 401 from the token endpoint).
  if (obj?.['error'] === 'invalid_grant' || res.status === 401) return failAuth('invalid_grant', 'Your sign-in is no longer valid.');
  return failAuth('provider_error', 'The identity provider refused the request.');
}

function toTokenSet(obj: Record<string, unknown>, now: number, previousRefresh?: string): AuthResult<TokenSet> {
  const at = obj['access_token'];
  const type = obj['token_type'];
  const exp = obj['expires_in'];
  if (typeof at !== 'string' || at.length === 0 || /\s/.test(at))
    return failAuth('malformed', 'The identity provider returned no usable access token.');
  if (typeof type !== 'string' || type.toLowerCase() !== 'bearer')
    return failAuth('malformed', 'The identity provider returned an unsupported token type.');
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0)
    return failAuth('malformed', 'The identity provider did not state when the token expires.');
  const rt = obj['refresh_token'];
  const refreshToken = typeof rt === 'string' && rt.length > 0 ? rt : previousRefresh;
  // Any id_token present is deliberately dropped: Studio makes no identity decision from it.
  return okAuth({ accessToken: at, expiresAt: now + exp * 1000, ...(refreshToken !== undefined ? { refreshToken } : {}) });
}

export async function exchangeCode(
  endpoints: ProviderEndpoints,
  config: OidcConfig,
  a: { code: string; verifier: string; redirectUri: string },
  doFetch: AuthFetch,
  now: number,
): Promise<AuthResult<TokenSet>> {
  const r = await postToken(
    endpoints,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: a.code,
      redirect_uri: a.redirectUri,
      client_id: config.clientId,
      code_verifier: a.verifier,
    }),
    doFetch,
  );
  return r.ok ? toTokenSet(r.value, now) : r;
}

export async function refreshTokens(
  endpoints: ProviderEndpoints,
  config: OidcConfig,
  refreshToken: string,
  doFetch: AuthFetch,
  now: number,
): Promise<AuthResult<TokenSet>> {
  const r = await postToken(
    endpoints,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: config.clientId }),
    doFetch,
  );
  return r.ok ? toTokenSet(r.value, now, refreshToken) : r;
}

/** Best effort: failure to revoke never blocks local sign-out. */
/** What a Google code exchange yields that XO needs: the ID token to hand to the XO API. Google's access token is discarded unread; its refresh token is returned ONLY so it can be revoked, never stored. */
export interface IdentityGrant {
  readonly idToken: string;
  readonly refreshToken?: string;
}

export async function exchangeCodeForIdentity(
  endpoints: ProviderEndpoints,
  config: OidcConfig,
  a: { code: string; verifier: string; redirectUri: string },
  doFetch: AuthFetch,
): Promise<AuthResult<IdentityGrant>> {
  const r = await postToken(
    endpoints,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: a.code,
      redirect_uri: a.redirectUri,
      client_id: config.clientId,
      code_verifier: a.verifier,
    }),
    doFetch,
  );
  if (!r.ok) return r;
  const idToken = r.value['id_token'];
  if (typeof idToken !== 'string' || idToken.length === 0 || /\s/.test(idToken) || idToken.length > 8192) {
    return failAuth('malformed', 'The identity provider returned no usable identity token.');
  }
  const rt = r.value['refresh_token'];
  return okAuth({ idToken, ...(typeof rt === 'string' && rt.length > 0 ? { refreshToken: rt } : {}) });
}

export async function revokeRefreshToken(
  endpoints: ProviderEndpoints,
  config: OidcConfig,
  refreshToken: string,
  doFetch: AuthFetch,
): Promise<void> {
  if (endpoints.revocationEndpoint === undefined) return;
  try {
    await doFetch(endpoints.revocationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: config.clientId }).toString(),
      redirect: 'error',
    });
  } catch {
    /* ignored by design */
  }
}
