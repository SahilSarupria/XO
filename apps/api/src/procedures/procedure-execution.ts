import { randomUUID } from 'node:crypto';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { err, ok, type Result } from '@xo/types';
import type { AtomicBlobStore } from '@xo/storage';

/**
 * P1.1 M3 — persisted procedure execution. One record per execution, replaced atomically (temp + rename: a reader sees the
 * previous or the next complete record, never a truncated one) under a revision check (compare-and-set inside this process).
 * Failure classes are stable strings; an `error` message never contains a submitted value.
 */
export const PROCEDURE_EXECUTION_SCHEMA = 1 as const;

export type ProcedureExecutionStatus = 'running' | 'waiting_for_human' | 'completed' | 'failed';
export type ProcedureStepStatus = 'pending' | 'running' | 'succeeded' | 'waiting_for_human' | 'failed' | 'skipped';
export type ProcedureFailureClass =
  | 'authorization'
  | 'stale_binding'
  | 'input_invalid'
  | 'capability_error'
  | 'timeout'
  | 'failed_postcondition'
  | 'human_rejected'
  | 'internal';

export interface ProcedureStepState {
  readonly stepId: string;
  readonly capabilityId: string;
  readonly status: ProcedureStepStatus;
  /** The per-step capability `ExecutionRecord` (it owns the human task for a human-in-the-loop step). */
  readonly executionId?: string;
  readonly completedAt?: string;
  readonly failureClass?: ProcedureFailureClass;
  readonly errorCode?: string;
  /** Why a `waiting_for_human` step is waiting, when it is not a human task: a payload-mode external step awaiting a human's approval of its exact input. */
  readonly waitingReason?: 'payload_approval';
}

export interface ProcedureExecutionRecord {
  readonly schemaVersion: typeof PROCEDURE_EXECUTION_SCHEMA;
  readonly procedureExecutionId: string;
  readonly workspaceId: string;
  readonly procedureId: string;
  readonly version: number;
  /** Pinned at start: the immutable definition this execution runs. */
  readonly procedureHash: string;
  readonly initiator: { readonly kind: 'human' | 'service'; readonly id: string };
  readonly revision: number;
  readonly status: ProcedureExecutionStatus;
  readonly input: Readonly<Record<string, unknown>>;
  /** Step outputs by step id (the data other steps' bindings and conditions read). */
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly steps: readonly ProcedureStepState[];
  readonly waitingStepId?: string;
  readonly failure?: { readonly class: ProcedureFailureClass; readonly code: string };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export type ProcedureConflictReason = 'stale_revision' | 'terminal' | 'not_waiting' | 'stale_step_execution' | 'in_flight';

/** Maps to HTTP 409 (`RUNTIME_SESSION_INVALID_STATE`), like the workflow conflicts. */
export class ProcedureConflictError extends XoError {
  constructor(
    message: string,
    readonly reason: ProcedureConflictReason,
    context: Readonly<Record<string, unknown>> = {},
  ) {
    super(ErrorCode.RUNTIME_SESSION_INVALID_STATE, message, { context: { reason, ...context } });
    this.name = 'ProcedureConflictError';
  }
}

export const mintProcedureExecutionId = (): string => `pex_${randomUUID().replace(/-/g, '')}`;
export const isValidProcedureExecutionId = (id: string | undefined): id is string => id !== undefined && /^pex_[0-9a-f]{32}$/.test(id);

const STATUSES = new Set(['running', 'waiting_for_human', 'completed', 'failed']);
const STEP_STATUSES = new Set(['pending', 'running', 'succeeded', 'waiting_for_human', 'failed', 'skipped']);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Strict re-verification on read: anything unexpected makes the record `undefined` (treated as corrupt, never trusted). */
export function parseExecutionRecord(raw: unknown, expectedId: string, workspaceId: string): ProcedureExecutionRecord | undefined {
  if (!isObj(raw)) return undefined;
  if (raw['schemaVersion'] !== PROCEDURE_EXECUTION_SCHEMA) return undefined;
  if (raw['procedureExecutionId'] !== expectedId || raw['workspaceId'] !== workspaceId) return undefined;
  if (typeof raw['procedureId'] !== 'string' || typeof raw['procedureHash'] !== 'string') return undefined;
  if (typeof raw['version'] !== 'number' || !Number.isInteger(raw['version']) || typeof raw['revision'] !== 'number') return undefined;
  if (typeof raw['status'] !== 'string' || !STATUSES.has(raw['status'])) return undefined;
  if (!isObj(raw['initiator']) || (raw['initiator']['kind'] !== 'human' && raw['initiator']['kind'] !== 'service')) return undefined;
  if (!isObj(raw['input']) || !isObj(raw['outputs']) || !Array.isArray(raw['steps'])) return undefined;
  if (typeof raw['createdAt'] !== 'string' || typeof raw['updatedAt'] !== 'string') return undefined;
  for (const s of raw['steps']) {
    if (!isObj(s) || typeof s['stepId'] !== 'string' || typeof s['capabilityId'] !== 'string') return undefined;
    if (typeof s['status'] !== 'string' || !STEP_STATUSES.has(s['status'])) return undefined;
  }
  return raw as unknown as ProcedureExecutionRecord;
}

const locks = new Map<string, Promise<unknown>>();
async function serialized<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(id, tail);
  try {
    return await run;
  } finally {
    if (locks.get(id) === tail) locks.delete(id);
  }
}

