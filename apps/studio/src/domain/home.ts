import type { WorkflowRun } from '../platform/wire';
import { isActiveRun, pendingTasks } from './work';
import type { StartTarget } from './start';

/** Counts taken straight from the platform's run records. Nothing here is estimated or placeholder. */
export interface HomeMetrics {
  readonly total: number;
  readonly inProgress: number;
  readonly waiting: number;
  readonly finished: number;
  readonly succeeded: number;
  /** Whole percent of finished runs that succeeded; undefined until at least one run has finished. */
  readonly successPercent: number | undefined;
  /** Median time from start to completion across finished runs, in ms; undefined until one has finished. */
  readonly medianMs: number | undefined;
}

export function homeMetrics(runs: readonly WorkflowRun[]): HomeMetrics {
  const finishedRuns = runs.filter((r) => !isActiveRun(r));
  const succeeded = finishedRuns.filter((r) => r.status === 'succeeded').length;
  return {
    total: runs.length,
    inProgress: runs.filter((r) => isActiveRun(r) && r.status !== 'waiting_for_human' && r.status !== 'interrupted').length,
    waiting: pendingTasks(runs).length,
    finished: finishedRuns.length,
    succeeded,
    successPercent: finishedRuns.length === 0 ? undefined : Math.round((succeeded / finishedRuns.length) * 100),
    medianMs: median(
      finishedRuns
        .flatMap((r) => (r.completedAt === undefined ? [] : [Date.parse(r.completedAt) - Date.parse(r.createdAt)]))
        .filter((n) => Number.isFinite(n) && n >= 0),
    ),
  };
}

function median(xs: readonly number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : Math.round(((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2);
}

/** "412 ms", "3.2 s", "2 min": the unit that reads best, never more precision than the data has. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

/** One value per day for the last `days` days (oldest first), computed from the runs' own timestamps. */
export function dailySeries(
  runs: readonly WorkflowRun[],
  value: (day: readonly WorkflowRun[]) => number,
  now: Date = new Date(),
  days = 7,
): number[] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const buckets: WorkflowRun[][] = Array.from({ length: days }, () => []);
  for (const r of runs) {
    const t = Date.parse(r.createdAt);
    if (!Number.isFinite(t)) continue;
    const back = Math.floor(
      (start - new Date(new Date(t).getFullYear(), new Date(t).getMonth(), new Date(t).getDate()).getTime()) / 86_400_000,
    );
    if (back >= 0 && back < days) buckets[days - 1 - back]?.push(r);
  }
  return buckets.map((b) => value(b));
}

export interface ScriptedReply {
  readonly text: string;
  readonly action?: { readonly label: string; readonly target: StartTarget };
}

/**
 * Placeholder for the assistant until AI is connected: fixed replies chosen by keyword that point at real places in
 * Studio. It never claims to have done anything and never produces content about the user's documents.
 */
export function scriptedReply(input: string): ScriptedReply {
  const q = input.toLowerCase();
  if (/(decision|task|waiting|pending|approve this)/.test(q)) {
    return { text: 'Decisions that need a person are collected in Tasks.', action: { label: 'Open Tasks', target: 'tasks' } };
  }
  if (/(compile|analy[sz]e|upload|document|pdf|source|policy)/.test(q)) {
    return {
      text: 'Add your document first, then start the analysis from there.',
      action: { label: 'Open Documents', target: 'documents' },
    };
  }
  if (/(rule|review|approval)/.test(q)) {
    return {
      text: 'Rules XO found are reviewed and approved before any process may use them.',
      action: { label: 'Review rules', target: 'rules' },
    };
  }
  if (/(run|start|process|workflow)/.test(q)) {
    return { text: 'Processes you can start are listed under Processes.', action: { label: 'Open Processes', target: 'workflows' } };
  }
  return {
    text: 'This assistant is a preview. For now it can point you to Documents, Rules, Processes and Tasks. Try “analyse my policy” or “what is waiting for me”.',
  };
}
