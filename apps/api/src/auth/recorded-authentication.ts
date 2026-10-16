import type { AuthenticationInfo } from '../http/types.js';

/**
 * How the initiating principal authenticated, as stamped on execution and workflow-execution records next to
 * the existing `initiator` snapshot. Only two facts: the credential TYPE and, for provider-backed credentials,
 * the canonical ISSUER. Derived exclusively from what the server itself established during authentication
 * (never from a request field), validated again here, and never containing a token, subject, email or claim.
 *
 * Attribution only; it is not proof of authorization. Shaped as a flat `{ credential, issuer? }` object so it
 * can be carried verbatim into a future additive actor field in `@xo/audit` without translation.
 *
 * Absent on records written before this field existed (never back-filled or guessed).
 */
export interface RecordedAuthentication {
  readonly credential: 'api-key' | 'oidc' | 'session';
  readonly issuer?: string;
}

const CREDENTIALS: ReadonlySet<string> = new Set(['api-key', 'oidc', 'session']);

export function toRecordedAuthentication(info: AuthenticationInfo | undefined): RecordedAuthentication | undefined {
  if (info === undefined || !CREDENTIALS.has(info.credential)) return undefined;
  if (info.credential === 'api-key') return { credential: 'api-key' };
  const issuer = (info as { issuer?: unknown }).issuer;
  // A provider-backed credential without a sane issuer is not recorded rather than recorded wrongly.
  if (typeof issuer !== 'string' || issuer.length === 0 || issuer.length > 256 || /[\u0000-\u001f\u007f\s]/.test(issuer)) return undefined;
  return { credential: info.credential, issuer };
}
