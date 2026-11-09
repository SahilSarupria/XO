import { appendFileSync, chmodSync, closeSync, existsSync, openSync } from 'node:fs';
import type { Scope } from './auth.js';

/**
 * A record of what the server REFUSED and why. Authentication failures, scope violations, rate limiting and TLS handshake failures are what an operator
 * needs to see an attack or a misconfigured client. An event never carries a credential (not the token, not a hash or prefix of it, not the Authorization
 * header) and never the query string; every text field is stripped of control characters so a hostile path or address cannot forge a log line.
 */
export type AuditKind =
  'auth_failure' | 'auth_lockout' | 'forbidden' | 'rate_limited' | 'tls_error' | 'bad_request' | 'token_store_unavailable';

export interface AuditEvent {
  readonly ts: string;
  readonly kind: AuditKind;
  readonly remote: string;
  readonly method: string;
  readonly path: string;
  /** `malformed | unknown | expired | revoked | unavailable | missing` for authentication failures. */
  readonly reason?: string;
  /** The authenticated client, for `forbidden`. Absent when the caller never authenticated. */
  readonly clientId?: string;
  /** The scope the route needed, for `forbidden`. */
  readonly need?: Scope;
}

export type AuditSink = (event: AuditEvent) => void;

export const clean = (s: string, max = 200): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?').slice(0, max);

/** Append-only JSON Lines, owner-only. A sink that cannot write must not take the server down, and must not be silent: it reports once on stderr. */
export function fileAuditSink(path: string): AuditSink {
  if (!existsSync(path)) closeSync(openSync(path, 'a', 0o600));
  chmodSync(path, 0o600);
  let warned = false;
  return (e) => {
    try {
      appendFileSync(path, `${JSON.stringify(e)}\n`, { mode: 0o600 });
    } catch (err) {
      if (!warned) {
        warned = true;
        process.stderr.write(`xo: audit log ${path} is not writable (${(err as Error).message}); refusals are no longer being recorded\n`);
      }
    }
  };
}
