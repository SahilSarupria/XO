import type { Capability, Workflow, WorkflowControl, WorkflowMode, WorkflowRun } from '../platform/wire';
import type { OutcomeTone } from './review';
import { describeRun, findActiveRun, humanStepCount, startReadiness, workflowTitle } from './work';

/**
 * What the Workflows page shows for one workflow, built ONLY from what the platform reports today: the workflow and its
 * steps, each step's approval and execution class, and the run history. Things the platform does not report yet (a
 * live/shadow mode, schedules and other triggers, connector permissions, limits, shadow results, a signed version) are
 * not here at all, so the page cannot show them by accident. When the platform starts reporting them, they are added to
 * this one place.
 */
export type NeedKind = 'decision' | 'failed' | 'rules' | 'practice' | 'limit' | 'blocked' | 'checking' | 'clear';
export interface Need {
  readonly kind: NeedKind;
  /** The chip text. */
  readonly text: string;
  readonly tone: OutcomeTone | 'ok';
}
export type FilterKey = 'all' | 'needs' | 'inprogress' | 'ready' | 'blocked' | 'live' | 'shadow' | 'paused';

export interface WorkflowSummary {
  readonly workflow: Workflow;
  readonly id: string;
  readonly title: string;
  /** The line under the name: how many steps, and how many need a person. */
  readonly sub: string;
  /** The status pill. Same words as before the redesign. */
  readonly status: {
    readonly label: string;
    readonly tone: OutcomeTone;
    /** Set when the pill shows the workflow's mode (live, shadow, paused) rather than its readiness. */ readonly mode?: WorkflowMode;
  };
  /** What the platform reports about the workflow's controls; `undefined` on a platform that does not report them yet. */
  readonly control: WorkflowControl | undefined;
  /** How it can start. "Someone starts it" is always there; the others only when switched on, and `active` says whether they are firing now. */
  readonly triggers: readonly { readonly kind: 'manual' | 'webhook' | 'schedule'; readonly label: string; readonly active: boolean }[];
  /** Practice runs a reviewer has not judged yet. */
  readonly unreviewedCases: number;
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

/** "Every 30 minutes", "Every 2 hours", "Every day". */
export function describeEvery(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? 'Every day' : `Every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? 'Every hour' : `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}
const MODE_LABEL: Readonly<Record<WorkflowMode, string>> = { draft: 'Draft', shadow: 'Shadow', live: 'Live', paused: 'Paused' };
export const modeLabel = (m: WorkflowMode): string => MODE_LABEL[m];

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
  control?: WorkflowControl,
  /** The workspace-wide pause is on. */
  allPaused = false,
): WorkflowSummary {
  const ready = startReadiness(w, caps);
  const active = findActiveRun(runs, w.workflowId, w.compilationId);
  const mine = runs.filter((r) => r.workflowId === w.workflowId && r.compilationId === w.compilationId);
  const lastRun = [...mine].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const person = humanStepCount(w, caps);
  const split = person === undefined ? undefined : { xo: w.stepCount - person, person };

  const readinessStatus =
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
  // A workflow that is live, practising or paused shows that; a draft keeps the readiness words (they say what is missing).
  const mode = control?.mode;
  const status =
    mode === 'live'
      ? { label: 'Live', tone: 'success' as OutcomeTone, mode }
      : mode === 'shadow'
        ? { label: 'Shadow', tone: 'neutral' as OutcomeTone, mode }
        : mode === 'paused'
          ? { label: 'Paused', tone: 'warning' as OutcomeTone, mode }
          : readinessStatus;

  const unreviewedCases = control === undefined ? 0 : control.shadowCases.filter((c) => c.judgement === undefined).length;
  let need: Need;
  if (active !== undefined && (active.status === 'waiting_for_human' || active.status === 'interrupted')) {
    need = { kind: 'decision', text: 'A person must decide', tone: 'warning' };
  } else if (active === undefined && lastRun?.status === 'failed') {
    need = { kind: 'failed', text: 'Last run failed', tone: 'danger' };
  } else if (active === undefined && ready.needApproval.length > 0) {
    const n = ready.needApproval.length;
    need = { kind: 'rules', text: `${n} ${plural(n, 'rule', 'rules')} to approve`, tone: 'warning' };
  } else if (control !== undefined && control.mode === 'shadow' && unreviewedCases > 0) {
    need = {
      kind: 'practice',
      text: `${unreviewedCases} ${plural(unreviewedCases, 'case', 'cases')} to review`,
      tone: 'warning',
    };
  } else if (control !== undefined && control.limits.dailyRunCap !== undefined && control.limits.runsToday >= control.limits.dailyRunCap) {
    need = { kind: 'limit', text: 'Daily limit reached', tone: 'neutral' };
  } else if (!w.executable) {
    need = { kind: 'blocked', text: 'Can’t run yet', tone: 'neutral' };
  } else if (caps === undefined) {
    need = { kind: 'checking', text: capsFailed ? 'Could not check approvals' : 'Checking approvals…', tone: 'neutral' };
  } else {
    need = { kind: 'clear', text: 'All clear', tone: 'ok' };
  }

  const filters = new Set<FilterKey>(['all']);
  if (need.kind === 'decision' || need.kind === 'failed' || need.kind === 'rules' || need.kind === 'practice') filters.add('needs');
  if (active !== undefined) filters.add('inprogress');
  else if (ready.canStart) filters.add('ready');
  if (!w.executable) filters.add('blocked');
  if (mode === 'live' || mode === 'shadow' || mode === 'paused') filters.add(mode);

  const sub =
    `${w.stepCount} ${plural(w.stepCount, 'step', 'steps')}` +
    (person !== undefined && person > 0 ? ` · ${person} ${plural(person, 'needs', 'need')} a person` : '');

  const firing = control !== undefined && !allPaused && (mode === 'shadow' || mode === 'live');
  const triggers: WorkflowSummary['triggers'][number][] = [{ kind: 'manual', label: 'Someone starts it', active: true }];
  if (control?.triggers.webhook === true) triggers.push({ kind: 'webhook', label: 'Webhook', active: firing });
  if (control?.triggers.schedule !== undefined)
    triggers.push({ kind: 'schedule', label: describeEvery(control.triggers.schedule.everyMinutes), active: firing });

  return {
    workflow: w,
    id: w.workflowId,
    title: workflowTitle(w),
    sub,
    status,
    control,
    triggers,
    unreviewedCases,
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
  readonly kind: 'decision' | 'failed' | 'rules' | 'practice';
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
    } else if (k === 'practice') {
      const n = s.unreviewedCases;
      out.push({
        workflowId: s.id,
        title: s.title,
        kind: k,
        sentence: `${n} practice ${plural(n, 'case is', 'cases are')} waiting for your judgement`,
        action: 'Review cases',
      });
    }
  }
  const rank = { decision: 0, failed: 1, rules: 2, practice: 3 } as const;
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

export function countFilters(all: readonly WorkflowSummary[]): Record<FilterKey, number> {
  const c: Record<FilterKey, number> = { all: 0, needs: 0, inprogress: 0, ready: 0, blocked: 0, live: 0, shadow: 0, paused: 0 };
  for (const s of all) for (const f of s.filters) c[f] += 1;
  return c;
}

export function matchesQuery(s: WorkflowSummary, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === '') return true;
  return s.title.toLowerCase().includes(needle) || s.workflow.description.toLowerCase().includes(needle);
}
