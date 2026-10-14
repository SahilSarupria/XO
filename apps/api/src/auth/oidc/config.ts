import { ErrorCode, XoError } from '@xo/errors';

/**
 * Operator configuration for API-side OIDC bearer-token verification.
 *
 * OIDC acceptance is OFF unless BOTH `XO_API_OIDC_ISSUER` and `XO_API_OIDC_AUDIENCE` are
 * set. Setting exactly one is a startup error (never a silent fallback), and
 * so is any invalid value. There are no defaults for the issuer, audience or
 * JWKS location: this repository ships no identity-provider values.
 *
 * `XO_API_OIDC_BINDINGS_DIR` follows the same convention as `API_KEYS_DIR`: the
 * server's own credential bookkeeping, defaulting to a directory under the
 * process cwd and expected to be a persistent volume in a real deployment.
 * It holds no secrets, but it IS the authorization list for OIDC identities.
 */
export interface OidcConfig {
  /** Exact `iss` value tokens must carry. Compared as a string, never normalized. */
  readonly issuer: string;
  /** Value that must appear in a token's `aud`. */
  readonly audience: string;
  /** Where `(iss, sub)` → principal binding records live. */
  readonly bindingsDir: string;
  /** Optional explicit JWKS URL. When absent it is taken from the issuer's discovery document. */
  readonly jwksUri?: string;
  /** Allowed clock skew for exp / nbf / iat, in seconds (0–120, default 30). */
  readonly clockSkewSeconds: number;
}

const DEFAULT_BINDINGS_DIR = '.xo-data/oidc-bindings';
const DEFAULT_SKEW_SECONDS = 30;
const MAX_SKEW_SECONDS = 120;

function bad(name: string, why: string): XoError {
  // Names the variable and the rule, never the value (it may be a mistyped secret).
  return new XoError(ErrorCode.CONFIG_INVALID_VALUE, `invalid ${name}: ${why}`);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * https only; plain http is accepted solely for loopback hosts so a local test
 * issuer works. No credentials, query or fragment.
 */
export function assertTrustedUrl(name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw bad(name, 'must be an absolute URL');
  }
  const httpsOk = url.protocol === 'https:';
  const loopbackHttpOk = url.protocol === 'http:' && isLoopbackHost(url.hostname);
  if (!httpsOk && !loopbackHttpOk) throw bad(name, 'must use https (http is allowed only for loopback hosts)');
  if (url.username !== '' || url.password !== '') throw bad(name, 'must not contain credentials');
  if (url.search !== '' || url.hash !== '') throw bad(name, 'must not contain a query or fragment');
  return url;
}

function unset(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

export function loadOidcConfig(env: Readonly<Record<string, string | undefined>> = process.env): OidcConfig | undefined {
  const issuerRaw = env['XO_API_OIDC_ISSUER'];
  const audienceRaw = env['XO_API_OIDC_AUDIENCE'];
  const jwksRaw = env['XO_API_OIDC_JWKS_URI'];
  const skewRaw = env['XO_API_OIDC_CLOCK_SKEW_SECONDS'];

  if (unset(issuerRaw) && unset(audienceRaw)) {
    // OIDC is off. A JWKS override or skew with no issuer is a half-configured deployment: say so.
    if (!unset(jwksRaw)) throw bad('XO_API_OIDC_JWKS_URI', 'set without XO_API_OIDC_ISSUER and XO_API_OIDC_AUDIENCE');
    return undefined;
  }
  if (unset(issuerRaw)) throw new XoError(ErrorCode.CONFIG_MISSING_KEY, 'XO_API_OIDC_AUDIENCE is set but XO_API_OIDC_ISSUER is missing');
  if (unset(audienceRaw)) throw new XoError(ErrorCode.CONFIG_MISSING_KEY, 'XO_API_OIDC_ISSUER is set but XO_API_OIDC_AUDIENCE is missing');

  const issuer = (issuerRaw as string).trim();
  assertTrustedUrl('XO_API_OIDC_ISSUER', issuer);

  const audience = (audienceRaw as string).trim();
  if (audience.length > 256 || /\s/.test(audience)) throw bad('XO_API_OIDC_AUDIENCE', 'must be a single token of at most 256 characters');

  let jwksUri: string | undefined;
  if (!unset(jwksRaw)) {
    jwksUri = (jwksRaw as string).trim();
    assertTrustedUrl('XO_API_OIDC_JWKS_URI', jwksUri);
  }

  let clockSkewSeconds = DEFAULT_SKEW_SECONDS;
  if (!unset(skewRaw)) {
    const n = Number((skewRaw as string).trim());
    if (!Number.isInteger(n) || n < 0 || n > MAX_SKEW_SECONDS)
      throw bad('XO_API_OIDC_CLOCK_SKEW_SECONDS', `must be an integer from 0 to ${MAX_SKEW_SECONDS}`);
    clockSkewSeconds = n;
  }

  const bindingsDirRaw = env['XO_API_OIDC_BINDINGS_DIR'];
  return {
    issuer,
    audience,
    bindingsDir: unset(bindingsDirRaw) ? DEFAULT_BINDINGS_DIR : (bindingsDirRaw as string).trim(),
    ...(jwksUri !== undefined ? { jwksUri } : {}),
    clockSkewSeconds,
  };
}
