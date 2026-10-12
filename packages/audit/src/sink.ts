import { randomUUID } from 'node:crypto';
import { AuditError, ErrorCode } from '@xo/errors';
import { err, ok, type Result } from '@xo/types';
import { AUDIT_CLASSIFICATION, AUDIT_SCHEMA_VERSION, validateDraft, type AuditEvent, type AuditEventDraft } from './event.js';
import { mintReceipt, type DurableReceipt } from './receipt.js';

export type AppendResult =
  | { readonly ok: true; readonly receipt: DurableReceipt; readonly event: AuditEvent }
  | {
      readonly ok: false;
      readonly error: AuditError;
      /**
       * True when the failure happened AFTER bytes may have reached the file (write/fsync error): the event might
       * or might not be on disk. A retry should carry an `idempotencyKey` so a landed event is not duplicated.
       */
      readonly indeterminate: boolean;
    };

/**
 * The audit port. `append` NEVER throws and NEVER returns a receipt unless the adapter confirmed the write at the
 * guarantee the receipt names. Producing code depends only on this interface.
 */
export interface AuditSink {
  /** `durable`: a real, confirmed-durable adapter. `non-production`: volatile, explicit dev/test mode. */
  readonly mode: 'durable' | 'non-production';
  append(draft: AuditEventDraft): Promise<AppendResult>;
}

/** Shared event construction: the ONLY place trusted fields (id, seq, time, retention, classification) are set. */
export function buildEvent(
  draft: AuditEventDraft,
  trusted: { readonly eventId: string; readonly seq: number; readonly recordedAt: string; readonly retainUntil: string },
): AuditEvent {
  return Object.freeze({
    schemaVersion: AUDIT_SCHEMA_VERSION,
    eventId: trusted.eventId,
    seq: trusted.seq,
    recordedAt: trusted.recordedAt,
    retainUntil: trusted.retainUntil,
    classification: AUDIT_CLASSIFICATION,
    type: draft.type,
    action: draft.action,
    outcome: draft.outcome,
    actor: {
      kind: draft.actor.kind,
      ...(draft.actor.id !== undefined ? { id: draft.actor.id } : {}),
      ...(draft.actor.orgId !== undefined ? { orgId: draft.actor.orgId } : {}),
    },
    ...(draft.target !== undefined ? { target: { ...draft.target } } : {}),
    ...(draft.correlationId !== undefined ? { correlationId: draft.correlationId } : {}),
    ...(draft.executionId !== undefined ? { executionId: draft.executionId } : {}),
    ...(draft.reasonCode !== undefined ? { reasonCode: draft.reasonCode } : {}),
    ...(draft.metadata !== undefined ? { metadata: { ...draft.metadata } } : {}),
    ...(draft.idempotencyKey !== undefined ? { idempotencyKey: draft.idempotencyKey } : {}),
  });
}

/**
 * EXPLICIT NON-PRODUCTION sink: events live in process memory only. Its receipts say `volatile-memory`, and the
 * API layer refuses to treat them as durable unless it was itself started in non-production mode. Exists so
 * development and tests run without a configured store; it can never be mistaken for the real thing.
 */
export class NonProductionAuditSink implements AuditSink {
  readonly mode = 'non-production' as const;
  private readonly stored: AuditEvent[] = [];
  private seq = 0;
  constructor(private readonly clock: () => Date = () => new Date()) {}

  async append(draft: AuditEventDraft): Promise<AppendResult> {
    const valid = validateDraft(draft);
    if (!valid.ok) return { ok: false, error: valid.error, indeterminate: false };
    const key = valid.value.idempotencyKey;
    if (key !== undefined) {
      const existing = this.stored.find((e) => e.idempotencyKey === key);
      if (existing !== undefined) return { ok: true, event: existing, receipt: this.receiptFor(existing) };
    }
    const now = this.clock();
    const event = buildEvent(valid.value, {
      eventId: randomUUID(),
      seq: ++this.seq,
      recordedAt: now.toISOString(),
      retainUntil: now.toISOString(),
    });
    this.stored.push(event);
    return { ok: true, event, receipt: this.receiptFor(event) };
  }

  private receiptFor(event: AuditEvent): DurableReceipt {
    return mintReceipt({
      eventId: event.eventId,
      seq: event.seq,
      storeId: 'non-production-memory',
      recordedAt: event.recordedAt,
      guarantee: 'volatile-memory',
    });
  }

  /** Test/inspection helper (a copy; callers cannot mutate stored events). */
  events(): readonly AuditEvent[] {
    return [...this.stored];
  }
}

export interface AuditConfigEnv {
  readonly NODE_ENV?: string | undefined;
  readonly XO_AUDIT_DIR?: string | undefined;
  readonly XO_AUDIT_RETENTION_DAYS?: string | undefined;
  readonly XO_AUDIT_MIN_RETENTION_DAYS?: string | undefined;
}
export type AuditConfig =
  | { readonly mode: 'durable'; readonly dir: string; readonly defaultRetentionMs: number; readonly minimumRetentionMs: number }
  | { readonly mode: 'non-production' };

const DAY_MS = 86_400_000;

function parseDays(name: string, raw: string): Result<number, AuditError> {
  const n = Number(raw);
  if (!/^\d+(\.\d+)?$/.test(raw.trim()) || !Number.isFinite(n) || n <= 0)
    return err(new AuditError(ErrorCode.AUDIT_CONFIG_INVALID, `${name} must be a positive number of days`));
  return ok(Math.round(n * DAY_MS));
}

/**
 * Startup policy for audit storage. NO retention period is defaulted or invented: an operator must state one.
 *  - all three variables set  -> durable mode (default retention must be >= minimum retention);
 *  - none set, NODE_ENV != production -> explicit non-production mode (volatile; callers must log it loudly);
 *  - anything else (partial config, or production with none) -> startup FAILS with AUDIT_CONFIG_INVALID.
 */
export function resolveAuditConfig(env: AuditConfigEnv): Result<AuditConfig, AuditError> {
  const dir = env.XO_AUDIT_DIR?.trim();
  const ret = env.XO_AUDIT_RETENTION_DAYS?.trim();
  const min = env.XO_AUDIT_MIN_RETENTION_DAYS?.trim();
  const set = [dir, ret, min].filter((v) => v !== undefined && v !== '').length;
  if (set === 0) {
    if (env.NODE_ENV === 'production')
      return err(
        new AuditError(
          ErrorCode.AUDIT_CONFIG_INVALID,
          'production requires XO_AUDIT_DIR, XO_AUDIT_RETENTION_DAYS and XO_AUDIT_MIN_RETENTION_DAYS (no retention is assumed)',
        ),
      );
    return ok({ mode: 'non-production' });
  }
  if (set !== 3 || dir === undefined || ret === undefined || min === undefined)
    return err(
      new AuditError(
        ErrorCode.AUDIT_CONFIG_INVALID,
        'XO_AUDIT_DIR, XO_AUDIT_RETENTION_DAYS and XO_AUDIT_MIN_RETENTION_DAYS must all be set together',
      ),
    );
  const r = parseDays('XO_AUDIT_RETENTION_DAYS', ret);
  if (!r.ok) return r;
  const m = parseDays('XO_AUDIT_MIN_RETENTION_DAYS', min);
  if (!m.ok) return m;
  if (r.value < m.value)
    return err(new AuditError(ErrorCode.AUDIT_CONFIG_INVALID, 'XO_AUDIT_RETENTION_DAYS must be >= XO_AUDIT_MIN_RETENTION_DAYS'));
  return ok({ mode: 'durable', dir, defaultRetentionMs: r.value, minimumRetentionMs: m.value });
}
