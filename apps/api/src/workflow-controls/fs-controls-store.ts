import type { BlobStore } from '@xo/storage';
import { ErrorCode, XoError } from '@xo/errors';
import { defaultDeployment, deploymentKey, NOT_PAUSED, type Deployment, type WorkspaceControls } from './model.js';

const WORKSPACE_KEY = 'workflow-controls/workspace.json';
const DEPLOYMENTS = 'workflow-controls/deployments/';
const depKey = (key: string) => `${DEPLOYMENTS}${key}.json`;
const KEY_SHAPE = /^wfdep_[0-9a-f]{32}$/;
const queues = new Map<string, Promise<unknown>>();

/**
 * Workflow controls live in the workspace's small-documents store, one JSON file per workflow plus one for the
 * workspace switch. Writes to the same document are serialized in this process and each carries a revision; a second
 * server process writing the same directory is not coordinated with (see the notes in `model.ts`).
 */
export class FsControlsStore {
  constructor(
    private readonly store: BlobStore,
    private readonly workspaceId: string,
  ) {}

  private locked<T>(name: string, work: () => Promise<T>): Promise<T> {
    const k = `${this.workspaceId}/${name}`;
    const run = (queues.get(k) ?? Promise.resolve()).then(work);
    queues.set(
      k,
      run.catch(() => undefined),
    );
    return run;
  }

  private async read<T>(key: string): Promise<T | undefined> {
    const raw = await this.store.get(key);
    if (!raw.ok) {
      if (raw.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return undefined;
      throw raw.error;
    }
    try {
      return JSON.parse(new TextDecoder().decode(raw.value)) as T;
    } catch {
      // A damaged file must not silently turn a switch OFF: fail closed so the caller sees the problem.
      throw new XoError(ErrorCode.UNKNOWN, `workflow controls document "${key}" is unreadable`);
    }
  }

  private async write(key: string, value: unknown): Promise<void> {
    const r = await this.store.put(key, JSON.stringify(value), { contentType: 'application/json' });
    if (!r.ok) throw r.error;
  }

  async getControls(): Promise<WorkspaceControls> {
    return (await this.read<WorkspaceControls>(WORKSPACE_KEY)) ?? NOT_PAUSED;
  }

  setPaused(paused: boolean, by: string, reason: string | undefined, now: string): Promise<WorkspaceControls> {
    return this.locked('workspace', async () => {
      const current = await this.getControls();
      const next: WorkspaceControls = paused
        ? { paused: true, pausedAt: now, pausedBy: by, ...(reason !== undefined ? { reason } : {}), revision: current.revision + 1 }
        : { paused: false, revision: current.revision + 1 };
      await this.write(WORKSPACE_KEY, next);
      return next;
    });
  }

  async getDeployment(compilationId: string, workflowId: string): Promise<Deployment | undefined> {
    return this.read<Deployment>(depKey(deploymentKey(compilationId, workflowId)));
  }

  async listDeployments(): Promise<readonly Deployment[]> {
    const listed = await this.store.list(DEPLOYMENTS);
    if (!listed.ok) {
      if (listed.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return [];
      throw listed.error;
    }
    const out: Deployment[] = [];
    for (const k of listed.value) {
      const m = /^workflow-controls\/deployments\/(wfdep_[0-9a-f]{32})\.json$/.exec(k);
      if (m?.[1] === undefined || !KEY_SHAPE.test(m[1])) continue;
      const d = await this.read<Deployment>(k);
      if (d !== undefined) out.push(d);
    }
    return out;
  }

  /** Reads (or starts from the default), lets `change` produce the next version, and saves it with the revision bumped. `change` may throw to refuse. */
  mutate(
    compilationId: string,
    workflowId: string,
    by: string,
    now: string,
    change: (current: Deployment) => Deployment,
  ): Promise<Deployment> {
    const key = deploymentKey(compilationId, workflowId);
    return this.locked(key, async () => {
      const current = (await this.read<Deployment>(depKey(key))) ?? defaultDeployment(compilationId, workflowId, now);
      const next = change(current);
      const saved: Deployment = { ...next, revision: current.revision + 1, updatedAt: now, updatedBy: by };
      await this.write(depKey(key), saved);
      return saved;
    });
  }
}
