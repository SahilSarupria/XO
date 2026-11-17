/**
 * UW-12a — the source connection: one place a workspace reads files from, kept in step with it (sync), honest about how current it
 * is (freshness), and retiring what disappears or changes (retirement). Local folders now; cloud drives later through the same
 * reader port.
 */
import type { FolderListing } from './folder-reader.js';
import type { RoleProposal } from './discovery.js';

export const SOURCE_CONNECTION_ID = /^scn_[0-9a-f]{24}$/;
export const SOURCE_CONNECTION_SCHEMA = 'xo.source-connection/1' as const;

export type SourceConnectionKind = 'local_folder';

/** One file of the connection, as last synced: which workspace source holds its current version. */
export interface ConnectionItem {
  readonly key: string;
  readonly name: string;
  readonly extension: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  /** The workspace source holding this version (`src_…`). */
  readonly sourceId: string;
  readonly digestSha256: string;
  readonly syncedAt: string;
}

/** A version the connection no longer has: the file changed (a newer source holds it) or left the folder. */
export interface RetiredItem {
  readonly key: string;
  readonly sourceId: string;
  readonly digestSha256: string;
  readonly retiredAt: string;
  readonly reason: 'changed' | 'removed' | 'connection_retired';
  readonly replacedBy?: string;
}

export interface SyncReport {
  readonly at: string;
  readonly outcome: 'complete' | 'partial' | 'failed';
  readonly added: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly removed: number;
  /** Files that could not be read or stored, by reason (counts only). */
  readonly failed: Readonly<Record<string, number>>;
  readonly skipped: FolderListing['skipped'];
  readonly truncated?: FolderListing['truncated'];
  /** Why the whole sync failed, in plain words (no path). */
  readonly problem?: string;
}

export interface RoleDecision {
  readonly proposalId: string;
  readonly decision: 'confirmed' | 'rejected';
  readonly by: string;
  readonly at: string;
  /** What the role pointed at when it was decided: if those versions change, the decision is shown as made on older files. */
  readonly digests: readonly string[];
}

export interface SourceConnection {
  readonly schema: typeof SOURCE_CONNECTION_SCHEMA;
  readonly connectionId: string;
  readonly workspaceId: string;
  readonly kind: SourceConnectionKind;
  /** The folder's last segment. */
  readonly displayName: string;
  /** Server-side only: the approved real root. Never returned by the API. */
  readonly root: string;
  /** `manual`, or sync every N minutes (the scheduler runs it). */
  readonly sync: { readonly mode: 'manual' } | { readonly mode: 'interval'; readonly everyMinutes: number };
  readonly paused: boolean;
  readonly retiredAt?: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly items: readonly ConnectionItem[];
  /** Bounded, newest last. */
  readonly retired: readonly RetiredItem[];
  readonly lastSync?: SyncReport;
  readonly lastSuccessfulSyncAt?: string;
  readonly proposals: readonly RoleProposal[];
  readonly decisions: readonly RoleDecision[];
}

export type Freshness =
  | { readonly state: 'never_synced' }
  | { readonly state: 'current'; readonly asOf: string }
  | { readonly state: 'stale'; readonly asOf: string; readonly dueSince: string }
  | { readonly state: 'needs_attention'; readonly asOf?: string; readonly problem: string }
  | { readonly state: 'paused'; readonly asOf?: string }
  | { readonly state: 'retired'; readonly at: string };

/** How current the connection is. Manual connections are as of their last sync; interval ones are stale once a sync is overdue. */
export function freshnessOf(c: SourceConnection, now: Date): Freshness {
  if (c.retiredAt !== undefined) return { state: 'retired', at: c.retiredAt };
  const asOf = c.lastSuccessfulSyncAt;
  if (c.paused) return asOf !== undefined ? { state: 'paused', asOf } : { state: 'paused' };
  if (c.lastSync?.outcome === 'failed')
    return { state: 'needs_attention', ...(asOf !== undefined ? { asOf } : {}), problem: c.lastSync.problem ?? 'the last sync failed' };
  if (asOf === undefined) return { state: 'never_synced' };
  if (c.lastSync?.outcome === 'partial')
    return { state: 'needs_attention', asOf, problem: 'some files could not be read at the last sync' };
  if (c.sync.mode === 'interval') {
    // One missed slot is normal (the scheduler runs on its own tick): stale after two.
    const due = Date.parse(asOf) + 2 * c.sync.everyMinutes * 60_000;
    if (now.getTime() > due) return { state: 'stale', asOf, dueSince: new Date(due).toISOString() };
  }
  return { state: 'current', asOf };
}

export type ProposalStatus = 'proposed' | 'confirmed' | 'rejected';

/** A proposal with its decision, and whether the files it points at changed since then. */
export interface ProposalView extends RoleProposal {
  readonly status: ProposalStatus;
  readonly decidedBy?: string;
  readonly decidedAt?: string;
  readonly changedSinceDecision?: boolean;
}

/** The digests a proposal stands on (its files' current versions). */
export function proposalDigests(p: RoleProposal, items: readonly ConnectionItem[]): string[] {
  const t = p.target;
  const keys =
    t.kind === 'table'
      ? [t.itemKey]
      : t.kind === 'folder'
        ? items
            .filter(
              (i) => (i.key.includes('/') ? i.key.slice(0, i.key.lastIndexOf('/')) : '') === t.prefix && t.extensions.includes(i.extension),
            )
            .map((i) => i.key)
        : [
            t.table.itemKey,
            ...items
              .filter((i) => (i.key.includes('/') ? i.key.slice(0, i.key.lastIndexOf('/')) : '') === t.folder.prefix)
              .map((i) => i.key),
          ];
  return items
    .filter((i) => keys.includes(i.key))
    .map((i) => i.digestSha256)
    .sort();
}

export function proposalViews(c: SourceConnection): ProposalView[] {
  return c.proposals.map((p) => {
    const d = c.decisions.find((x) => x.proposalId === p.proposalId);
    if (d === undefined) return { ...p, status: 'proposed' as const };
    const now = proposalDigests(p, c.items);
    return {
      ...p,
      status: d.decision,
      decidedBy: d.by,
      decidedAt: d.at,
      changedSinceDecision: now.join(',') !== [...d.digests].sort().join(','),
    };
  });
}
