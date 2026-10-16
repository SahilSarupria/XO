import { ErrorCode, XoError } from '@xo/errors';
import { assertTrustedUrl } from '../oidc/config.js';

/**
 * Operator configuration for Google sign-in → XO sessions. Off unless `XO_API_GOOGLE_CLIENT_ID` is set.
 *
 * `XO_API_GOOGLE_CLIENT_ID` is the Google *Desktop app* OAuth client id: a public identifier, not a secret. No
 * client secret is read, stored or required by XO.
 *
 * The trusted issuer is operator configuration, never taken from a token. It defaults to Google's published
 * issuer. `XO_API_GOOGLE_ISSUER` exists so a test or proxy deployment can point at a different, explicitly
 * trusted issuer (https, or loopback http for a local test issuer); the legacy spelling `accounts.google.com` is
 * accepted as a token `iss` ONLY when the configured issuer is exactly Google's. Whatever `iss` is accepted,
 * identities are bound and recorded under the single canonical issuer string.
 */
export const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_LEGACY_ISSUER = 'accounts.google.com';
const DEFAULT_SESSIONS_DIR = '.xo-data/sessions';
const DEFAULT_BINDINGS_DIR = '.xo-data/oidc-bindings';

export interface SessionAuthConfig {
  readonly clientId: string;
  /** Canonical issuer: what bindings are keyed by and what records show. */
  readonly issuer: string;
  /** Values accepted in a token's `iss`. */
  readonly acceptedIssuerClaims: readonly string[];
  readonly sessionsDir: string;
  readonly bindingsDir: string;
  readonly jwksUri?: string;
}

function bad(name: string, why: string): XoError {
  return new XoError(ErrorCode.CONFIG_INVALID_VALUE, `invalid ${name}: ${why}`);
}
const unset = (v: string | undefined): boolean => v === undefined || v.trim() === '';

export function loadSessionAuthConfig(env: Readonly<Record<string, string | undefined>> = process.env): SessionAuthConfig | undefined {
  const clientIdRaw = env['XO_API_GOOGLE_CLIENT_ID'];
  const others = ['XO_API_GOOGLE_ISSUER', 'XO_API_GOOGLE_JWKS_URI', 'XO_API_SESSIONS_DIR'] as const;
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

  return {
    clientId,
    issuer,
    acceptedIssuerClaims: issuer === GOOGLE_ISSUER ? [GOOGLE_ISSUER, GOOGLE_LEGACY_ISSUER] : [issuer],
    sessionsDir: unset(env['XO_API_SESSIONS_DIR']) ? DEFAULT_SESSIONS_DIR : (env['XO_API_SESSIONS_DIR'] as string).trim(),
    bindingsDir: unset(env['XO_API_OIDC_BINDINGS_DIR']) ? DEFAULT_BINDINGS_DIR : (env['XO_API_OIDC_BINDINGS_DIR'] as string).trim(),
    ...(jwksUri !== undefined ? { jwksUri } : {}),
  };
}
