/**
 * UW-12a — a workspace's source connections on disk: `<data>/<ws>/source-connections/<scn_…>/r000001.json`, one immutable snapshot
 * per revision. A change writes the next revision with an exclusive create, so two writers (two requests, a request and the
 * scheduler, two instances on one data directory) never both win: the loser re-reads and retries, or fails with a stale-revision
 * error when its caller named the revision it expected. The last few revisions are kept; older ones are pruned.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SOURCE_CONNECTION_ID, SOURCE_CONNECTION_SCHEMA, type SourceConnection } from '@xo/connect';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import type { WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { WorkspaceRecord } from '../workspace/workspace.js';

export const MAX_CONNECTIONS_PER_WORKSPACE = 50;
const KEEP_REVISIONS = 10;
const MAX_ATTEMPTS = 8;
const REV = (n: number): string => `r${String(n).padStart(6, '0')}.json`;
const REV_FILE = /^r(\d{6})\.json$/;

export class StaleConnectionRevisionError extends XoError {
  constructor(connectionId: string, expected: number, actual: number) {
    super(
      ErrorCode.PRECONDITION_FAILED,
      `source connection ${connectionId} was changed meanwhile (expected revision ${expected}, current is ${actual}); reload and retry`,
      { context: { connectionId, expectedRevision: expected, currentRevision: actual, reason: 'stale_revision' } },
    );
  }
}

export const newConnectionId = (): string => `scn_${randomBytes(12).toString('hex')}`;

export class FsSourceConnectionStore {
  private readonly dir: string;

  constructor(
    private readonly workspace: WorkspaceRecord,
    dataConfig: WorkspaceDataConfig,
  ) {
    this.dir = join(dataConfig.dataRootDir, workspace.workspaceId, 'source-connections');
  }

  private async head(id: string): Promise<number> {
    let names: string[];
    try {
      names = await readdir(join(this.dir, id));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw e;
    }
    return names.reduce((m, n) => {
      const r = REV_FILE.exec(n);
      return r === null ? m : Math.max(m, Number(r[1]));
    }, 0);
  }

  async get(id: string): Promise<SourceConnection | undefined> {
    if (!SOURCE_CONNECTION_ID.test(id)) return undefined;
    const rev = await this.head(id);
    if (rev === 0) return undefined;
    const c = JSON.parse(await readFile(join(this.dir, id, REV(rev)), 'utf8')) as SourceConnection;
    if (
      c.schema !== SOURCE_CONNECTION_SCHEMA ||
      c.connectionId !== id ||
      c.workspaceId !== this.workspace.workspaceId ||
      c.revision !== rev
    )
      throw new XoError(ErrorCode.UNKNOWN, `source connection ${id} is stored inconsistently`);
    return c;
  }

  async require(id: string): Promise<SourceConnection> {
    const c = await this.get(id);
    if (c === undefined) throw new NotFoundError(`source connection "${id}"`);
    return c;
  }

  async list(): Promise<SourceConnection[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const out: SourceConnection[] = [];
    for (const n of names.filter((x) => SOURCE_CONNECTION_ID.test(x)).sort()) {
      const c = await this.get(n);
      if (c !== undefined) out.push(c);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async write(c: SourceConnection): Promise<boolean> {
    await mkdir(join(this.dir, c.connectionId), { recursive: true });
    try {
      await writeFile(join(this.dir, c.connectionId, REV(c.revision)), JSON.stringify(c), { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
    for (let r = c.revision - KEEP_REVISIONS; r > 0 && r > c.revision - KEEP_REVISIONS - 5; r--)
      await rm(join(this.dir, c.connectionId, REV(r)), { force: true });
    return true;
  }

  async create(c: Omit<SourceConnection, 'revision' | 'workspaceId' | 'schema'>): Promise<SourceConnection> {
    if ((await this.list()).filter((x) => x.retiredAt === undefined).length >= MAX_CONNECTIONS_PER_WORKSPACE)
      throw new XoError(
        ErrorCode.PRECONDITION_FAILED,
        `this workspace has ${MAX_CONNECTIONS_PER_WORKSPACE} source connections; retire one first`,
      );
    const full: SourceConnection = { ...c, schema: SOURCE_CONNECTION_SCHEMA, workspaceId: this.workspace.workspaceId, revision: 1 };
    if (!(await this.write(full))) throw new XoError(ErrorCode.ALREADY_EXISTS, 'source connection id already in use');
    return full;
  }

  /**
   * Applies `change` to the current revision and writes the next one. `expected`, when given, must be the current revision (a
   * person's edit); without it (a sync) a concurrent change is re-read and `change` applied again.
   */
  async update(
    id: string,
    expected: number | undefined,
    now: Date,
    change: (c: SourceConnection) => Omit<SourceConnection, 'revision' | 'updatedAt'>,
  ): Promise<SourceConnection> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const current = await this.require(id);
      if (expected !== undefined && current.revision !== expected) throw new StaleConnectionRevisionError(id, expected, current.revision);
      const next: SourceConnection = { ...change(current), revision: current.revision + 1, updatedAt: now.toISOString() };
      if (await this.write(next)) return next;
      if (expected !== undefined) throw new StaleConnectionRevisionError(id, expected, (await this.head(id)) || current.revision);
    }
    throw new XoError(ErrorCode.PRECONDITION_FAILED, `source connection ${id} kept changing; try again`);
  }
}
