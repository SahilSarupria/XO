import { createHash } from 'node:crypto';
import { ErrorCode, XoError } from '@xo/errors';
import { WorkflowConflictError, type WorkflowExecutionRecord } from './workflow-execution.js';

/**
 * Idempotent workflow start (`Idempotency-Key` request header on `POST .../workflows/:id/executions`).
 *
 * Design — deliberately no new storage: the key deterministically derives the workflow execution id
 *   id = "wfx_" + first 32 hex of sha256(["start-workflow", workspaceId, principalId, key])
 * so the run's own persisted record IS the idempotency record. A retry with the same key finds that
 * record and returns it instead of creating a second run. Because the principal and workspace are inside
 * the hash, one caller can never collide with, replay, or learn about another caller's key, and the
 * operation name keeps the key space distinct from any future keyed operation.
 *
 * What this does and does not guarantee (see also the OpenAPI description):
 *  - Persistence: durable for as long as the run record is (the same filesystem store as every run).
 *  - Window: a key is honoured for IDEMPOTENCY_WINDOW_MS after the run was created. A retry after that
 *    is refused (409 `idempotency_key_expired`) — it never silently creates a second run and never
 *    pretends to replay. Use a new key to start again.
 *  - Same key + a different request (workflow, compilation, or input) is refused (409
 *    `idempotency_key_reused`); nothing is created.
 *  - Concurrency: lookup-and-create runs inside the platform's existing per-execution-id in-process lock,
 *    so concurrent requests with one key in ONE API process yield one run. The lock does not span
 *    processes: if several API processes share one data directory, two simultaneous first requests could
 *    in principle both create. This is NOT an exactly-once guarantee across processes.
 *  - Authorization and validation run on EVERY request, before the lookup, so a replay is never a bypass.
 *  - A replay returns the run's CURRENT state (it may have moved on since the first response).
 */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

/** Validates the raw header value. Absent => undefined (the unchanged, non-idempotent behaviour). */
export function parseIdempotencyKey(raw: string | readonly string[] | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string')
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'send the Idempotency-Key header at most once', {
      context: { reason: 'idempotency_key_invalid' },
    });
  if (!KEY_PATTERN.test(raw))
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'Idempotency-Key must be 8-128 characters from A-Z a-z 0-9 _ . : -', {
      context: { reason: 'idempotency_key_invalid' },
    });
  return raw;
}

export function idempotentWorkflowExecutionId(workspaceId: string, principalId: string, key: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(['start-workflow', workspaceId, principalId, key]))
    .digest('hex');
  return `wfx_${digest.slice(0, 32)}`;
}

/** Order-independent JSON so `{a:1,b:2}` and `{b:2,a:1}` count as the same input. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Throws the conflict that applies, or returns normally when `existing` is a legitimate replay of this request. */
export function assertLegitimateReplay(
  existing: WorkflowExecutionRecord,
  request: { readonly compilationId: string; readonly workflowId: string; readonly input: Readonly<Record<string, unknown>> },
  now: number = Date.now(),
): void {
  const same =
    existing.compilationId === request.compilationId &&
    existing.workflowId === request.workflowId &&
    canonical(existing.input) === canonical(request.input);
  if (!same)
    throw new WorkflowConflictError(
      'this Idempotency-Key was already used for a different start request; the original run was not changed and nothing new was created',
      'idempotency_key_reused',
      { workflowExecutionId: existing.workflowExecutionId },
    );
  const age = now - Date.parse(existing.createdAt);
  if (!(age <= IDEMPOTENCY_WINDOW_MS))
    throw new WorkflowConflictError(
      'this Idempotency-Key is older than the 24 hour idempotency window; nothing was created. Use a new key to start another run',
      'idempotency_key_expired',
      { workflowExecutionId: existing.workflowExecutionId },
    );
}
