/**
 * UW-10c (ADR 0042) — the email addresses of people in CONFIRMED contact lists (a person confirmed that a table is the client list,
 * UW-12a). A recipient from such a list is allowed to be written to; the model never adds to it. Reads the stored bytes of the
 * workspace's sources, never the original folder. Addresses are returned for the send check only: never logged or audited.
 */
import { tabularFromCsv, tabularFromXlsx } from '@xo/compiler';
import { FsSourceStore } from '../sources/fs-source-store.js';
import { proposalViews } from '@xo/connect';
import type { FsSourceConnectionStore } from '../source-connections/store.js';
import type { WorkspaceRecord } from '../workspace/workspace.js';
import { workspaceSourcesStore, type WorkspaceDataConfig } from '../workspace/workspace-context.js';

const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;

export async function confirmedContactEmails(
  workspace: WorkspaceRecord,
  config: WorkspaceDataConfig,
  connections: Pick<FsSourceConnectionStore, 'list'>,
): Promise<Set<string>> {
  const out = new Set<string>();
  const sources = new FsSourceStore(workspaceSourcesStore(workspace, config));
  for (const c of await connections.list()) {
    if (c.retiredAt !== undefined) continue;
    for (const p of proposalViews(c)) {
      // Confirmed, and the table has not changed since it was confirmed (a changed table must be confirmed again).
      if (p.role !== 'contact_list' || p.status !== 'confirmed' || p.changedSinceDecision === true || p.target.kind !== 'table') continue;
      const target = p.target;
      const item = c.items.find((i) => i.key === target.itemKey);
      if (item === undefined || (item.extension !== '.csv' && item.extension !== '.xlsx')) continue;
      const bytes = await sources.getContent(item.sourceId);
      if (!bytes.ok) continue;
      const t = item.extension === '.csv' ? tabularFromCsv(new TextDecoder().decode(bytes.value)) : tabularFromXlsx(bytes.value);
      if (!t.ok) continue;
      const rs = t.value.recordSets.find((r) => r.id === target.recordSetId);
      if (rs === undefined) continue;
      for (const col of rs.columns) {
        const cells = rs.records.map((r) => r.cells[col.column]?.raw ?? '').filter((s) => s.trim() !== '');
        // An email column: most of its filled cells are addresses.
        if (cells.length === 0 || cells.filter((s) => EMAIL.test(s.trim())).length / cells.length < 0.8) continue;
        for (const s of cells) if (EMAIL.test(s.trim())) out.add(s.trim().toLowerCase());
      }
    }
  }
  return out;
}
