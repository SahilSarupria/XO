/**
 * V1-1 (ADR 0049, V1-G2) — the items of a batch, built from a source a person confirmed on a source connection: a client list (or
 * any table) gives one item per row; "each client's certificate" also gives each row its one document.
 *
 * The table is read in full from the stored version (never the folder), and the documents are the connection's current versions,
 * so a document's sha256 is the workspace source `message.send` attaches. The same reference read again gives the same items while
 * the files are unchanged: a start rebuilds them and compares (ADR 0049 §2.4).
 */
import { tabularFromCsv, tabularFromXlsx } from '@xo/compiler';
import {
  DOCUMENT_EXTENSIONS,
  buildSourceItems,
  proposalViews,
  SourceItemsError,
  type ProposalView,
  type SourceConnection,
  type SourceItems,
} from '@xo/connect';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { FsSourceStore } from '../sources/fs-source-store.js';
import { inferMediaType } from '../sources/source.js';
import { workspaceSourcesStore, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { WorkspaceRecord } from '../workspace/workspace.js';
import { FsSourceConnectionStore } from './store.js';

export interface ItemSourceRef {
  readonly connectionId: string;
  readonly proposalId: string;
}

export interface ItemSourceInfo extends ItemSourceRef {
  readonly role: 'contact_list' | 'record_table' | 'per_person_documents';
  /** Plain words: "each client's certificate". */
  readonly label: string;
  readonly connectionName: string;
  /** The versions the items were built from (the table, and the folder's documents). */
  readonly digests: readonly string[];
  /** The files changed since a person confirmed the role (they confirmed it over older versions). */
  readonly changedSinceConfirmation: boolean;
}

export interface ItemsFromSource extends SourceItems {
  readonly source: ItemSourceInfo;
}

const ITEM_ROLES = new Set(['contact_list', 'record_table', 'per_person_documents']);
const ID = /^(scn_[0-9a-f]{24})$/;
const PROPOSAL = /^rol_[0-9a-f]{16}$/;

export function parseItemSourceRef(v: unknown): ItemSourceRef {
  const o = v as { connectionId?: unknown; proposalId?: unknown } | null;
  if (
    typeof o !== 'object' ||
    o === null ||
    Array.isArray(o) ||
    Object.keys(o).some((k) => k !== 'connectionId' && k !== 'proposalId') ||
    typeof o.connectionId !== 'string' ||
    !ID.test(o.connectionId) ||
    typeof o.proposalId !== 'string' ||
    !PROPOSAL.test(o.proposalId)
  )
    throw new XoError(
      ErrorCode.INVALID_ARGUMENT,
      '"items" is { "connectionId": "scn_…", "proposalId": "rol_…" }: a confirmed list or pairing',
    );
  return { connectionId: o.connectionId, proposalId: o.proposalId };
}

type Deps = { readonly workspace: WorkspaceRecord; readonly dataConfig: WorkspaceDataConfig };

const parentOf = (key: string): string => (key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '');

async function readTable(deps: Deps, c: SourceConnection, itemKey: string, recordSetId: string) {
  const item = c.items.find((i) => i.key === itemKey);
  if (item === undefined) throw new XoError(ErrorCode.PRECONDITION_FAILED, `"${itemKey}" is no longer in the connected folder`);
  const bytes = await new FsSourceStore(workspaceSourcesStore(deps.workspace, deps.dataConfig)).getContent(item.sourceId);
  if (!bytes.ok) throw new XoError(ErrorCode.PRECONDITION_FAILED, `the stored version of "${item.name}" cannot be read`);
  const t =
    item.extension === '.csv'
      ? tabularFromCsv(new TextDecoder().decode(bytes.value))
      : item.extension === '.xlsx'
        ? tabularFromXlsx(bytes.value)
        : undefined;
  const rs = t?.ok === true ? t.value.recordSets.find((r) => r.id === recordSetId) : undefined;
  if (rs === undefined) throw new XoError(ErrorCode.PRECONDITION_FAILED, `"${item.name}" no longer has the table that was confirmed`);
  return {
    item,
    headers: rs.columns.map((col) => col.header),
    rows: rs.records.map((r) => rs.columns.map((col) => r.cells[col.column]?.raw ?? '')),
  };
}

function usable(c: SourceConnection, proposalId: string): ProposalView {
  if (c.retiredAt !== undefined) throw new XoError(ErrorCode.PRECONDITION_FAILED, 'that source connection is retired');
  const p = proposalViews(c).find((x) => x.proposalId === proposalId);
  if (p === undefined) throw new NotFoundError(`proposal "${proposalId}" (not current for this connection)`);
  if (!ITEM_ROLES.has(p.role))
    throw new XoError(ErrorCode.INVALID_ARGUMENT, `${p.label} has no rows to make items from; use a list or a pairing`);
  if (p.status !== 'confirmed')
    throw new XoError(
      ErrorCode.PRECONDITION_FAILED,
      `"${p.label}" in ${c.displayName} is ${p.status === 'rejected' ? 'rejected' : 'not confirmed yet'}: a person confirms it first`,
    );
  return p;
}

/** The items a confirmed list or pairing gives now. */
export async function itemsFromConfirmedSource(deps: Deps, ref: ItemSourceRef): Promise<ItemsFromSource> {
  const c = await new FsSourceConnectionStore(deps.workspace, deps.dataConfig).require(ref.connectionId);
  const p = usable(c, ref.proposalId);
  const t = p.target;
  const table = t.kind === 'table' ? t : t.kind === 'pairing' ? t.table : undefined;
  if (table === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, `${p.label} has no rows to make items from`);
  const { item, headers, rows } = await readTable(deps, c, table.itemKey, table.recordSetId);
  const docs =
    t.kind === 'pairing'
      ? c.items
          .filter((i) => parentOf(i.key) === t.folder.prefix && DOCUMENT_EXTENSIONS.has(i.extension))
          .sort((a, b) => a.key.localeCompare(b.key))
      : [];
  let built: SourceItems;
  try {
    built = buildSourceItems({
      headers,
      rows,
      ...(t.kind === 'pairing'
        ? {
            pairing: {
              nameColumn: t.nameColumn,
              documents: docs.map((d) => ({
                key: d.key,
                name: d.name,
                digestSha256: d.digestSha256,
                contentType: inferMediaType(d.extension, undefined),
              })),
            },
          }
        : {}),
    });
  } catch (e) {
    if (e instanceof SourceItemsError) throw new XoError(ErrorCode.PRECONDITION_FAILED, e.message, { context: { reason: e.code } });
    throw e;
  }
  return {
    ...built,
    source: {
      connectionId: c.connectionId,
      proposalId: p.proposalId,
      role: p.role as ItemSourceInfo['role'],
      label: p.label,
      connectionName: c.displayName,
      digests: [item.digestSha256, ...docs.map((d) => d.digestSha256)].sort(),
      changedSinceConfirmation: p.changedSinceDecision === true,
    },
  };
}

/** The confirmed lists and pairings of the workspace's active connections, with the fields their items would have. */
export async function listItemSources(
  deps: Deps,
): Promise<(ItemSourceInfo & { readonly fields: readonly string[]; readonly items: number; readonly excluded: number })[]> {
  const out = [];
  for (const c of await new FsSourceConnectionStore(deps.workspace, deps.dataConfig).list()) {
    if (c.retiredAt !== undefined) continue;
    for (const p of proposalViews(c)) {
      if (!ITEM_ROLES.has(p.role) || p.status !== 'confirmed') continue;
      try {
        const b = await itemsFromConfirmedSource(deps, { connectionId: c.connectionId, proposalId: p.proposalId });
        out.push({ ...b.source, fields: b.fields, items: b.items.length, excluded: b.excludedRows.length });
      } catch (e) {
        if (!(e instanceof XoError)) throw e; // a source that cannot give items now is not offered
      }
    }
  }
  return out;
}
