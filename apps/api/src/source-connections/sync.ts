/**
 * UW-12a (ADR 0038) — keeping a source connection in step with its folder.
 *
 * A sync lists the folder (scope-guarded, bounded), reads each new or changed file and stores it as a workspace source through the
 * one store path every upload takes (same checks at the door, same measurements, same audit). A file whose bytes changed becomes a
 * new source version and the old version is RETIRED (`changed`, pointing at its replacement); a file that left the folder retires its
 * version (`removed`). Retired versions keep their bytes, so evidence that cites them can still be shown, but knowledge resting on
 * them no longer feeds execution (UW-4 gate: `source_retired`).
 *
 * When a listing stopped at a limit, absence proves nothing, so nothing is retired for being absent. Discovery runs after every sync
 * over the current versions and refreshes the proposed roles; decisions people made are kept.
 */
import {
  FolderError,
  proposeRoles,
  type SourceReader,
  type ConnectionItem,
  type DiscoveryItem,
  type DiscoveryTable,
  type RetiredItem,
  type SourceConnection,
  type SyncReport,
} from '@xo/connect';
import { tabularFromCsv, tabularFromXlsx } from '@xo/compiler';
import { createHash } from 'node:crypto';
import { ErrorCode, XoError } from '@xo/errors';
import type { AuditActor, AuditEventInput } from '../audit/audit-entry.js';
import { openWorkspaceAuditLog } from '../audit/workspace-audit-log.js';
import { FsSourceStore } from '../sources/fs-source-store.js';
import { storeSourceBytes } from '../sources/ingest.js';
import { inferMediaType } from '../sources/source.js';
import { workspaceSourcesStore, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { WorkspaceRecord } from '../workspace/workspace.js';
import { FsSourceConnectionStore } from './store.js';

/** Bounded so a connection's record stays small: older retirements are still on each source record. */
const MAX_RETIRED_KEPT = 500;
/** Values per column handed to discovery. */
const MAX_DISCOVERY_ROWS = 5000;

/** The folders this instance lets a workspace connect (`XO_SOURCE_FOLDER_ROOTS`, comma- or newline-separated absolute paths). */
export function sourceFolderRoots(env: Readonly<Record<string, string | undefined>>): string[] {
  return (env['XO_SOURCE_FOLDER_ROOTS'] ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export interface SyncDeps {
  readonly workspace: WorkspaceRecord;
  readonly dataConfig: WorkspaceDataConfig;
  /** The reader for a connection's kind (local folder, cloud drive); an agent's sync passes its own. */
  readonly readerFor: (c: SourceConnection) => Promise<SourceReader>;
  /** Who the audit records as acting: the person who asked, or the scheduler. */
  readonly actor: AuditActor;
}

const locks = new Map<string, Promise<unknown>>();
/** One sync per connection at a time in this process (a second request waits for the first and then syncs again). */
function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).then(work, work);
  locks.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

async function audit(deps: SyncDeps, entry: Omit<AuditEventInput, 'actor'>): Promise<void> {
  try {
    await openWorkspaceAuditLog(deps.workspace, deps.dataConfig).append({ ...entry, actor: deps.actor });
  } catch (cause) {
    process.stderr.write(
      `[xo-api] audit write failed for workspace ${deps.workspace.workspaceId} (${entry.event}): ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
  }
}

/** The tables of a stored workbook or CSV, as discovery reads them (bounded). */
export function tablesOf(extension: string, bytes: Uint8Array): DiscoveryTable[] | undefined {
  const t =
    extension === '.csv' ? tabularFromCsv(new TextDecoder().decode(bytes)) : extension === '.xlsx' ? tabularFromXlsx(bytes) : undefined;
  if (t === undefined || !t.ok) return undefined;
  return t.value.recordSets.map((rs) => ({
    recordSetId: rs.id,
    ...(rs.sheet !== undefined ? { sheet: rs.sheet } : {}),
    rows: rs.records.length,
    columns: rs.columns.map((col) => ({
      header: col.header,
      values: rs.records.slice(0, MAX_DISCOVERY_ROWS).map((r) => r.cells[col.column]?.raw ?? ''),
    })),
  }));
}

/** Discovery over a connection's current versions (reads the stored bytes, never the folder). */
export async function discoveryItems(deps: Pick<SyncDeps, 'workspace' | 'dataConfig'>, c: SourceConnection): Promise<DiscoveryItem[]> {
  const sources = new FsSourceStore(workspaceSourcesStore(deps.workspace, deps.dataConfig));
  const out: DiscoveryItem[] = [];
  for (const i of c.items) {
    let tables: DiscoveryTable[] | undefined;
    if (i.extension === '.csv' || i.extension === '.xlsx') {
      const bytes = await sources.getContent(i.sourceId);
      if (bytes.ok) tables = tablesOf(i.extension, bytes.value);
    }
    out.push({
      key: i.key,
      name: i.name,
      extension: i.extension,
      sourceId: i.sourceId,
      digestSha256: i.digestSha256,
      ...(tables !== undefined ? { tables } : {}),
    });
  }
  return out;
}

export function syncConnection(deps: SyncDeps, connectionId: string, now = new Date(), reader?: SourceReader): Promise<SourceConnection> {
  return serialized(`${deps.workspace.workspaceId}/${connectionId}`, () => syncOnce(deps, connectionId, now, reader));
}

async function syncOnce(deps: SyncDeps, connectionId: string, now: Date, given: SourceReader | undefined): Promise<SourceConnection> {
  const store = new FsSourceConnectionStore(deps.workspace, deps.dataConfig);
  const sources = new FsSourceStore(workspaceSourcesStore(deps.workspace, deps.dataConfig));
  const c = await store.require(connectionId);
  if (c.retiredAt !== undefined) throw new XoError(ErrorCode.PRECONDITION_FAILED, 'this source connection is retired');
  const at = now.toISOString();

  const fail = async (problem: string): Promise<SourceConnection> => {
    const report: SyncReport = {
      at,
      outcome: 'failed',
      added: 0,
      changed: 0,
      unchanged: c.items.length,
      removed: 0,
      failed: {},
      skipped: {},
      problem,
    };
    const next = await store.update(connectionId, undefined, now, (cur) => ({ ...cur, lastSync: report }));
    await audit(deps, {
      event: 'source_connection.synced',
      result: 'failed',
      target: { kind: 'source-connection', id: connectionId, label: c.displayName },
      detail: { problem },
    });
    return next;
  };

  let listing;
  let reader: SourceReader;
  try {
    // A local folder is approved again at every listing: an operator who narrows XO_SOURCE_FOLDER_ROOTS stops connections outside
    // it. A cloud drive checks its credential at every request.
    reader = given ?? (await deps.readerFor(c));
    listing = await reader.list();
  } catch (e) {
    if (e instanceof FolderError) return await fail(e.message);
    throw e;
  }

  const ctx = {
    workspace: deps.workspace,
    dataConfig: deps.dataConfig,
    identityId: c.createdBy,
    audit: (entry: Omit<AuditEventInput, 'actor'>) => audit(deps, entry),
  };
  const items: ConnectionItem[] = [];
  const retired: RetiredItem[] = [];
  const failed: Record<string, number> = {};
  const failedKeys = new Set<string>();
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  for (const f of listing.items) {
    const prev = c.items.find((i) => i.key === f.key);
    if (prev !== undefined && prev.sizeBytes === f.sizeBytes && prev.modifiedAt === f.modifiedAt) {
      items.push(prev);
      unchanged++;
      continue;
    }
    // The agent sends each file's digest: the same digest is the same file, and nothing needs reading.
    if (prev !== undefined && f.digestSha256 !== undefined && prev.digestSha256 === f.digestSha256) {
      items.push({ ...prev, sizeBytes: f.sizeBytes, modifiedAt: f.modifiedAt });
      unchanged++;
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await reader.read(f);
    } catch (e) {
      if (!(e instanceof FolderError)) throw e;
      failed[e.code] = (failed[e.code] ?? 0) + 1;
      failedKeys.add(f.key);
      if (prev !== undefined) items.push(prev); // the version already held stays current until a newer one is read
      continue;
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (prev !== undefined && prev.digestSha256 === digest) {
      items.push({ ...prev, sizeBytes: f.sizeBytes, modifiedAt: f.modifiedAt }); // touched, not changed
      unchanged++;
      continue;
    }
    try {
      const stored = await storeSourceBytes(ctx, f.name, f.extension, inferMediaType(f.extension, undefined), bytes, {
        kind: 'connection',
        connectionId,
        itemKey: f.key,
      });
      items.push({
        key: f.key,
        name: f.name,
        extension: f.extension,
        sizeBytes: f.sizeBytes,
        modifiedAt: f.modifiedAt,
        sourceId: stored.sourceId,
        digestSha256: stored.digestSha256,
        syncedAt: at,
      });
      if (prev === undefined) added++;
      else {
        changed++;
        retired.push({
          key: prev.key,
          sourceId: prev.sourceId,
          digestSha256: prev.digestSha256,
          retiredAt: at,
          reason: 'changed',
          replacedBy: stored.sourceId,
        });
      }
    } catch (e) {
      // The door refused it (a corrupt workbook, content that is not what its name says): counted, never stored.
      if (!(e instanceof XoError) || e.code !== ErrorCode.INVALID_ARGUMENT) throw e;
      failed['refused_at_door'] = (failed['refused_at_door'] ?? 0) + 1;
      failedKeys.add(f.key);
      if (prev !== undefined) items.push(prev);
    }
  }
  let removed = 0;
  for (const prev of c.items) {
    if (listing.items.some((f) => f.key === prev.key)) continue;
    if (listing.truncated !== undefined) {
      items.push(prev); // the listing stopped early: absence proves nothing
      continue;
    }
    removed++;
    retired.push({ key: prev.key, sourceId: prev.sourceId, digestSha256: prev.digestSha256, retiredAt: at, reason: 'removed' });
  }
  for (const r of retired) {
    await sources.retire(r.sourceId, {
      at: r.retiredAt,
      reason: r.reason,
      ...(r.replacedBy !== undefined ? { replacedBy: r.replacedBy } : {}),
    });
    await audit(deps, {
      event: 'source.retired',
      result: 'succeeded',
      target: { kind: 'source', id: r.sourceId },
      detail: { reason: r.reason, connectionId, ...(r.replacedBy !== undefined ? { replacedBy: r.replacedBy } : {}) },
    });
  }
  items.sort((a, b) => a.key.localeCompare(b.key));
  const outcome: SyncReport['outcome'] = failedKeys.size > 0 || listing.truncated !== undefined ? 'partial' : 'complete';
  const report: SyncReport = {
    at,
    outcome,
    added,
    changed,
    unchanged,
    removed,
    failed,
    skipped: listing.skipped,
    ...(listing.truncated !== undefined ? { truncated: listing.truncated } : {}),
  };
  const proposals = proposeRoles(await discoveryItems(deps, { ...c, items }));
  const next = await store.update(connectionId, undefined, now, (cur) => ({
    ...cur,
    items,
    retired: [...cur.retired, ...retired].slice(-MAX_RETIRED_KEPT),
    lastSync: report,
    lastSuccessfulSyncAt: at,
    proposals,
  }));
  await audit(deps, {
    event: 'source_connection.synced',
    result: 'succeeded',
    target: { kind: 'source-connection', id: connectionId, label: c.displayName },
    detail: {
      outcome,
      added,
      changed,
      unchanged,
      removed,
      failed: Object.values(failed).reduce((a, b) => a + b, 0),
      proposals: proposals.length,
    },
  });
  return next;
}

/** Retires a connection: no more syncs, and every version it holds stops being current. Files in the folder are untouched. */
export async function retireConnection(
  deps: SyncDeps,
  connectionId: string,
  expected: number | undefined,
  now = new Date(),
): Promise<SourceConnection> {
  return serialized(`${deps.workspace.workspaceId}/${connectionId}`, async () => {
    const store = new FsSourceConnectionStore(deps.workspace, deps.dataConfig);
    const sources = new FsSourceStore(workspaceSourcesStore(deps.workspace, deps.dataConfig));
    const at = now.toISOString();
    const next = await store.update(connectionId, expected, now, (cur) => {
      if (cur.retiredAt !== undefined) throw new XoError(ErrorCode.PRECONDITION_FAILED, 'this source connection is already retired');
      return {
        ...cur,
        retiredAt: at,
        items: [],
        retired: [
          ...cur.retired,
          ...cur.items.map((i): RetiredItem => ({
            key: i.key,
            sourceId: i.sourceId,
            digestSha256: i.digestSha256,
            retiredAt: at,
            reason: 'connection_retired',
          })),
        ].slice(-MAX_RETIRED_KEPT),
      };
    });
    const before = next.retired.filter((r) => r.retiredAt === at && r.reason === 'connection_retired');
    for (const r of before) await sources.retire(r.sourceId, { at, reason: 'connection_retired' });
    await audit(deps, {
      event: 'source_connection.retired',
      result: 'succeeded',
      target: { kind: 'source-connection', id: connectionId, label: next.displayName },
      detail: { versionsRetired: before.length },
    });
    return next;
  });
}
