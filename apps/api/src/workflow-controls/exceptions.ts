/**
 * UW-15 (ADR 0044, UAC-36) — exceptions: how often does a workflow need a person? From each run's journal:
 * a run "needs a person" if it asked for an approval (`approval_requested`) or escalated (`escalation`). Items are the steps those
 * events name, out of the run's fan-out count when it has one. The queue lists only what is still open: approvals not yet decided,
 * and runs that ended escalated. Counts, ids and step names; never inputs or outputs.
 */
export interface JournalLike {
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface ExceptionQueueItem {
  readonly runId: string;
  readonly kind: 'approval' | 'escalation';
  readonly step: string;
  readonly at: string;
}

export interface ExceptionStats {
  readonly windowDays: number;
  readonly runs: number;
  readonly runsNeedingPerson: number;
  /** runsNeedingPerson / runs, or null with no runs in the window. */
  readonly runRate: number | null;
  /** Items (fan-out cases) in runs that have a fan-out count, and how many of those needed a person. */
  readonly items: number;
  readonly itemsNeedingPerson: number;
  readonly itemRate: number | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function runException(entries: readonly JournalLike[]): {
  readonly needs: boolean;
  readonly steps: ReadonlySet<string>;
  readonly fanout: number | undefined;
  readonly startedAt: string | undefined;
  readonly open: readonly Omit<ExceptionQueueItem, 'runId'>[];
} {
  const steps = new Set<string>();
  const decided = new Set<string>();
  const requested: { step: string; at: string }[] = [];
  const open: Omit<ExceptionQueueItem, 'runId'>[] = [];
  let fanout: number | undefined;
  let startedAt: string | undefined;
  let escalated = false;
  for (const e of entries) {
    if (e.type === 'run_started') {
      startedAt = e.ts;
      const f = e.data['fanout'] as { count?: unknown } | undefined;
      if (f !== undefined && typeof f.count === 'number') fanout = f.count;
    } else if (e.type === 'approval_requested') {
      steps.add(str(e.data['step']));
      requested.push({ step: str(e.data['step']), at: e.ts });
    } else if (e.type === 'approval_decided') decided.add(str(e.data['step']));
    else if (e.type === 'escalation') {
      steps.add(str(e.data['step']) || 'run');
      escalated = true;
      open.push({ kind: 'escalation', step: str(e.data['step']) || 'run', at: e.ts });
    }
  }
  for (const r of requested) if (!decided.has(r.step)) open.push({ kind: 'approval', step: r.step, at: r.at });
  // An escalated run stays open only while it is the end state; approvals decided later are not exceptions to review again.
  return { needs: steps.size > 0 || escalated, steps, fanout, startedAt, open };
}

export function exceptionReport(
  runs: readonly { readonly runId: string; readonly entries: readonly JournalLike[] }[],
  now: Date,
  windowDays = 30,
): { readonly stats: ExceptionStats; readonly queue: readonly ExceptionQueueItem[] } {
  const since = now.getTime() - windowDays * 86_400_000;
  let n = 0;
  let needing = 0;
  let items = 0;
  let itemsNeeding = 0;
  const queue: ExceptionQueueItem[] = [];
  for (const run of runs) {
    const x = runException(run.entries);
    const at = x.startedAt === undefined ? NaN : Date.parse(x.startedAt);
    if (!(at >= since)) continue;
    n++;
    if (x.needs) needing++;
    if (x.fanout !== undefined) {
      items += x.fanout;
      itemsNeeding += Math.min(x.fanout, x.steps.size);
    }
    for (const o of x.open) queue.push({ runId: run.runId, ...o });
  }
  queue.sort((a, b) => a.at.localeCompare(b.at) || a.runId.localeCompare(b.runId));
  const rate = (a: number, b: number): number | null => (b === 0 ? null : Math.round((a / b) * 10_000) / 10_000);
  return {
    stats: {
      windowDays,
      runs: n,
      runsNeedingPerson: needing,
      runRate: rate(needing, n),
      items,
      itemsNeedingPerson: itemsNeeding,
      itemRate: rate(itemsNeeding, items),
    },
    queue,
  };
}
