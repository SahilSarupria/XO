/**
 * API base-URL resolution. Pure and shell-neutral: no Tauri, no DOM access beyond
 * the explicit inputs, so it is fully unit-testable.
 *
 * Precedence: host-injected runtime config > build-time VITE_XO_API_URL > "/api".
 * Accepted values: a same-origin relative path ("/api", "/xo/api") or an absolute
 * http(s) URL. Everything else (javascript:, data:, file:, protocol-relative
 * "//host", embedded credentials, query strings, fragments) is rejected.
 */
import { parseOidcConfig, type OidcConfig } from '../auth/oidc';

export const DEFAULT_API_BASE_URL = '/api';

export interface XoRuntimeConfig {
  readonly apiBaseUrl?: unknown;
  /** Production sign-in: { issuer, clientId, scopes?, audience? }. Never a secret. */
  readonly oidc?: unknown;
  /** Set false to hide the development access-key sign-in. Default true. */
  readonly devSignIn?: unknown;
}

declare global {
  interface Window {
    __XO_CONFIG__?: XoRuntimeConfig;
  }
}

export type ConfigSource = 'runtime' | 'build' | 'default';

export type ApiBaseUrlResult =
  | { readonly ok: true; readonly baseUrl: string; readonly source: ConfigSource }
  | { readonly ok: false; readonly source: ConfigSource; readonly message: string };

export function normaliseApiBaseUrl(raw: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string') return { ok: false, reason: 'it is not a string' };
  const value = raw.trim();
  if (value.length === 0) return { ok: false, reason: 'it is empty' };
  if (/[\u0000-\u001f\s]/.test(value)) return { ok: false, reason: 'it contains whitespace or control characters' };

  if (value.startsWith('/')) {
    if (value.startsWith('//')) return { ok: false, reason: 'protocol-relative URLs are not allowed' };
    if (/[?#]/.test(value)) return { ok: false, reason: 'it must not contain a query string or fragment' };
    if (value.includes('\\')) return { ok: false, reason: 'it must not contain backslashes' };
    if (value.split('/').some((s) => s === '..' || s === '.')) return { ok: false, reason: 'it must not contain dot segments' };
    return { ok: true, value: stripTrailingSlashes(value) || '/' };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'it is not a relative path starting with "/" or a valid http(s) URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `the "${url.protocol.replace(':', '')}" scheme is not allowed (use http or https)` };
  }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'it must not embed credentials' };
  if (url.search !== '' || url.hash !== '') return { ok: false, reason: 'it must not contain a query string or fragment' };
  return { ok: true, value: stripTrailingSlashes(`${url.origin}${url.pathname}`) };
}

function stripTrailingSlashes(s: string): string {
  return s.replace(/\/+$/, '');
}

export interface ResolveInputs {
  readonly runtime?: XoRuntimeConfig | undefined;
  readonly buildTime?: string | undefined;
}

const LABEL: Record<ConfigSource, string> = {
  runtime: 'the runtime setting (window.__XO_CONFIG__.apiBaseUrl)',
  build: 'the build-time setting (VITE_XO_API_URL)',
  default: 'the default',
};

export function resolveApiBaseUrl(inputs: ResolveInputs): ApiBaseUrlResult {
  const runtime = inputs.runtime?.apiBaseUrl;
  const candidates: ReadonlyArray<readonly [ConfigSource, unknown]> = [
    ['runtime', runtime],
    ['build', inputs.buildTime === undefined || inputs.buildTime.trim() === '' ? undefined : inputs.buildTime],
  ];
  for (const [source, raw] of candidates) {
    if (raw === undefined || raw === null) continue;
    const n = normaliseApiBaseUrl(raw);
    // A value that is present but invalid is an error, never a silent fall-through:
    // quietly using a different endpoint than the operator configured is worse than stopping.
    if (!n.ok) {
      return {
        ok: false,
        source,
        message: `XO Studio is configured with an invalid API address in ${LABEL[source]}: ${n.reason}. Set it to a path such as "/api" or a full http(s) address, then reload.`,
      };
    }
    return { ok: true, baseUrl: n.value, source };
  }
  return { ok: true, baseUrl: DEFAULT_API_BASE_URL, source: 'default' };
}

export type AuthConfigResult =
  { readonly ok: true; readonly oidc?: OidcConfig; readonly devSignIn: boolean } | { readonly ok: false; readonly message: string };

/** Strict: a present-but-invalid setting stops startup; it is never ignored. */
export function resolveAuthConfig(runtime: XoRuntimeConfig | undefined): AuthConfigResult {
  let oidc: OidcConfig | undefined;
  if (runtime?.oidc !== undefined && runtime.oidc !== null) {
    const r = parseOidcConfig(runtime.oidc);
    if (!r.ok) return { ok: false, message: `XO Studio is configured with invalid sign-in settings: ${r.failure.message}` };
    oidc = r.value;
  }
  const d = runtime?.devSignIn;
  if (d !== undefined && typeof d !== 'boolean') {
    return { ok: false, message: 'XO Studio is configured with an invalid devSignIn setting (it must be true or false).' };
  }
  const devSignIn = d ?? true;
  if (oidc === undefined && !devSignIn) {
    return {
      ok: false,
      message: 'XO Studio has no sign-in method configured: the development sign-in is disabled and no OIDC settings were provided.',
    };
  }
  return { ok: true, ...(oidc !== undefined ? { oidc } : {}), devSignIn };
}

export function resolveFromEnvironment(): ApiBaseUrlResult {
  const buildTime = (import.meta.env as Record<string, string | undefined>)['VITE_XO_API_URL'];
  return resolveApiBaseUrl({
    runtime: typeof window === 'undefined' ? undefined : window.__XO_CONFIG__,
    buildTime,
  });
}
