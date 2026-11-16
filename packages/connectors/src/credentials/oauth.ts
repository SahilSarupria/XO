/**
 * UW-9 (ADR 0036) — OAuth 2.0 authorization code with PKCE (RFC 7636, S256), for the providers XO connects to.
 *
 * Least privilege (UAC-14). XO never asks for scopes by name: it asks for CAPABILITIES (`message.send`), and each provider maps a
 * capability to the narrowest scope that does it (`gmail.send`, `Mail.Send`), plus the identity scopes needed to know which account
 * was connected. After consent, the granted scopes must include every one a capability needs AND must not exceed what was asked
 * for (OpenID identity scopes aside); a broader grant is refused and not stored.
 *
 * Every request to a provider goes through `egress`: HTTPS only, to that provider's hosts only, to a vetted, pinned address, with
 * no redirects followed. Provider facts (endpoints, scopes, revocation) and their sources are in docs/CREDENTIALS.md.
 */
import { createHash, randomBytes } from 'node:crypto';
import { egress, type EgressDeps, type EgressPolicy } from '../egress.js';
import { ConnectorError } from '../types.js';

export type OAuthCapability = 'message.send';
export const OAUTH_CAPABILITIES: readonly OAuthCapability[] = ['message.send'];

export interface OAuthClientConfig {
  readonly clientId: string;
  /** Confidential web clients send it on the token request; a public client (PKCE only) has none. */
  readonly clientSecret?: string;
  /** Microsoft: `common`, `organizations`, `consumers` or a tenant id. Ignored by Google. */
  readonly tenant?: string;
}

export interface OAuthProvider {
  readonly id: 'google' | 'microsoft';
  readonly displayName: string;
  readonly hosts: readonly string[];
  authorizeUrl(c: OAuthClientConfig): string;
  tokenUrl(c: OAuthClientConfig): string;
  /** Absent: the provider has no endpoint a client can call to revoke a grant (consent must be withdrawn at the provider). */
  revokeUrl?: string;
  /** Scopes that identify the account and make offline (refresh) access possible. */
  readonly identityScopes: readonly string[];
  readonly capabilityScopes: Readonly<Record<OAuthCapability, readonly string[]>>;
  /** Extra authorization parameters (offline access, forced consent). */
  readonly authorizeParams: Readonly<Record<string, string>>;
  /** OpenID scopes a provider may report though they were implied (never counted as "more than asked for"). */
  readonly implicitScopes: readonly string[];
  normalizeScope(raw: string): string;
  /** The issuer an id_token from this client must name. */
  issuerOk(iss: string, c: OAuthClientConfig, claims: Readonly<Record<string, unknown>>): boolean;
}

const MS_LOGIN = 'login.microsoftonline.com';

export const GOOGLE: OAuthProvider = {
  id: 'google',
  displayName: 'Google',
  hosts: ['accounts.google.com', 'oauth2.googleapis.com'],
  authorizeUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: () => 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  identityScopes: ['openid', 'email'],
  // gmail.send: send only, no read or modify of the mailbox (a "sensitive" scope: verification, no security assessment).
  capabilityScopes: { 'message.send': ['https://www.googleapis.com/auth/gmail.send'] },
  // offline: a refresh token; consent: Google issues the refresh token only on a consent screen. No include_granted_scopes: a
  // grant never silently picks up scopes from an earlier consent.
  authorizeParams: { access_type: 'offline', prompt: 'consent' },
  implicitScopes: [
    'openid',
    'email',
    'https://www.googleapis.com/auth/userinfo.email',
    'profile',
    'https://www.googleapis.com/auth/userinfo.profile',
  ],
  normalizeScope: (s) => s,
  issuerOk: (iss) => iss === 'https://accounts.google.com' || iss === 'accounts.google.com',
};

export const MICROSOFT: OAuthProvider = {
  id: 'microsoft',
  displayName: 'Microsoft',
  hosts: [MS_LOGIN],
  authorizeUrl: (c) => `https://${MS_LOGIN}/${encodeURIComponent(c.tenant ?? 'common')}/oauth2/v2.0/authorize`,
  tokenUrl: (c) => `https://${MS_LOGIN}/${encodeURIComponent(c.tenant ?? 'common')}/oauth2/v2.0/token`,
  identityScopes: ['openid', 'email', 'offline_access'],
  // Mail.Send (delegated): send mail as the signed-in user; no read of the mailbox. A bare name means Microsoft Graph.
  capabilityScopes: { 'message.send': ['Mail.Send'] },
  authorizeParams: { prompt: 'select_account' },
  implicitScopes: ['openid', 'email', 'profile', 'offline_access'],
  normalizeScope: (s) => (s.toLowerCase().startsWith('https://graph.microsoft.com/') ? s.slice('https://graph.microsoft.com/'.length) : s),
  issuerOk: (iss, c, claims) => {
    const tid = typeof claims['tid'] === 'string' ? claims['tid'] : '';
    if (c.tenant !== undefined && !['common', 'organizations', 'consumers'].includes(c.tenant))
      return iss === `https://${MS_LOGIN}/${c.tenant}/v2.0`;
    return /^[0-9a-f-]{36}$/i.test(tid) && iss === `https://${MS_LOGIN}/${tid}/v2.0`;
  },
};

