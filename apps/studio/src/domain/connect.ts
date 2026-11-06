/**
 * Connect: presentation logic as pure functions (no React, no fetch). Every sentence here is a claim the platform backs; the rules are in
 * packages/connect/docs/HTTP_CONTRACT.md ("Wording constraints"). In particular:
 *  - cloud sources are never presented as data sources;
 *  - "read" never means "learned": the report says whether it was kept and how much was understood;
 *  - disconnect / exclude never claim knowledge was removed;
 *  - access ending is never described as expired or revoked unless the server said which.
 */
import type {
  ActionEffects,
  AddSourceEntry,
  ConnectCapabilities,
  ConnectDashboard,
  ConnectSource,
  ConnectSourceState,
  FolderEntry,
  ReadReport,
  RemovalPreview,
} from '../platform/wire-connect';
import type { OutcomeTone } from './review';

export type SourceAction = 'read' | 'check' | 'change_selection' | 'disconnect' | 'reconnect' | 'remove';

export interface StateView {
  readonly label: string;
  readonly tone: OutcomeTone;
  readonly summary: string;
  /** What is sensible to OFFER in this state. The server still decides every action. */
  readonly actions: readonly SourceAction[];
}

export function stateView(source: Pick<ConnectSource, 'state' | 'attention'>): StateView {
  const attention = source.attention?.message;
  const map: Record<ConnectSourceState, StateView> = {
    awaiting_first_read: {
      label: 'Ready to read',
      tone: 'neutral',
      summary: 'Connected. Nothing has been read yet.',
      actions: ['read', 'change_selection', 'disconnect', 'remove'],
    },
    read_complete: {
      label: 'Read',
      tone: 'success',
      summary: 'Everything you chose was read.',
      actions: ['read', 'change_selection', 'disconnect', 'remove'],
    },
    read_partial: {
      label: 'Partly read',
      tone: 'warning',
      summary: attention ?? 'Some items could not be read.',
      actions: ['read', 'change_selection', 'disconnect', 'remove'],
    },
    needs_attention: {
      label: 'Needs attention',
      tone: 'warning',
      summary: attention ?? 'Something went wrong with this folder.',
      actions: ['read', 'check', 'disconnect', 'remove'],
    },
    access_ended: {
      label: 'Access ended',
      tone: 'warning',
      summary: attention ?? 'XO can no longer read this folder. Earlier knowledge is kept and may be out of date.',
      actions: ['check', 'remove'],
    },
    access_expired: {
      label: 'Access expired',
      tone: 'warning',
      summary: attention ?? 'XO can no longer read this source. Earlier knowledge is kept and may be out of date.',
      actions: ['check', 'remove'],
    },
    disconnected: {
      label: 'Disconnected',
      tone: 'neutral',
      summary: 'XO stopped reading this folder. What XO already learned is kept.',
      actions: ['reconnect', 'remove'],
    },
    setup_incomplete: {
      label: 'Check needed',
      tone: 'warning',
      summary: attention ?? 'XO has no current record of this folder. Check it again to re-establish it.',
      actions: ['check', 'remove'],
    },
    unsupported: { label: 'Not supported', tone: 'neutral', summary: 'XO cannot read this kind of source yet.', actions: ['remove'] },
  };
  return map[source.state];
}

