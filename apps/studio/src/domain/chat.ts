import type { ChatSummary } from '../platform/wire-studio';

/** An installed XO that can be attached to a message with "@name". The API takes installed XO names. */
export interface Attachable {
  readonly id: string;
  readonly label: string;
}

/** `@bur` -> the XO names that contain it (case-insensitive); only when the caret is inside an @-word. */
export function mentionQuery(text: string): string | undefined {
  const m = /(?:^|\s)@([\w.-]*)$/.exec(text);
  return m === null ? undefined : (m[1] ?? '');
}

export function matchXos<T extends { readonly label: string }>(xos: readonly T[], query: string): T[] {
  const q = query.toLowerCase();
  return xos.filter((x) => x.label.toLowerCase().includes(q));
}

export interface ChatGroup {
  readonly label: string;
  readonly threads: readonly ChatSummary[];
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** Threads grouped by local calendar day of their last update, newest first: Today, Yesterday, then the date. */
export function groupByDay(threads: readonly ChatSummary[], now: Date = new Date()): ChatGroup[] {
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const groups = new Map<string, { label: string; threads: ChatSummary[] }>();
  for (const t of [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const d = new Date(t.updatedAt);
    const key = Number.isNaN(d.getTime()) ? 'unknown' : dayKey(d);
    const label =
      key === 'unknown'
        ? 'Earlier'
        : key === dayKey(now)
          ? 'Today'
          : key === dayKey(yesterday)
            ? 'Yesterday'
            : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    const g = groups.get(key) ?? { label, threads: [] };
    g.threads.push(t);
    groups.set(key, g);
  }
  return [...groups.values()];
}

export type ChatHint = 'settings' | 'nothing_saved' | 'gone' | undefined;

/** What to add to the platform's own message for the chat refusals that have a next step. */
export function chatHint(p: { readonly status?: number }): ChatHint {
  if (p.status === 412) return 'settings';
  if (p.status === 502) return 'nothing_saved';
  if (p.status === 404) return 'gone';
  return undefined;
}