export class FsProcedureExecutionStore {
  constructor(
    private readonly store: AtomicBlobStore,
    private readonly workspaceId: string,
  ) {}

  private key(id: string): string {
    return `${id}.json`;
  }

  async create(record: ProcedureExecutionRecord): Promise<Result<ProcedureExecutionRecord, XoError>> {
    if (!isValidProcedureExecutionId(record.procedureExecutionId))
      return err(new XoError(ErrorCode.INVALID_ARGUMENT, 'invalid procedure execution id'));
    const put = await this.store.putIfAbsent(this.key(record.procedureExecutionId), JSON.stringify(record), {
      contentType: 'application/json',
    });
    if (!put.ok) return err(put.error);
    if (!put.value.created) return err(new XoError(ErrorCode.ALREADY_EXISTS, 'procedure execution already exists'));
    return ok(record);
  }

  async get(id: string): Promise<Result<ProcedureExecutionRecord, NotFoundError>> {
    const notFound = new NotFoundError('procedure execution');
    if (!isValidProcedureExecutionId(id)) return err(notFound);
    const raw = await this.store.get(this.key(id));
    if (!raw.ok) return err(notFound);
    try {
      const parsed = parseExecutionRecord(JSON.parse(new TextDecoder().decode(raw.value)), id, this.workspaceId);
      return parsed === undefined ? err(new NotFoundError('procedure execution (stored record is corrupt)')) : ok(parsed);
    } catch {
      return err(new NotFoundError('procedure execution (stored record is corrupt)'));
    }
  }

  /** Compare-and-set on `revision`: a writer holding a stale record gets `ProcedureConflictError('stale_revision')` and writes nothing. */
  async save(next: ProcedureExecutionRecord, expectedRevision: number): Promise<ProcedureExecutionRecord> {
    return serialized(next.procedureExecutionId, async () => {
      const current = await this.get(next.procedureExecutionId);
      if (!current.ok) throw current.error;
      if (current.value.revision !== expectedRevision) {
        throw new ProcedureConflictError(
          `procedure execution was modified concurrently: expected revision ${expectedRevision}, stored revision is ${current.value.revision}`,
          'stale_revision',
        );
      }
      const written = await this.store.replace(this.key(next.procedureExecutionId), JSON.stringify(next), {
        contentType: 'application/json',
      });
      if (!written.ok) throw written.error;
      return next;
    });
  }
}
