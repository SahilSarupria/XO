import { LocalFsBlobStore } from '@xo/storage';
import { join } from 'node:path';
import { FsAuditLog } from '../../audit/fs-audit-log.js';
import type { AuditResult, AuthEventType } from '../../audit/audit-entry.js';

/**
 * Account-level audit log for authentication: the same append-only, hash-chained log the workspaces use, in its own
 * directory (workspace logs belong to a workspace and sign-in happens before one is chosen).
 *
 * What it holds: event, time, result, the account id when one exists, and KEYED hashes of the login name and source
 * address. What it never holds — by construction, since no code path passes them in — passwords, hashes, tokens,
 * session credentials, or a raw login name for an attempt. The chain makes partial edits detectable; it does not stop
 * someone with write access to the directory from rewriting the whole chain unless its head hash is anchored elsewhere.
 *
 * Best effort: a failed write goes to stderr (no secrets in the line) and never blocks or fails the sign-in itself.
 */
export interface AuthLogEvent {
  readonly event: AuthEventType;
  readonly result: AuditResult;
  readonly accountId?: string;
  /** Keyed hash of the login name (see `FsAttemptStore.keyed`). */
  readonly loginHash?: string;
  /** Keyed hash of the source address. */
  readonly sourceHash?: string;
  /** Small non-secret context: counts, reasons, versions. */
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
  /** Who performed an operator action (an operator label, never a secret). */
  readonly operator?: string;
}

export class AuthLog {
  readonly log: FsAuditLog;

  constructor(baseDir: string, now?: () => Date) {
    this.log = new FsAuditLog(new LocalFsBlobStore(join(baseDir, 'auth-audit')), '__auth__', now);
  }

  async record(e: AuthLogEvent): Promise<void> {
    try {
      await this.log.append({
        event: e.event,
        result: e.result,
        actor: {
          identityId: e.operator ?? e.accountId ?? 'anonymous',
          kind: e.operator !== undefined || e.accountId === undefined ? 'system' : 'user',
        },
        ...(e.accountId !== undefined ? { target: { kind: 'account', id: e.accountId } } : {}),
        detail: {
          ...(e.loginHash !== undefined ? { loginHash: e.loginHash } : {}),
          ...(e.sourceHash !== undefined ? { sourceHash: e.sourceHash } : {}),
          ...(e.detail ?? {}),
        },
      });
    } catch (cause) {
      process.stderr.write(`[xo-api] auth audit write failed (${e.event}): ${cause instanceof Error ? cause.name : 'error'}\n`);
    }
  }
}
