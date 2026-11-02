import type { Capability, Workflow, WorkflowRun } from '../platform/wire';
import type { OutcomeTone } from './review';
import { describeRun, findActiveRun, humanStepCount, startReadiness, workflowTitle } from './work';

/**
 * What the Workflows page shows for one workflow, built ONLY from what the platform reports today: the workflow and its
 * steps, each step's approval and execution class, and the run history. Things the platform does not report yet (a
 * live/shadow mode, schedules and other triggers, connector permissions, limits, shadow results, a signed version) are
 * not here at all, so the page cannot show them by accident. When the platform starts reporting them, they are added to
 * this one place.
 */
export type NeedKind = 'decision' | 'failed' | 'rules' | 'blocked' | 'checking' | 'clear';
export interface Need {
  readonly kind: NeedKind;
  /** The chip text. */
  readonly text: string;
  readonly tone: OutcomeTone | 'ok';
}
export type FilterKey = 'all' | 'needs' | 'inprogress' | 'ready' | 'blocked';

export interface WorkflowSummary {
  readonly workflow: Workflow;
  readonly id: string;
  readonly title: string;
  /** The line under the name: how many steps, and how many need a person. */
  readonly sub: string;
  /** The status pill. Same words as before the redesign. */
  readonly status: { readonly label: string; readonly tone: OutcomeTone };
  /** The one thing that needs the person most, or "clear". */
  readonly need: Need;
  /** Names of steps whose rules still need approval. */
  readonly needApproval: readonly string[];
  readonly active: WorkflowRun | undefined;
  /** Steps XO carries out vs. steps a person decides; `undefined` while approvals cannot be read. */
  readonly split: { readonly xo: number; readonly person: number } | undefined;
  /** Runs started in the last 7 days, oldest day first. */
  readonly week: { readonly total: number; readonly perDay: readonly number[] };
  readonly lastRun: WorkflowRun | undefined;
  readonly filters: ReadonlySet<FilterKey>;
}

const DAY = 24 * 60 * 60 * 1000;

/** Runs of this workflow started in the 7 days up to `now`, counted per day (index 6 is today). */
export function weekOfRuns(runs: readonly WorkflowRun[], workflowId: string, now: number): { total: number; perDay: number[] } {
  const perDay = [0, 0, 0, 0, 0, 0, 0];
  let total = 0;
  for (const r of runs) {
    if (r.workflowId !== workflowId) continue;
    const t = Date.parse(r.createdAt);
    if (Number.isNaN(t) || t > now) continue;
    const back = Math.floor((now - t) / DAY);
    if (back > 6) continue;
    perDay[6 - back]! += 1;
    total += 1;
  }
  return { total, perDay };
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function summarizeWorkflow(
  w: Workflow,
  caps: readonly Capability[] | undefined,
  capsFailed: boolean,
  runs: readonly WorkflowRun[],
  now: number,
): WorkflowSummary {
  const ready = startReadiness(w, caps);
  const active = findActiveRun(runs, w.workflowId, w.compilationId);
  const mine = runs.filter((r) => r.workflowId === w.workflowId && r.compilationId === w.compilationId);
  const lastRun = [...mine].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const person = humanStepCount(w, caps);
  const split = person === undefined ? undefined : { xo: w.stepCount - person, person };

  const status =
    active !== undefined
      ? { label: describeRun(active).label, tone: describeRun(active).tone }
      : {
          label: !w.executable
            ? 'Cannot run yet'
            : capsFailed && caps === undefined
              ? 'Unavailable'
              : ready.needApproval.length > 0
                ? 'Needs approval'
                : ready.canStart
                  ? 'Ready to start'
                  : 'Checking…',
          tone: (ready.canStart ? 'success' : 'warning') as OutcomeTone,
        };

  let need: Need;
  if (active !== undefined && (active.status === 'waiting_for_human' || active.status === 'interrupted')) {
    need = { kind: 'decision', text: 'A person must decide', tone: 'warning' };
  } else if (active === undefined && lastRun?.status === 'failed') {
    need = { kind: 'failed', text: 'Last run failed', tone: 'danger' };
  } else if (active === undefined && ready.needApproval.length > 0) {
    const n = ready.needApproval.length;
    need = { kind: 'rules', text: `${n} ${plural(n, 'rule', 'rules')} to approve`, tone: 'warning' };
  } else if (!w.executable) {
    need = { kind: 'blocked', text: 'Can’t run yet', tone: 'neutral' };
  } else if (caps === undefined) {
    need = { kind: 'checking', text: capsFailed ? 'Could not check approvals' : 'Checking approvals…', tone: 'neutral' };
  } else {
    need = { kind: 'clear', text: 'All clear', tone: 'ok' };
  }

  const filters = new Set<FilterKey>(['all']);
  if (need.kind === 'decision' || need.kind === 'failed' || need.kind === 'rules') filters.add('needs');
  if (active !== undefined) filters.add('inprogress');
  else if (ready.canStart) filters.add('ready');
  if (!w.executable) filters.add('blocked');

  const sub =
    `${w.stepCount} ${plural(w.stepCount, 'step', 'steps')}` +
    (person !== undefined && person > 0 ? ` · ${person} ${plural(person, 'needs', 'need')} a person` : '');

  return {
    workflow: w,
    id: w.workflowId,
    title: workflowTitle(w),
    sub,
    status,
    need,
    needApproval: ready.needApproval,
    active,
    split,
    week: weekOfRuns(mine, w.workflowId, now),
    lastRun,
    filters,
  };
}

export interface NeedItem {
  readonly workflowId: string;
  readonly title: string;
  readonly kind: 'decision' | 'failed' | 'rules';
  readonly sentence: string;
  readonly action: string;
}

/** The "needs you" card: one plain sentence and one button per workflow that is waiting on a person. */
export function needItems(all: readonly WorkflowSummary[]): NeedItem[] {
  const out: NeedItem[] = [];
  for (const s of all) {
    const k = s.need.kind;
    if (k === 'decision')
      out.push({ workflowId: s.id, title: s.title, kind: k, sentence: 'A decision is waiting for you', action: 'Decide now' });
    else if (k === 'failed')
      out.push({ workflowId: s.id, title: s.title, kind: k, sentence: 'A run did not finish', action: 'See what happened' });
    else if (k === 'rules') {
      const n = s.needApproval.length;
      out.push({
        workflowId: s.id,
        title: s.title,
        kind: k,
        sentence: `${n} ${plural(n, 'rule needs', 'rules need')} your approval before this can start`,
        action: 'Review rules',
      });
    }
  }
  const rank = { decision: 0, failed: 1, rules: 2 } as const;
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

export function countFilters(all: readonly WorkflowSummary[]): Record<FilterKey, number> {
  const c: Record<FilterKey, number> = { all: 0, needs: 0, inprogress: 0, ready: 0, blocked: 0 };
  for (const s of all) for (const f of s.filters) c[f] += 1;
  return c;
}

export function matchesQuery(s: WorkflowSummary, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === '') return true;
  return s.title.toLowerCase().includes(needle) || s.workflow.description.toLowerCase().includes(needle);
}
