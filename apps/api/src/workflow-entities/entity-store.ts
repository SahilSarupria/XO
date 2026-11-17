import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalFsBlobStore } from '@xo/storage';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import {
  MAX_WORKFLOWS_PER_WORKSPACE,
  WORKFLOW_ENTITY_SCHEMA,
  WORKFLOW_ID,
  type Actor,
  type WorkflowEntity,
  type WorkflowEventKind,
} from './entity.js';

/**
 * UW-2 (ADR 0032) — durable storage for Workflow entities, under `<data>/<workspace>/workflow-entities/`:
 *
 *   <workflowId>/r000001.json, r000002.json, …   one immutable snapshot per revision (atomic create-if-absent)
 *   changes.log                                    the workspace's change feed (append-only JSON lines)
 *
 * Revisions are compare-and-swap by construction: revision n+1 is created with `putIfAbsent` (temp file + `link`), which only
 * one writer can win, in this process or another. A writer that loses re-reads and, unless the caller pinned an expected
 * revision, re-applies its change on top of the winner's.
 *
 * The change feed's cursor is a byte offset into `changes.log`. Each line is appended with one O_APPEND write, so concurrent
 * writers never interleave inside a line and offsets only grow; a reader that holds a cursor sees every change after it, in
 * order, across processes and restarts. A crash after a snapshot is written but before its feed line costs only the
 * notification: the snapshot (the truth) is already durable, and clients re-read on any change anyway.
 */

const REV = (n: number) => `r${String(n).padStart(6, '0')}.json`;
const REV_KEY = /^(wfl_[0-9a-f]{32})\/r(\d{6})\.json$/;
const MAX_WRITE_ATTEMPTS = 8;
const MAX_FEED_READ = 256 * 1024;

export class StaleWorkflowRevisionError extends XoError {
  constructor(workflowId: string, expected: number, actual: number) {
    super(
      ErrorCode.PRECONDITION_FAILED,
      `workflow ${workflowId} was changed by someone else (expected revision ${expected}, current is ${actual}); reload and retry`,
      { context: { workflowId, expectedRevision: expected, currentRevision: actual, reason: 'stale_revision' } },
    );
  }
}

export interface WorkflowChange {
  readonly at: string;
  readonly workflowId: string;
  /** `entity`: a new revision. `run`: a run of the workflow was started, decided or moved on. */
  readonly kind: 'entity' | 'run';
  readonly revision?: number;
  readonly event?: WorkflowEventKind;
  readonly runId?: string;
  readonly state?: string;
}

export interface ChangePage {
  readonly changes: readonly WorkflowChange[];
  /** Pass back as `cursor` to receive only what happened after this page. */
  readonly cursor: string;
}

export class FsWorkflowEntityStore {
  private readonly blobs: LocalFsBlobStore;
  private readonly feedPath: string;

  constructor(
    private readonly rootDir: string,
    private readonly workspaceId: string,
  ) {
    this.blobs = new LocalFsBlobStore(rootDir);
    this.feedPath = join(rootDir, 'changes.log');
  }

  /** The latest revision, or undefined (an unknown or malformed id; never distinguishes the two). */
  async get(workflowId: string): Promise<WorkflowEntity | undefined> {
    if (!WORKFLOW_ID.test(workflowId)) return undefined;
    const head = await this.headRevision(workflowId);
    return head === 0 ? undefined : this.read(workflowId, head);
  }

  async require(workflowId: string): Promise<WorkflowEntity> {
    const e = await this.get(workflowId);
    if (e === undefined) throw new NotFoundError(`workflow "${workflowId}"`);
    return e;
  }

  /** Every revision, oldest first: the entity's history. */
  async history(workflowId: string): Promise<readonly WorkflowEntity[]> {
    const head = await this.headRevision(workflowId);
    const out: WorkflowEntity[] = [];
    for (let r = 1; r <= head; r++) {
      const e = await this.read(workflowId, r);
      if (e !== undefined) out.push(e);
    }
    return out;
  }

