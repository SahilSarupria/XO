import type { BlobStore } from '@xo/storage';
import { ErrorCode, XoError } from '@xo/errors';
import { DEFAULT_SETTINGS, type WorkspaceSettings } from './workspace-settings.js';

const KEY = 'settings.json';

export class StaleSettingsRevisionError extends XoError {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(ErrorCode.PRECONDITION_FAILED, `settings were changed by someone else (expected revision ${expected}, current is ${actual}); reload and retry`, {
      context: { expectedRevision: expected, currentRevision: actual, reason: 'stale_revision' },
    });
  }
}

const queues = new Map<string, Promise<unknown>>();

/** One settings document per workspace. Updates are serialized per workspace and guarded by `expectedRevision`. */
export class FsSettingsStore {
  constructor(
    private readonly store: BlobStore,
    private readonly workspaceId: string,
  ) {}

  async get(): Promise<WorkspaceSettings> {
    const raw = await this.store.get(KEY);
    if (!raw.ok) {
      if (raw.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return DEFAULT_SETTINGS;
      throw raw.error;
    }
    try {
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(new TextDecoder().decode(raw.value)) as Partial<WorkspaceSettings>) } as WorkspaceSettings;
    } catch {
      throw new XoError(ErrorCode.SERIALIZATION_PARSE_FAILED, 'stored workspace settings are unreadable');
    }
  }

  /** `compute` receives the current settings and returns the next; it runs under the per-workspace lock. */
  update(expectedRevision: number | undefined, compute: (current: WorkspaceSettings) => WorkspaceSettings): Promise<WorkspaceSettings> {
    const previous = queues.get(this.workspaceId) ?? Promise.resolve();
    const run = previous.then(async () => {
      const current = await this.get();
      if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new StaleSettingsRevisionError(expectedRevision, current.revision);
      const next = compute(current);
      const put = await this.store.put(KEY, JSON.stringify(next), { contentType: 'application/json' });
      if (!put.ok) throw put.error;
      return next;
    });
    queues.set(
      this.workspaceId,
      run.catch(() => undefined),
    );
    return run;
  }
}
