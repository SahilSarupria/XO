import { randomUUID } from 'node:crypto';
import { assertAuthenticatedPrincipal, toPrincipalSnapshot, type AuthenticatedPrincipal } from '@xo/permissions';
import type { Result } from '@xo/types';
import { err, ok } from '@xo/types';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import type { BlobStore } from '@xo/storage';
import { isValidWorkflowExecutionId, StaleWorkflowRevisionError, type CreateWorkflowExecutionInput, type WorkflowExecutionRecord, type WorkflowExecutionStore } from './workflow-execution.js';

function metadataKey(workflowExecutionId: string): string {
  return `${workflowExecutionId}/metadata.json`;
}

/** Server-minted id — the caller may pre-mint one (so it can register the id as "actively driven" before the record exists, see `workflow-runner.ts`) via this exported function. */
export function mintWorkflowExecutionId(): string {
  return `wfx_${randomUUID().replace(/-/g, '')}`;
}

function decodeRecord(bytes: Uint8Array): WorkflowExecutionRecord | undefined {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as WorkflowExecutionRecord;
  } catch {
    return undefined;
  }
}

/** Same shape as `FsExecutionStore`/`FsCompilationStore` — one JSON metadata record per workflow execution, on the existing `BlobStore` abstraction (no second persistence mechanism). The record's `finalResult` lives inline: it is small by construction (step outputs are the capabilities' own small structured outputs), so no separate `result.json` is needed. */
export class FsWorkflowExecutionStore implements WorkflowExecutionStore {
  constructor(private readonly store: BlobStore) {}

  async create(workspaceId: string, principal: AuthenticatedPrincipal, input: CreateWorkflowExecutionInput): Promise<Result<WorkflowExecutionRecord, XoError>> {
    assertAuthenticatedPrincipal(principal); // fail closed
    if (!isValidWorkflowExecutionId(input.workflowExecutionId)) return err(new XoError(ErrorCode.INVALID_ARGUMENT, 'invalid workflow execution id'));
    if (await this.store.has(metadataKey(input.workflowExecutionId))) return err(new XoError(ErrorCode.ALREADY_EXISTS, `workflow execution "${input.workflowExecutionId}" already exists`));

    const now = new Date().toISOString();
    const record: WorkflowExecutionRecord = {
      workflowExecutionId: input.workflowExecutionId,
      workspaceId,
      identityId: principal.id,
      initiator: toPrincipalSnapshot(principal),
      compilationId: input.compilationId,
      workflowId: input.workflowId,
      workflowName: input.workflowName,
      revision: 0,
      status: 'created',
      input: input.input,
      steps: input.steps.map((s) => ({ stepId: s.stepId, order: s.order, capabilityId: s.capabilityId, capabilityName: s.capabilityName, status: 'pending' as const })),
      currentStepIndex: input.steps.length > 0 ? 0 : null,
      completedStepExecutionIds: [],
      createdAt: now,
      updatedAt: now,
      provenance: {
        compilationId: input.compilationId,
        ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
        ...(input.sourceDigestSha256 !== undefined ? { sourceDigestSha256: input.sourceDigestSha256 } : {}),
        workflowId: input.workflowId,
        ...(input.graphHash !== undefined ? { graphHash: input.graphHash } : {}),
        steps: input.steps.map((s) => ({ order: s.order, capabilityId: s.capabilityId })),
      },
    };
    const put = await this.store.put(metadataKey(record.workflowExecutionId), JSON.stringify(record), { contentType: 'application/json' });
    if (!put.ok) return err(put.error);
    return ok(record);
  }

  async get(workflowExecutionId: string): Promise<Result<WorkflowExecutionRecord, NotFoundError>> {
    if (!isValidWorkflowExecutionId(workflowExecutionId)) return err(new NotFoundError(`workflow execution "${workflowExecutionId}"`));
    const raw = await this.store.get(metadataKey(workflowExecutionId));
    if (!raw.ok) return err(new NotFoundError(`workflow execution "${workflowExecutionId}"`));
    const record = decodeRecord(raw.value);
    if (record === undefined) return err(new NotFoundError(`workflow execution "${workflowExecutionId}" (stored record is corrupt)`));
    return ok(record);
  }

  async list(): Promise<Result<readonly WorkflowExecutionRecord[], XoError>> {
    const listed = await this.store.list();
    if (!listed.ok) {
      if (listed.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return ok([]);
      return err(listed.error);
    }
    const records: WorkflowExecutionRecord[] = [];
    for (const key of listed.value) {
      if (!key.endsWith('/metadata.json')) continue;
      const raw = await this.store.get(key);
      if (!raw.ok) continue;
      const record = decodeRecord(raw.value);
      if (record !== undefined) records.push(record);
    }
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return ok(records);
  }

  /**
   * Compare-and-swap on `revision` (see `WorkflowExecutionStore.save`'s
   * doc comment). Filesystem-level honesty: this is read → compare →
   * write on a plain `BlobStore`; within one process it is made safe by
   * the caller's `withExecutionLock`, and this check additionally makes a
   * lost-update from any un-locked/other writer FAIL deterministically
   * rather than silently overwrite. It is NOT a distributed transaction
   * — two processes racing between the compare and the write could still
   * interleave; that is out of scope (no distributed locks in P0.8).
   */
  async save(next: WorkflowExecutionRecord, expectedRevision: number): Promise<Result<WorkflowExecutionRecord, XoError>> {
    if (next.revision !== expectedRevision + 1) return err(new XoError(ErrorCode.INVALID_ARGUMENT, `next.revision (${next.revision}) must equal expectedRevision + 1 (${expectedRevision + 1})`));
    const current = await this.get(next.workflowExecutionId);
    if (!current.ok) return err(current.error);
    if (current.value.revision !== expectedRevision) return err(new StaleWorkflowRevisionError(next.workflowExecutionId, expectedRevision, current.value.revision));
    const put = await this.store.put(metadataKey(next.workflowExecutionId), JSON.stringify(next), { contentType: 'application/json' });
    if (!put.ok) return err(put.error);
    return ok(next);
  }
}
