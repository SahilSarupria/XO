import { AuditError, ErrorCode } from '@xo/errors';
import { auditContentDigest, type AuditEventDraft } from './event.js';

/**
 * INTERNAL. The idempotency, conflict and lifecycle rules shared by every store that enforces them (the chained store
 * and the non-production sink). Kept separate from storage so implementations cannot drift:
 *  - exact retry (same key, same content) -> the ORIGINAL entry, nothing new is written (`duplicate`);
 *  - same key, different content -> `AUDIT_CONFLICT`; a contradictory event is never stored;
 *  - lifecycle (when the draft declares one): a terminal needs an accepted attempt for the same operation, an operation
 *    has at most ONE terminal (a second one under a different key is a conflict), and an attempt cannot follow its terminal.
 */
export type Decision<E> =
  | { readonly kind: 'append'; readonly digest: string }
  | { readonly kind: 'duplicate'; readonly entry: E }
  | { readonly kind: 'rejected'; readonly error: AuditError };

const reject = (code: typeof ErrorCode.AUDIT_CONFLICT | typeof ErrorCode.AUDIT_ORDER_VIOLATION, message: string): Decision<never> => ({
  kind: 'rejected',
  error: new AuditError(code, message),
});

export class AuditSemantics<E> {
  private readonly byKey = new Map<string, { readonly digest: string; readonly entry: E }>();
  private readonly attempts = new Set<string>();
  private readonly terminals = new Map<string, string>();

  decide(draft: AuditEventDraft): Decision<E> {
    const digest = auditContentDigest(draft);
    const key = draft.idempotencyKey;
    if (key !== undefined) {
      const existing = this.byKey.get(key);
      if (existing !== undefined) {
        return existing.digest === digest
          ? { kind: 'duplicate', entry: existing.entry }
          : reject(ErrorCode.AUDIT_CONFLICT, 'an event with this idempotency key was already accepted with different content');
      }
    }
    const l = draft.lifecycle;
    if (l !== undefined) {
      if (l.phase === 'terminal') {
        if (!this.attempts.has(l.operationId))
          return reject(ErrorCode.AUDIT_ORDER_VIOLATION, 'a terminal event requires an accepted attempt for the same operation');
        if (this.terminals.has(l.operationId)) return reject(ErrorCode.AUDIT_CONFLICT, 'this operation already has a terminal event');
      }
      if (l.phase === 'attempt' && this.terminals.has(l.operationId))
        return reject(ErrorCode.AUDIT_ORDER_VIOLATION, 'an attempt cannot follow the terminal event of its operation');
    }
    return { kind: 'append', digest };
  }

  /** Call only after the event is accepted by the backend (durably, for a durable backend). */
  commit(draft: AuditEventDraft, digest: string, entry: E): void {
    if (draft.idempotencyKey !== undefined) this.byKey.set(draft.idempotencyKey, { digest, entry });
    const l = draft.lifecycle;
    if (l?.phase === 'attempt') this.attempts.add(l.operationId);
    if (l?.phase === 'terminal') this.terminals.set(l.operationId, draft.idempotencyKey ?? l.operationId);
  }

  /** Operations with an accepted attempt and no terminal event: their outcome is unknown and warrants investigation. */
  openAttempts(): readonly string[] {
    return [...this.attempts].filter((op) => !this.terminals.has(op)).sort();
  }
}
