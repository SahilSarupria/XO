/**
 * P1.1 M5 — adapter configuration. ENVIRONMENT ONLY: the credential (`XO_API_KEY`) is never read from a tool argument, a prompt or
 * any protocol message, and no error produced here ever contains it.
 */

export interface McpConfig {
  /** Origin of the XO API, no trailing slash, no path. */
  readonly apiBaseUrl: string;
  readonly workspaceId: string;
  /** Bearer credential. Held in memory only; excluded from `toJSON`/inspection so an accidental dump cannot leak it. */
  readonly apiKey: string;
  /** Upper bound for ONE API request. A tool call that exceeds it is reported as outcome-unknown, never as failed. */
  readonly requestTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
export const MIN_REQUEST_TIMEOUT_MS = 1_000;
export const MAX_REQUEST_TIMEOUT_MS = 900_000;
/** The credential header must be a single-line printable token; anything else is refused before a request is built. */
const API_KEY = /^[\x21-\x7e]{8,512}$/;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('XO_API_URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ConfigError('XO_API_URL must be an http(s) URL');
  // A bearer credential must not cross a network in clear text: plain http is accepted for loopback only.
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    throw new ConfigError('XO_API_URL must use https unless it points at a loopback host');
  }
  if (url.username !== '' || url.password !== '') throw new ConfigError('XO_API_URL must not embed credentials');
  if (url.search !== '' || url.hash !== '' || (url.pathname !== '/' && url.pathname !== '')) {
    throw new ConfigError('XO_API_URL must be an origin only (no path, query or fragment)');
  }
  return url.origin;
}

/** Throws `ConfigError` with a message that names the VARIABLE, never a value. */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): McpConfig {
  const key = env['XO_API_KEY'];
  if (key === undefined || key === '') throw new ConfigError('XO_API_KEY is required (environment only)');
  if (!API_KEY.test(key)) throw new ConfigError('XO_API_KEY is malformed');
  const url = env['XO_API_URL'];
  if (url === undefined || url === '') throw new ConfigError('XO_API_URL is required');
  const workspaceId = env['XO_WORKSPACE_ID'];
  if (workspaceId === undefined || workspaceId === '') throw new ConfigError('XO_WORKSPACE_ID is required');
  if (!WORKSPACE_ID.test(workspaceId)) throw new ConfigError('XO_WORKSPACE_ID is malformed');
  let requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  const t = env['XO_MCP_REQUEST_TIMEOUT_MS'];
  if (t !== undefined && t !== '') {
    const n = /^[0-9]+$/.test(t) ? Number(t) : NaN;
    if (!Number.isSafeInteger(n) || n < MIN_REQUEST_TIMEOUT_MS || n > MAX_REQUEST_TIMEOUT_MS) {
      throw new ConfigError(`XO_MCP_REQUEST_TIMEOUT_MS must be an integer between ${MIN_REQUEST_TIMEOUT_MS} and ${MAX_REQUEST_TIMEOUT_MS}`);
    }
    requestTimeoutMs = n;
  }
  const config: McpConfig = { apiBaseUrl: parseBaseUrl(url), workspaceId, apiKey: key, requestTimeoutMs };
  // Non-enumerable: JSON.stringify / console.error / util.inspect of the config never shows the credential.
  Object.defineProperty(config, 'apiKey', { value: key, enumerable: false, writable: false });
  return Object.freeze(config);
}
