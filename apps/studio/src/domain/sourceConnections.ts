/**
 * UW-12a — how Studio words a workspace source connection. Pure: everything here comes from what the platform said.
 */
import type { OutcomeTone } from './review';
import type { DriveProvider, Freshness, SourceConnectionKind, SourceConnectionSummary, SyncReport } from '../platform/wire-sources';

export const KIND_LABEL: Readonly<Record<SourceConnectionKind, string>> = {
  local_folder: 'Folder on the XO server',
  agent_folder: 'Folder on a computer',
  microsoft_drive: 'OneDrive or SharePoint',
  google_drive: 'Google Drive',
};

export const PROVIDER_LABEL: Readonly<Record<DriveProvider, string>> = { microsoft: 'Microsoft', google: 'Google' };

const when = (iso: string): string => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
};

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function freshnessView(f: Freshness): { readonly label: string; readonly tone: OutcomeTone; readonly detail?: string } {
  switch (f.state) {
    case 'never_synced':
      return { label: 'Not synced yet', tone: 'neutral' };
    case 'current':
      return { label: 'Up to date', tone: 'success', detail: `as of ${when(f.asOf)}` };
    case 'stale':
      return {
        label: 'Out of date',
        tone: 'warning',
        detail: `last synced ${when(f.asOf)}; a sync has been due since ${when(f.dueSince)}`,
      };
    case 'needs_attention':
      return { label: 'Needs attention', tone: 'danger', detail: f.problem };
    case 'paused':
      return { label: 'Paused', tone: 'neutral', ...(f.asOf !== undefined ? { detail: `last synced ${when(f.asOf)}` } : {}) };
    case 'retired':
      return { label: 'Retired', tone: 'neutral', detail: `since ${when(f.at)}` };
  }
}

/** One line about the sync schedule, saying who does the syncing for a folder on another computer. */
export function scheduleLine(c: SourceConnectionSummary): string {
  if (c.kind === 'agent_folder')
    return 'The XO agent on that computer sends changes a few seconds after they happen, and checks every 15 minutes.';
  return c.sync.mode === 'manual' ? 'Synced when someone asks.' : `Synced every ${minutesLabel(c.sync.everyMinutes)}.`;
}

export function minutesLabel(m: number): string {
  if (m % (24 * 60) === 0) return plural(m / (24 * 60), 'day');
  if (m % 60 === 0) return plural(m / 60, 'hour');
  return plural(m, 'minute');
}

const SKIPPED: Readonly<Record<string, string>> = {
  unsupported_format: 'files in formats XO does not read',
  hidden: 'hidden files',
  sensitive_name: 'files whose names look like passwords or keys',
  excluded_directory: 'system folders',
  symlink_not_followed: 'links (never followed)',
  not_regular_file: 'special files',
  hard_linked_file: 'hard-linked files',
  too_large: 'files over 50 MiB',
  too_deep: 'items nested too deep',
  unreadable: 'unreadable items',
  shortcut_not_followed: 'shortcuts to places outside the folder (not followed)',
  native_not_exportable: 'Google files XO cannot export (such as Slides)',
};

/** What the last sync did, in a sentence, then what it left out and what failed. */
export function syncReportLines(r: SyncReport): string[] {
  const did = [
    r.added > 0 ? `${plural(r.added, 'new file')}` : '',
    r.changed > 0 ? `${plural(r.changed, 'changed file')}` : '',
    r.removed > 0 ? `${plural(r.removed, 'file')} no longer there` : '',
  ].filter((x) => x !== '');
  const lines = [
    r.outcome === 'failed'
      ? `The last sync failed${r.problem !== undefined ? `: ${r.problem}` : '.'}`
      : `${r.outcome === 'partial' ? 'The last sync was partial' : 'Last sync'} (${when(r.at)}): ${did.length > 0 ? did.join(', ') : 'nothing changed'}.`,
  ];
  if (r.truncated !== undefined) lines.push('The folder is larger than XO lists at once, so nothing was retired for being absent.');
  const skipped = Object.entries(r.skipped).filter(([, n]) => n > 0);
  if (skipped.length > 0)
    lines.push(`Left out, never read: ${skipped.map(([k, n]) => `${n} ${SKIPPED[k] ?? k.replace(/_/g, ' ')}`).join('; ')}.`);
  const failed = Object.values(r.failed).reduce((a, b) => a + b, 0);
  if (failed > 0) lines.push(`${plural(failed, 'file')} could not be read or stored.`);
  return lines;
}

/** The command a person runs on the computer whose folder is being connected. */
export function agentCommands(serverAddress: string | undefined, code: string): { readonly pair: string; readonly start: string } {
  return {
    pair: `xo agent pair --server ${serverAddress ?? '<this XO address>'} --code ${code} --folder "<the folder>"`,
    start: 'xo agent install',
  };
}

export function agentLine(c: SourceConnectionSummary): string {
  const a = c.agent;
  if (a === undefined || !a.paired) return 'Waiting for the computer to pair.';
  const who = a.label !== undefined ? `“${a.label}”` : 'the computer';
  const seen = a.lastSeenAt !== undefined ? `; last heard from ${when(a.lastSeenAt)}` : '';
  const asked = a.syncRequestedAt !== undefined ? ' A sync has been asked for; the agent picks it up within a minute.' : '';
  return `Paired with ${who}${seen}.${asked}`;
}

export function driveUnavailableLine(reason: string | undefined, name: string): string {
  if (reason === 'connections_not_configured') return `${name} needs connections set up on this XO instance (XO_CREDENTIALS_KEY).`;
  if (reason === 'provider_not_configured') return `${name} is not set up on this XO instance yet; ask its administrator.`;
  return `${name} is not available here.`;
}
