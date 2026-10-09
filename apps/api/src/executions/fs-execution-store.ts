import { randomUUID } from 'node:crypto';
import { assertAuthenticatedPrincipal, toPrincipalSnapshot, type AuthenticatedPrincipal } from '@xo/permissions';
import type { Result } from '@xo/types';
import { err, ok } from '@xo/types';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import type { BlobStore } from '@xo/storage';
import {
  isValidExecutionId,
  type CreateExecutionInput,
  type ExecutionOutcomeInput,
  type ExecutionRecord,
  type ExecutionStore,
  type ResolveHumanTaskInput,
  type ResolveHumanTaskFailure,
} from './execution.js';

function metadataKey(executionId: string): string {
  return `${executionId}/metadata.json`;
}

function mintExecutionId(): string {
  return `exe_${randomUUID().replace(/-/g, '')}`;
}

function decodeRecord(bytes: Uint8Array): ExecutionRecord | undefined {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as ExecutionRecord;
  } catch {
    return undefined;
  }
}

/** Same shape as `FsCompilationStore`/`FsSourceStore` — one JSON metadata record per execution. No separate `result.json` here: unlike a compilation's full capability projection, an execution's `output` is already small (see `ExecutionRecord.input`'s doc comment) and lives directly on the one record. */
export class FsExecutionStore implements ExecutionStore {
  constructor(private readonly store: BlobStore) {}

  async create(workspaceId: string, principal: AuthenticatedPrincipal, input: CreateExecutionInput): Promise<Result<ExecutionRecord, XoError>> {
    assertAuthenticatedPrincipal(principal); // fail closed: only an authenticated principal may initiate
    let executionId = mintExecutionId();
    let attempts = 0;
    while (await this.store.has(metadataKey(executionId))) {
      if (++attempts > 5) return err(new XoError(ErrorCode.UNKNOWN, 'could not mint a unique execution id'));
      executionId = mintExecutionId();
    }

    const record: ExecutionRecord = {
      executionId,
      workspaceId,
      identityId: principal.id,
      initiator: toPrincipalSnapshot(principal),
      compilationId: input.compilationId,
      capabilityId: input.capabilityId,
      status: 'failed', // placeholder until `complete()` — see doc comment below
      requestedAt: new Date().toISOString(),
      input: input.input,
      errorCode: ErrorCode.UNKNOWN,
      errorMessage: 'execution record created but not yet completed',
    };

    const put = await this.store.put(metadataKey(executionId), JSON.stringify(record), { contentType: 'application/json' });
    if (!put.ok) return err(put.error);
    return ok(record);
  }

  async complete(executionId: string, outcome: ExecutionOutcomeInput): Promise<Result<ExecutionRecord, XoError>> {
    const found = await this.get(executionId);
    if (!found.ok) return err(found.error);

    const { errorCode: _errorCode, errorMessage: _errorMessage, output: _output, contractId: _contractId, bindingId: _bindingId, ...baseWithoutOutcomeFields } = found.value;
    const completedAt = new Date().toISOString();

    const record: ExecutionRecord =
      outcome.status === 'failed'
        ? { ...baseWithoutOutcomeFields, completedAt, status: 'failed', errorCode: outcome.errorCode, errorMessage: outcome.errorMessage }
        : {
            ...baseWithoutOutcomeFields,
            completedAt,
            status: outcome.status,
            output: outcome.output,
            ...(outcome.contractId !== undefined ? { contractId: outcome.contractId } : {}),
            ...(outcome.bindingId !== undefined ? { bindingId: outcome.bindingId } : {}),
            ...(outcome.sourceXoirNodeIds !== undefined ? { sourceXoirNodeIds: outcome.sourceXoirNodeIds } : {}),
            ...(outcome.graphHash !== undefined ? { graphHash: outcome.graphHash } : {}),
            ...(outcome.contractContentHash !== undefined ? { contractContentHash: outcome.contractContentHash } : {}),
            // A `waiting_for_human` execution becomes a pending human
            // task at the exact moment it's completed — no separate
            // "create the human task" step, since this execution IS the
            // human task (see `HumanTaskInfo`'s doc comment).
            ...(outcome.status === 'waiting_for_human' ? { humanTask: { status: 'pending' as const } } : {}),
          };

    const put = await this.store.put(metadataKey(executionId), JSON.stringify(record), { contentType: 'application/json' });
    if (!put.ok) return err(put.error);
    return ok(record);
  }