/** What to offer, given what the server says the caller may do. Unknown capabilities offer nothing that changes anything. */
export function visibleActions(view: StateView, caps: ConnectCapabilities | undefined): readonly SourceAction[] {
  if (caps === undefined || !caps.manageSources) return [];
  return view.actions;
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** One honest sentence about a read. Never says XO "learned" anything; says whether it was kept and how much was understood. */
export function readSummary(r: ReadReport): string {
  if (r.status === 'failed') return 'The read did not complete. Nothing new was kept.';
  const parts = [`Read ${r.read} of ${plural(r.requested, 'chosen item')}.`];
  if (r.skipped.vanished > 0) parts.push(`${plural(r.skipped.vanished, 'item')} no longer in the folder.`);
  if (r.skipped.notAcquirable > 0) parts.push(`${plural(r.skipped.notAcquirable, 'item')} not readable as text.`);
  if (r.unreadable > 0) parts.push(`${plural(r.unreadable, 'item')} could not be read.`);
  parts.push(r.evidence === 'retained' ? 'XO kept what it read.' : 'XO did not keep what it read.');
  if (r.retired > 0) parts.push(`${plural(r.retired, 'item')} ${r.retired === 1 ? 'was' : 'were'} deleted or changed and retired.`);
  if (r.notUnderstood !== undefined && r.notUnderstood > 0)
    parts.push(
      `${plural(r.notUnderstood, 'item')} kept but not understood yet: only structured organizational records become knowledge today.`,
    );
  if (r.assertionsAdded !== undefined && r.assertionsAdded > 0) parts.push(`${plural(r.assertionsAdded, 'new fact')} found.`);
  return parts.join(' ');
}

export function effectsSentence(e: ActionEffects): string {
  switch (e.futureReads) {
    case 'stopped':
      return 'XO stopped reading this folder. What XO already learned is kept, and nothing in your folder was changed.';
    case 'narrowed':
      return 'XO will read less from now on. What it already learned is kept.';
    case 'widened':
      return 'XO will read more from now on.';
    case 'resumed':
      return 'XO can read this folder again.';
    case 'unchanged':
      return 'Nothing about future reading changed.';
  }
}

export function removalSentences(p: RemovalPreview): readonly string[] {
  return [
    `Removing this source retires the ${plural(p.evidenceItems, 'piece')} of evidence XO kept from it, so nothing XO derived from them is shown any more.`,
    'Your files are not touched.',
    // Per-fact dependency counts need provenance that is not wired yet, so no claim about other sources is made.
    'XO cannot yet tell you how many facts rest only on this source, so it makes no claim about facts that other sources may also support.',
  ];
}

export function dashboardKnowledgeLine(d: ConnectDashboard): string {
  switch (d.knowledge.availability) {
    case 'ready':
      return 'Knowledge is available from what XO has read.';
    case 'empty':
      return d.knowledge.reason;
    case 'not_available':
      return d.knowledge.reason;
  }
}

export function addSourceLabel(e: AddSourceEntry): { readonly title: string; readonly canStart: boolean } {
  const title = e.kind === 'local_folder' ? 'Folder on this computer' : e.kind === 'microsoft_365' ? 'Microsoft 365' : 'Google Workspace';
  return { title, canStart: e.availability === 'available' };
}

// -- selection tree --------------------------------------------------------------------------------------------------------------

export interface TreeNode {
  readonly path: string;
  readonly name: string;
  readonly folders: TreeNode[];
  readonly files: FolderEntry[];
}

export function buildTree(entries: readonly FolderEntry[]): TreeNode {
  const root: TreeNode = { path: '', name: '', folders: [], files: [] };
  for (const e of entries) {
    const parts = e.key.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const path = parts.slice(0, i + 1).join('/');
      let next = node.folders.find((f) => f.path === path);
      if (next === undefined) {
        next = { path, name: parts[i] as string, folders: [], files: [] };
        node.folders.push(next);
      }
      node = next;
    }
    node.files.push(e);
  }
  const sort = (n: TreeNode): void => {
    n.folders.sort((a, b) => (a.name < b.name ? -1 : 1));
    n.files.sort((a, b) => (a.name < b.name ? -1 : 1));
    n.folders.forEach(sort);
  };
  sort(root);
  return root;
}

export const filesUnder = (n: TreeNode): FolderEntry[] => [...n.files, ...n.folders.flatMap(filesUnder)];

export type Tri = 'all' | 'some' | 'none';

/** Only readable-as-text files can be chosen; the rest are shown but never selectable. */
export function triState(n: TreeNode, selected: ReadonlySet<string>): Tri {
  const sel = filesUnder(n).filter((f) => f.contentAcquirable);
  if (sel.length === 0) return 'none';
  const chosen = sel.filter((f) => selected.has(f.key)).length;
  return chosen === 0 ? 'none' : chosen === sel.length ? 'all' : 'some';
}

export function toggleNode(n: TreeNode, selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  const keys = filesUnder(n)
    .filter((f) => f.contentAcquirable)
    .map((f) => f.key);
  if (triState(n, selected) === 'all') for (const k of keys) next.delete(k);
  else for (const k of keys) next.add(k);
  return next;
}

export function selectionSummary(entries: readonly FolderEntry[], selected: ReadonlySet<string>): { files: number; bytes: number } {
  const chosen = entries.filter((e) => selected.has(e.key));
  return { files: chosen.length, bytes: chosen.reduce((a, e) => a + e.sizeBytes, 0) };
}

/** The most items XO can keep per source today (the connector's per-sync limit). More is refused, never truncated. */
export const MAX_RETAINED_ITEMS = 200;