  /** Every workflow's latest revision, most recently updated first. */
  async list(): Promise<readonly WorkflowEntity[]> {
    const heads = new Map<string, number>();
    const listed = await this.blobs.list();
    if (!listed.ok) return [];
    for (const k of listed.value) {
      const m = REV_KEY.exec(k);
      if (m === null) continue;
      const r = Number(m[2]);
      if (r > (heads.get(m[1] as string) ?? 0)) heads.set(m[1] as string, r);
    }
    const out: WorkflowEntity[] = [];
    for (const [id, r] of heads) {
      const e = await this.read(id, r);
      if (e !== undefined) out.push(e);
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.workflowId < b.workflowId ? 1 : -1));
  }

  async create(
    init: Omit<
      WorkflowEntity,
      'schema' | 'workflowId' | 'workspaceId' | 'revision' | 'updatedAt' | 'updatedBy' | 'event' | 'paused' | 'archived'
    >,
    now: Date,
  ): Promise<WorkflowEntity> {
    if ((await this.list()).length >= MAX_WORKFLOWS_PER_WORKSPACE)
      throw new XoError(
        ErrorCode.PRECONDITION_FAILED,
        `this workspace has reached the limit of ${MAX_WORKFLOWS_PER_WORKSPACE} workflows; archive is not deletion, so ask an administrator`,
      );
    const at = now.toISOString();
    const entity: WorkflowEntity = {
      schema: WORKFLOW_ENTITY_SCHEMA,
      workflowId: `wfl_${randomUUID().replace(/-/g, '')}`,
      workspaceId: this.workspaceId,
      revision: 1,
      name: init.name,
      origin: init.origin,
      versions: init.versions,
      paused: false,
      archived: false,
      updatedAt: at,
      updatedBy: init.origin.createdBy,
      event: { kind: 'created', at, by: init.origin.createdBy },
    };
    const put = await this.blobs.putIfAbsent(`${entity.workflowId}/${REV(1)}`, JSON.stringify(entity));
    if (!put.ok) throw put.error;
    if (!put.value.created) throw new XoError(ErrorCode.UNKNOWN, 'workflow id collision; retry');
    await this.publish({ at, workflowId: entity.workflowId, kind: 'entity', revision: 1, event: 'created' });
    return entity;
  }

  /**
   * Applies `change` to the latest revision and stores the result as the next one. With `expectedRevision`, a concurrent
   * change is refused (412); without it, the change is re-applied on top of whatever won.
   */
  async update(
    workflowId: string,
    expectedRevision: number | undefined,
    by: Actor,
    now: Date,
    change: (current: WorkflowEntity) => {
      readonly next: Partial<Pick<WorkflowEntity, 'name' | 'versions' | 'paused' | 'archived'>>;
      readonly kind: WorkflowEventKind;
      readonly detail?: Readonly<Record<string, string | number>>;
    },
  ): Promise<WorkflowEntity> {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const current = await this.require(workflowId);
      if (expectedRevision !== undefined && expectedRevision !== current.revision)
        throw new StaleWorkflowRevisionError(workflowId, expectedRevision, current.revision);
      const { next, kind, detail } = change(current);
      const at = now.toISOString();
      const entity: WorkflowEntity = {
        ...current,
        ...next,
        revision: current.revision + 1,
        updatedAt: at,
        updatedBy: by,
        event: { kind, at, by, ...(detail !== undefined ? { detail } : {}) },
      };
      const put = await this.blobs.putIfAbsent(`${workflowId}/${REV(entity.revision)}`, JSON.stringify(entity));
      if (!put.ok) throw put.error;
      if (put.value.created) {
        await this.publish({ at, workflowId, kind: 'entity', revision: entity.revision, event: kind });
        return entity;
      }
      if (expectedRevision !== undefined) throw new StaleWorkflowRevisionError(workflowId, expectedRevision, entity.revision);
    }
    throw new XoError(ErrorCode.PRECONDITION_FAILED, `workflow ${workflowId} is being changed by many writers at once; retry`);
  }

  /** Appends one change to the workspace feed (one O_APPEND write per line). Best effort: the snapshot is the truth. */
  async publish(change: WorkflowChange): Promise<void> {
    try {
      await mkdir(this.rootDir, { recursive: true });
      await appendFile(this.feedPath, `${JSON.stringify(change)}\n`, { flag: 'a' });
    } catch {
      // A lost notification never loses state; clients re-read the workflow itself.
    }
  }

  /** The end of the feed now: a client that starts here receives only later changes. */
  async feedEnd(): Promise<string> {
    return String(await this.feedSize());
  }

  /** Changes after `cursor` (a byte offset from an earlier page; absent = from the start), at most ~256 KiB per page. */
  async changesSince(cursor: string | undefined): Promise<ChangePage> {
    const from = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(from) || from < 0) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'cursor must come from an earlier page');
    const size = await this.feedSize();
    if (from > size) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'cursor is beyond the end of the feed');
    if (from === size) return { changes: [], cursor: String(size) };
    const length = Math.min(size - from, MAX_FEED_READ);
    const fh = await open(this.feedPath, 'r');
    let text: string;
    try {
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, from);
      text = buf.toString('utf8');
    } finally {
      await fh.close();
    }
    // Only whole lines: a page ends at its last newline, and the next page starts right after it.
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) return { changes: [], cursor: String(from) };
    const whole = text.slice(0, lastNl + 1);
    const changes: WorkflowChange[] = [];
    for (const line of whole.split('\n')) {
      if (line.length === 0) continue;
      try {
        changes.push(JSON.parse(line) as WorkflowChange);
      } catch {
        // a damaged line is skipped, never served
      }
    }
    return { changes, cursor: String(from + Buffer.byteLength(whole, 'utf8')) };
  }

  private async feedSize(): Promise<number> {
    try {
      return (await stat(this.feedPath)).size;
    } catch {
      return 0;
    }
  }

  private async headRevision(workflowId: string): Promise<number> {
    const listed = await this.blobs.list(workflowId);
    if (!listed.ok) return 0;
    let head = 0;
    for (const k of listed.value) {
      const m = REV_KEY.exec(k);
      if (m !== null && m[1] === workflowId) head = Math.max(head, Number(m[2]));
    }
    return head;
  }

  private async read(workflowId: string, revision: number): Promise<WorkflowEntity | undefined> {
    const raw = await this.blobs.get(`${workflowId}/${REV(revision)}`);
    if (!raw.ok) return undefined;
    try {
      const e = JSON.parse(new TextDecoder().decode(raw.value)) as WorkflowEntity;
      // A snapshot that is not this workspace's or not this id is never served.
      if (e.schema !== WORKFLOW_ENTITY_SCHEMA || e.workflowId !== workflowId || e.workspaceId !== this.workspaceId) return undefined;
      return e;
    } catch {
      return undefined;
    }
  }
}

export function workspaceWorkflowEntitiesStore(dataRootDir: string, workspaceId: string): FsWorkflowEntityStore {
  return new FsWorkflowEntityStore(join(dataRootDir, workspaceId, 'workflow-entities'), workspaceId);
}

export const ENTITY_STORE_ERRORS = { StaleWorkflowRevisionError };