  async get(executionId: string): Promise<Result<ExecutionRecord, NotFoundError>> {
    if (!isValidExecutionId(executionId)) return err(new NotFoundError(`execution "${executionId}"`));
    const raw = await this.store.get(metadataKey(executionId));
    if (!raw.ok) return err(new NotFoundError(`execution "${executionId}"`));
    const record = decodeRecord(raw.value);
    if (record === undefined) return err(new NotFoundError(`execution "${executionId}" (stored record is corrupt)`));
    return ok(record);
  }

  async list(): Promise<Result<readonly ExecutionRecord[], XoError>> {
    const listed = await this.store.list();
    if (!listed.ok) {
      if (listed.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return ok([]);
      return err(listed.error);
    }
    const records: ExecutionRecord[] = [];
    for (const key of listed.value) {
      if (!key.endsWith('/metadata.json')) continue;
      const raw = await this.store.get(key);
      if (!raw.ok) continue;
      const record = decodeRecord(raw.value);
      if (record !== undefined) records.push(record);
    }
    records.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
    return ok(records);
  }

  async resolveHumanTask(executionId: string, input: ResolveHumanTaskInput): Promise<Result<ExecutionRecord | ResolveHumanTaskFailure, NotFoundError>> {
    const found = await this.get(executionId);
    if (!found.ok) return err(found.error);
    const record = found.value;

    if (record.humanTask === undefined) return ok({ kind: 'not_a_human_task' });
    if (record.humanTask.status === 'resolved') return ok({ kind: 'already_resolved', record });

    const humanTask = {
      status: 'resolved' as const,
      decision: input.decision,
      ...(input.decisionData !== undefined ? { decisionData: input.decisionData } : {}),
      resolvedAt: new Date().toISOString(),
      resolverIdentityId: input.resolverIdentityId,
      resolver: input.resolver,
      resumeOutcome: input.resumeOutcome,
    };

    // As of P0.7, resolving a human task is a REAL resume — the
    // execution's own top-level status/output/error fields update in
    // the SAME write to reflect it, not just `humanTask`. `unsupported`
    // is the one outcome that leaves the execution's own fields
    // unchanged (still `waiting_for_human`, still the original
    // escalation as `output`) — genuinely nothing about the execution
    // itself changed in that narrow residual case (see
    // `resume-human-task.ts`).
    const { errorCode: _errorCode, errorMessage: _errorMessage, ...recordWithoutErrorFields } = record;
    const outcome = input.resumeOutcome;
    const updated: ExecutionRecord =
      outcome.kind === 'succeeded'
        ? { ...recordWithoutErrorFields, humanTask, status: 'succeeded', output: outcome.output }
        : outcome.kind === 'rejected'
          ? { ...recordWithoutErrorFields, humanTask, status: 'rejected', output: outcome.output }
          : outcome.kind === 'failed'
            ? { ...recordWithoutErrorFields, humanTask, status: 'failed', errorCode: outcome.errorCode, errorMessage: outcome.errorMessage }
            : { ...record, humanTask }; // 'unsupported' — execution fields untouched, only humanTask changes

    const put = await this.store.put(metadataKey(executionId), JSON.stringify(updated), { contentType: 'application/json' });
    if (!put.ok) return err(new NotFoundError(`could not persist resolution for execution "${executionId}": ${put.error.message}`));
    return ok(updated);
  }
}
