import { randomUUID } from 'node:crypto';
import type { BlobStore } from '@xo/storage';
import { ErrorCode, XoError } from '@xo/errors';
import type { DefinitionInput, WorkflowDefinition } from './definition.js';

export const DEFINITION_ID = /^wfd_[0-9a-f]{32}$/;
export const MAX_DEFINITIONS = 200;
const key = (id: string) => `workflow-definitions/${id}.json`;
const queues = new Map<string, Promise<unknown>>();

export class StaleDefinitionError extends XoError {
  constructor(expected: number, actual: number) {
    super(
      ErrorCode.PRECONDITION_FAILED,
      `this workflow was changed by someone else (expected revision ${expected}, current is ${actual}); reload and retry`,
      {
        context: { expectedRevision: expected, currentRevision: actual, reason: 'stale_revision' },
      },
    );
  }
}

export class FsDefinitionStore {
  constructor(
    private readonly store: BlobStore,
    private readonly workspaceId: string,
  ) {}

  private locked<T>(id: string, work: () => Promise<T>): Promise<T> {
    const k = `${this.workspaceId}/${id}`;
    const previous = queues.get(k) ?? Promise.resolve();
    const run = previous.then(work);
    queues.set(
      k,
      run.catch(() => undefined),
    );
    return run;
  }

  async get(id: string): Promise<WorkflowDefinition | undefined> {
    if (!DEFINITION_ID.test(id)) return undefined;
    const raw = await this.store.get(key(id));
    if (!raw.ok) {
      if (raw.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return undefined;
      throw raw.error;
    }
    try {
      return JSON.parse(new TextDecoder().decode(raw.value)) as WorkflowDefinition;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<readonly WorkflowDefinition[]> {
    const listed = await this.store.list('workflow-definitions/');
    if (!listed.ok) {
      if (listed.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return [];
      throw listed.error;
    }
    const out: WorkflowDefinition[] = [];
    for (const k of listed.value) {
      const m = /^workflow-definitions\/(wfd_[0-9a-f]{32})\.json$/.exec(k);
      const d = m === null ? undefined : await this.get(m[1] as string);
      if (d !== undefined) out.push(d);
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  private async put(d: WorkflowDefinition): Promise<void> {
    const r = await this.store.put(key(d.definitionId), JSON.stringify(d), { contentType: 'application/json' });
    if (!r.ok) throw r.error;
  }

  async create(input: DefinitionInput, by: string, now: Date): Promise<WorkflowDefinition> {
    const d: WorkflowDefinition = {
      definitionId: `wfd_${randomUUID().replace(/-/g, '')}`,
      workspaceId: this.workspaceId,
      name: input.name,
      status: 'draft',
      revision: 1,
      nodes: input.nodes,
      edges: input.edges,
      createdAt: now.toISOString(),
      createdBy: by,
      updatedAt: now.toISOString(),
      updatedBy: by,
    };
    await this.put(d);
    return d;
  }

  /** Whole-definition replace, guarded by `expectedRevision` (the editor's Save). */
  replace(
    id: string,
    input: DefinitionInput,
    expectedRevision: number | undefined,
    by: string,
    now: Date,
  ): Promise<WorkflowDefinition | undefined> {
    return this.locked(id, async () => {
      const current = await this.get(id);
      if (current === undefined) return undefined;
      if (expectedRevision !== undefined && expectedRevision !== current.revision)
        throw new StaleDefinitionError(expectedRevision, current.revision);
      const next: WorkflowDefinition = {
        ...current,
        name: input.name,
        nodes: input.nodes,
        edges: input.edges,
        revision: current.revision + 1,
        updatedAt: now.toISOString(),
        updatedBy: by,
      };
      await this.put(next);
      return next;
    });
  }

  async delete(id: string): Promise<boolean> {
    if (!DEFINITION_ID.test(id)) return false;
    const r = await this.store.delete(key(id));
    return r.ok;
  }
}
