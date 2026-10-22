/**
 * Secret redaction for anything that may reach a log line, an error message
 * or an error context. Two layers: exact-match of the credentials this
 * process actually holds, plus pattern-match for Google API-key-shaped
 * strings and auth headers in case a key reaches us some other way
 * (e.g. echoed in a vendor error body).
 */
const GOOGLE_API_KEY_PATTERN = /AIza[0-9A-Za-z_-]{20,}/g;
const AUTH_HEADER_PATTERN = /(x-goog-api-key|authorization|api[-_]?key)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi;
const REDACTED = '[REDACTED]';

export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 6) out = out.split(secret).join(REDACTED);
  }
  return out.replace(GOOGLE_API_KEY_PATTERN, REDACTED).replace(AUTH_HEADER_PATTERN, `$1$2${REDACTED}`);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}
