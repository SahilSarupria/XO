import { AuthError, ErrorCode } from '@xo/errors';
import type { SessionAuthConfig } from './config.js';

/**
 * Server-side redemption of a Google authorization code (code flow + PKCE), the step that needs the OAuth client
 * secret. Studio, a distributed public client, never holds that secret: it sends the code, its PKCE verifier and the
 * loopback redirect URI here, and this process redeems them at Google's token endpoint.
 *
 * What it returns: the ID token, as a string, to be verified by the ID-token verifier exactly as before (signature,
 * issuer, audience, expiry and THIS sign-in's nonce). What it never does: use or return Google's access token, keep a
 * Google refresh token (one is revoked best-effort if Google issues it), log a request or response body, or put the
 * client secret in an error. Failures are `AuthError`s with fixed messages plus, for a refusal, Google's RFC 6749 error
 * code (a short lowercase token, never request data) so an operator can diagnose a misconfigured client.
 */
export interface CodeExchanger {
  exchange(a: { readonly code: string; readonly codeVerifier: string; readonly redirectUri: string }): Promise<string>;
}

export interface CodeExchangerOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ID_TOKEN = 8192;
const UNAVAILABLE = 'sign-in cannot be completed right now; try again shortly';

function unavailable(): AuthError {
  return new AuthError(ErrorCode.AUTH_PROVIDER_UNAVAILABLE, UNAVAILABLE);
}

/** Only a well-formed provider error code is ever echoed. */
function codeSuffix(code: unknown): string {
  return typeof code === 'string' && /^[a-z][a-z_]{0,39}$/.test(code) ? ` (${code})` : '';
}

export function createCodeExchanger(config: SessionAuthConfig, options: CodeExchangerOptions = {}): CodeExchanger | undefined {
  const secret = config.clientSecret;
  if (secret === undefined) return undefined;
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const revokeUri = new URL('/revoke', config.tokenUri).toString();

  return {
    async exchange({ code, codeVerifier, redirectUri }): Promise<string> {
      let res: Response;
      try {
        res = await doFetch(config.tokenUri, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: config.clientId,
            client_secret: secret,
            code_verifier: codeVerifier,
          }).toString(),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw unavailable();
      }
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        parsed = undefined;
      }
      const obj = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;

      if (res.status >= 500 || res.status === 429 || res.status === 408) throw unavailable();
      if (!res.ok) {
        if (obj['error'] === 'invalid_grant')
          throw new AuthError(ErrorCode.AUTH_TOKEN_INVALID, 'the sign-in code is invalid or has expired; start again');
        throw new AuthError(ErrorCode.AUTH_TOKEN_INVALID, `the identity provider refused the sign-in${codeSuffix(obj['error'])}`);
      }

      const refresh = obj['refresh_token'];
      if (typeof refresh === 'string' && refresh.length > 0) {
        // XO does not want a Google refresh token: revoke it best-effort and never wait on it or keep it.
        void doFetch(revokeUri, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: refresh }).toString(),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        }).catch(() => undefined);
      }
      const idToken = obj['id_token'];
      if (typeof idToken !== 'string' || idToken.length === 0 || idToken.length > MAX_ID_TOKEN || /\s/.test(idToken))
        throw new AuthError(ErrorCode.AUTH_TOKEN_INVALID, 'the identity provider returned no usable identity token');
      return idToken;
    },
  };
}
