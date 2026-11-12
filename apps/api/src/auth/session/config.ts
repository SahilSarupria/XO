import { ErrorCode, XoError } from '@xo/errors';
import { assertTrustedUrl } from '../oidc/config.js';

/**
 * Operator configuration for Google sign-in → XO sessions. Off unless `XO_API_GOOGLE_CLIENT_ID` is set.
 *
 * `XO_API_GOOGLE_CLIENT_ID` is the Google *Desktop app* OAuth client id: a public identifier, not a secret.
 *
 * `XO_API_GOOGLE_CLIENT_SECRET` (optional) is that client's secret. Google's token endpoint requires it even for a
 * PKCE desktop flow, and Studio, being a distributed public client, must never hold it. Setting it enables the
 * SERVER-SIDE code exchange: Studio sends the authorization code + PKCE verifier to this API, which redeems them at
 * Google. The secret lives only in this process's environment (a secret manager in production): it is never logged,
 * returned, or written to disk. Without it, only the ID-token exchange (`idToken` in the request) is available.
 *
 * The trusted issuer is operator configuration, never taken from a token. It defaults to Google's published
 * issuer. `XO_API_GOOGLE_ISSUER` exists so a test or proxy deployment can point at a different, explicitly
 * trusted issuer (https, or loopback http for a local test issuer); the legacy spelling `accounts.google.com` is
 * accepted as a token `iss` ONLY when the configured issuer is exactly Google's. Whatever `iss` is accepted,
 * identities are bound and recorded under the single canonical issuer string.
 */
export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const GOOGLE_LEGACY_ISSUER = 'accounts.google.com';
export const DEFAULT_SESSIONS_DIR = '.xo-data/sessions';
export const DEFAULT_BINDINGS_DIR = '.xo-data/oidc-bindings';

export interface SessionAuthConfig {
  readonly clientId: string;
  /** Canonical issuer: what bindings are keyed by and what records show. */
  readonly issuer: string;
  /** Values accepted in a token's `iss`. */
  readonly acceptedIssuerClaims: readonly string[];
  readonly sessionsDir: string;
  readonly bindingsDir: string;
  readonly jwksUri?: string;
  /** Present only when the server-side code exchange is enabled. Never log or serialize this config object. */
  readonly clientSecret?: string;
  /** Where the server redeems authorization codes. Defaults to Google's. */
  readonly tokenUri: string;
  /** When true, a first sign-in from a verified, never-seen identity is provisioned its own personal identity (no organisation). Off by default. */
  readonly selfSignup: boolean;
  /** Most NEW self-signed-up accounts allowed in any rolling 24 hours. Existing accounts are never affected. */
  readonly selfSignupMaxPerDay: number;
}

export const DEFAULT_SELF_SIGNUP_MAX_PER_DAY = 200;
function parseMaxPerDay(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SELF_SIGNUP_MAX_PER_DAY;
  const text = raw.trim();
  const n = Number(text);
  if (!/^\d+$/.test(text) || n < 1 || n > 1_000_000)
    throw bad('XO_API_SELF_SIGNUP_MAX_PER_DAY', 'must be a whole number from 1 to 1000000');
  return n;
}

function bad(name: string, why: string): XoError {
  return new XoError(ErrorCode.CONFIG_INVALID_VALUE, `invalid ${name}: ${why}`);
}
const unset = (v: string | undefined): boolean => v === undefined || v.trim() === '';

export function loadSessionAuthConfig(env: Readonly<Record<string, string | undefined>> = process.env): SessionAuthConfig | undefined {
  const clientIdRaw = env['XO_API_GOOGLE_CLIENT_ID'];
  const others = [
    'XO_API_GOOGLE_ISSUER',
    'XO_API_GOOGLE_JWKS_URI',
    'XO_API_SESSIONS_DIR',
    'XO_API_GOOGLE_CLIENT_SECRET',
    'XO_API_GOOGLE_TOKEN_URI',
  ] as const;
  if (unset(clientIdRaw)) {
    for (const name of others) {
      if (!unset(env[name])) throw bad(name, 'set without XO_API_GOOGLE_CLIENT_ID');
    }
    return undefined;
  }
  const clientId = (clientIdRaw as string).trim();
  if (clientId.length > 256 || !/^[A-Za-z0-9._-]+$/.test(clientId))
    throw bad('XO_API_GOOGLE_CLIENT_ID', 'must be a single token of letters, digits, dot, dash or underscore (at most 256 characters)');

  const issuer = unset(env['XO_API_GOOGLE_ISSUER']) ? GOOGLE_ISSUER : (env['XO_API_GOOGLE_ISSUER'] as string).trim();
  assertTrustedUrl('XO_API_GOOGLE_ISSUER', issuer);

  let jwksUri: string | undefined;
  if (!unset(env['XO_API_GOOGLE_JWKS_URI'])) {
    jwksUri = (env['XO_API_GOOGLE_JWKS_URI'] as string).trim();
    assertTrustedUrl('XO_API_GOOGLE_JWKS_URI', jwksUri);
  }

  let clientSecret: string | undefined;
  if (!unset(env['XO_API_GOOGLE_CLIENT_SECRET'])) {
    clientSecret = (env['XO_API_GOOGLE_CLIENT_SECRET'] as string).trim();
    // The value is never echoed in an error: only the variable name and the rule.
    if (clientSecret.length > 256 || !/^[\x21-\x7e]+$/.test(clientSecret))
      throw bad('XO_API_GOOGLE_CLIENT_SECRET', 'must be a single printable token of at most 256 characters');
  }
  const tokenUri = unset(env['XO_API_GOOGLE_TOKEN_URI']) ? GOOGLE_TOKEN_URI : (env['XO_API_GOOGLE_TOKEN_URI'] as string).trim();
  assertTrustedUrl('XO_API_GOOGLE_TOKEN_URI', tokenUri);

  return {
    clientId,
    issuer,
    acceptedIssuerClaims: issuer === GOOGLE_ISSUER ? [GOOGLE_ISSUER, GOOGLE_LEGACY_ISSUER] : [issuer],
    sessionsDir: unset(env['XO_API_SESSIONS_DIR']) ? DEFAULT_SESSIONS_DIR : (env['XO_API_SESSIONS_DIR'] as string).trim(),
    bindingsDir: unset(env['XO_API_OIDC_BINDINGS_DIR']) ? DEFAULT_BINDINGS_DIR : (env['XO_API_OIDC_BINDINGS_DIR'] as string).trim(),
    ...(jwksUri !== undefined ? { jwksUri } : {}),
    ...(clientSecret !== undefined ? { clientSecret } : {}),
    tokenUri,
    selfSignup: /^(1|true)$/i.test((env['XO_API_SELF_SIGNUP'] ?? '').trim()),
    selfSignupMaxPerDay: parseMaxPerDay(env['XO_API_SELF_SIGNUP_MAX_PER_DAY']),
  };
}