export const OAUTH_PROVIDERS: Readonly<Record<OAuthProvider['id'], OAuthProvider>> = { google: GOOGLE, microsoft: MICROSOFT };

const b64url = (b: Buffer): string => b.toString('base64url');

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}
/** 32 random bytes → a 43-character verifier (RFC 7636 §4.1); S256 challenge (§4.2). */
export function newPkce(): Pkce {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier, 'ascii').digest()) };
}
export const newState = (): string => b64url(randomBytes(32));

/** The scopes to ask for: identity plus each capability's narrowest scope, deduplicated, in a stable order. */
export function requestedScopes(p: OAuthProvider, capabilities: readonly OAuthCapability[]): string[] {
  if (capabilities.length === 0) throw new ConnectorError('DENIED', 'name at least one capability to connect for');
  const out = new Set(p.identityScopes);
  for (const c of capabilities) {
    const s = p.capabilityScopes[c];
    if (s === undefined) throw new ConnectorError('DENIED', `${p.displayName} has no scope for capability "${c}"`);
    for (const x of s) out.add(x);
  }
  return [...out];
}

export function authorizationUrl(
  p: OAuthProvider,
  c: OAuthClientConfig,
  a: {
    readonly redirectUri: string;
    readonly state: string;
    readonly codeChallenge: string;
    readonly scopes: readonly string[];
    readonly loginHint?: string;
  },
): string {
  const u = new URL(p.authorizeUrl(c));
  u.searchParams.set('client_id', c.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', a.redirectUri);
  u.searchParams.set('scope', a.scopes.join(' '));
  u.searchParams.set('state', a.state);
  u.searchParams.set('code_challenge', a.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  for (const [k, v] of Object.entries(p.authorizeParams)) u.searchParams.set(k, v);
  if (a.loginHint !== undefined) u.searchParams.set('login_hint', a.loginHint);
  return u.toString();
}

export type ScopeVerdict =
  | { readonly ok: true; readonly granted: readonly string[] }
  | { readonly ok: false; readonly missing: readonly string[]; readonly extra: readonly string[] };

/** UAC-14: the grant covers what the capabilities need and is no broader than what was asked for. */
export function checkGrantedScopes(p: OAuthProvider, requested: readonly string[], grantedRaw: readonly string[]): ScopeVerdict {
  const norm = (xs: readonly string[]): Set<string> => new Set(xs.map((x) => p.normalizeScope(x).toLowerCase()));
  const granted = norm(grantedRaw);
  const asked = norm(requested);
  const implicit = norm(p.implicitScopes);
  const needed = [...asked].filter((s) => !implicit.has(s));
  const missing = needed.filter((s) => !granted.has(s));
  const extra = [...granted].filter((s) => !asked.has(s) && !implicit.has(s));
  if (missing.length > 0 || extra.length > 0) return { ok: false, missing, extra };
  return { ok: true, granted: [...grantedRaw].map((x) => p.normalizeScope(x)).sort() };
}

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresInSec: number;
  /** As the provider reported them (absent: the provider did not say, so the requested set stands — checked again on use). */
  readonly scopes?: readonly string[];
  readonly idTokenClaims?: Readonly<Record<string, unknown>>;
}

export class OAuthError extends Error {
  constructor(
    /** `invalid_grant`: the code or refresh token is no longer valid (revoked, expired, reused). */
    readonly code: 'invalid_grant' | 'provider_error' | 'malformed_response' | 'unreachable',
    message: string,
  ) {
    super(message);
  }
}

const policyOf = (p: OAuthProvider): EgressPolicy => ({ allowedHosts: p.hosts, maxRequestBytes: 16_384, maxResponseBytes: 262_144 });

function decodeIdToken(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown;
    return typeof claims === 'object' && claims !== null && !Array.isArray(claims) ? (claims as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function tokenRequest(
  p: OAuthProvider,
  c: OAuthClientConfig,
  form: Record<string, string>,
  deps: EgressDeps,
  timeoutMs: number,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    client_id: c.clientId,
    ...(c.clientSecret !== undefined ? { client_secret: c.clientSecret } : {}),
    ...form,
  });
  let res;
  try {
    res = await egress(
      {
        url: p.tokenUrl(c),
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: body.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      },
      policyOf(p),
      deps,
    );
  } catch (e) {
    if (e instanceof ConnectorError && e.code === 'DENIED') throw e; // a policy refusal is not "unreachable"
    throw new OAuthError('unreachable', `${p.displayName} could not be reached`);
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    throw new OAuthError('malformed_response', `${p.displayName} answered with something that is not JSON (status ${res.status})`);
  }
  if (res.status !== 200) {
    // Only the error CODE is kept: an error description can echo the request.
    const code = typeof json['error'] === 'string' ? json['error'] : 'error';
    throw new OAuthError(
      code === 'invalid_grant' ? 'invalid_grant' : 'provider_error',
      `${p.displayName} refused the token request (${code})`,
    );
  }
  const access = json['access_token'];
  const expires = Number(json['expires_in']);
  if (typeof access !== 'string' || access === '' || !Number.isFinite(expires) || expires <= 0)
    throw new OAuthError('malformed_response', `${p.displayName} returned no usable access token`);
  if (typeof json['token_type'] === 'string' && json['token_type'].toLowerCase() !== 'bearer')
    throw new OAuthError('malformed_response', `${p.displayName} returned a "${json['token_type']}" token; only bearer tokens are used`);
  const claims = typeof json['id_token'] === 'string' ? decodeIdToken(json['id_token']) : undefined;
  return {
    accessToken: access,
    ...(typeof json['refresh_token'] === 'string' && json['refresh_token'] !== '' ? { refreshToken: json['refresh_token'] } : {}),
    expiresInSec: Math.min(expires, 86_400),
    ...(typeof json['scope'] === 'string' ? { scopes: json['scope'].split(/\s+/).filter((x) => x !== '') } : {}),
    ...(claims !== undefined ? { idTokenClaims: claims } : {}),
  };
}

export interface Account {
  /** The provider's stable id for the account (`sub`, or Microsoft's `oid`). */
  readonly id: string;
  readonly label?: string;
}

/**
 * The account a code exchange connected. The id_token came straight from the provider's token endpoint over TLS, which OpenID
 * Connect Core (§3.1.3.7) accepts in place of checking its signature; its audience and issuer are still checked here.
 */
export function accountOf(p: OAuthProvider, c: OAuthClientConfig, t: TokenSet): Account {
  const claims = t.idTokenClaims;
  if (claims === undefined) throw new OAuthError('malformed_response', `${p.displayName} returned no id_token, so the account is unknown`);
  const aud = claims['aud'];
  if (aud !== c.clientId && !(Array.isArray(aud) && aud.includes(c.clientId)))
    throw new OAuthError('malformed_response', 'the id_token is not for this client');
  if (typeof claims['iss'] !== 'string' || !p.issuerOk(claims['iss'], c, claims))
    throw new OAuthError('malformed_response', 'the id_token was not issued by the provider this client uses');
  const id = p.id === 'microsoft' && typeof claims['oid'] === 'string' ? claims['oid'] : claims['sub'];
  if (typeof id !== 'string' || id === '') throw new OAuthError('malformed_response', 'the id_token names no account');
  const label =
    typeof claims['email'] === 'string'
      ? claims['email']
      : typeof claims['preferred_username'] === 'string'
        ? claims['preferred_username']
        : undefined;
  return { id, ...(label !== undefined ? { label: label.slice(0, 320) } : {}) };
}

export interface OAuthDeps extends EgressDeps {
  readonly timeoutMs?: number;
}

export function exchangeCode(
  p: OAuthProvider,
  c: OAuthClientConfig,
  a: { readonly code: string; readonly codeVerifier: string; readonly redirectUri: string },
  deps: OAuthDeps = {},
): Promise<TokenSet> {
  return tokenRequest(
    p,
    c,
    { grant_type: 'authorization_code', code: a.code, code_verifier: a.codeVerifier, redirect_uri: a.redirectUri },
    deps,
    deps.timeoutMs ?? 15_000,
  );
}

export function refreshTokens(
  p: OAuthProvider,
  c: OAuthClientConfig,
  refreshToken: string,
  scopes: readonly string[],
  deps: OAuthDeps = {},
): Promise<TokenSet> {
  // Microsoft requires the scopes again on refresh; asking for the same set never widens it.
  return tokenRequest(
    p,
    c,
    { grant_type: 'refresh_token', refresh_token: refreshToken, ...(p.id === 'microsoft' ? { scope: scopes.join(' ') } : {}) },
    deps,
    deps.timeoutMs ?? 15_000,
  );
}

/** `performed` when the provider confirmed it; `not_available` when it has no revocation endpoint. */
export async function revokeAtProvider(
  p: OAuthProvider,
  token: string,
  deps: OAuthDeps = {},
): Promise<'performed' | 'not_available' | 'failed'> {
  if (p.revokeUrl === undefined) return 'not_available';
  try {
    const res = await egress(
      {
        url: p.revokeUrl,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
        signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
      },
      policyOf(p),
      deps,
    );
    // 200 revoked; 400 invalid_token means it was already not valid — either way it no longer works.
    return res.status === 200 || res.status === 400 ? 'performed' : 'failed';
  } catch {
    return 'failed';
  }
}
