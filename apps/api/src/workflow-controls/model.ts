import { createHash } from 'node:crypto';

/**
 * Per-workflow controls: what mode a workflow is in, what may start it, how often, and who signed it off. All of the
 * rules live here as pure functions so they are easy to read and to test; the store, the routes, the webhook and the
 * scheduler only apply them.
 *
 * Honest limits, stated once:
 *  - There are no external connectors in the platform yet, so "shadow" (practice) protects people from being asked,
 *    and the workspace from extra tasks; it cannot yet protect any outside system, because none is called.
 *  - "Signed off" is a recorded sign-off by a named reviewer on a specific version of the workflow. It is not a
 *    cryptographic signature, and it is not independent of the workspace (an admin can be author and reviewer).
 *  - The daily cap and the pause switch are enforced by this server process. A second server process sharing the
 *    same data directory would not see in-flight starts of the first.
 */

export const MODES = ['draft', 'shadow', 'live', 'paused'] as const;
export type WorkflowMode = (typeof MODES)[number];
export const isMode = (v: unknown): v is WorkflowMode => typeof v === 'string' && (MODES as readonly string[]).includes(v);

export type StartTrigger = 'manual' | 'webhook' | 'schedule';

export const MAX_DAILY_CAP = 100_000;
export const MIN_SCHEDULE_MINUTES = 5;
export const MAX_SCHEDULE_MINUTES = 7 * 24 * 60;

export interface ScheduleTrigger {
  readonly everyMinutes: number;
  /** When the schedule was switched on, until it first fires; then the time of the last slot it used. */
  readonly lastFiredAt: string;
  /** What happened at the last slot, in plain words (`started`, or why it was skipped). Visibility only. */
  readonly lastOutcome?: string;
  /** The fixed input every scheduled run starts with. A workflow with required fields can only be scheduled if they are given here. */
  readonly input?: Readonly<Record<string, unknown>>;
}
export const MAX_SCHEDULE_INPUT_BYTES = 8 * 1024;

export interface SignOff {
  readonly identityId: string;
  readonly displayName?: string;
  readonly at: string;
  /** The version of the workflow that was signed off (see {@link contentHash}). A change to the workflow makes this stale. */
  readonly contentHash: string;
}

export type ShadowJudgement = 'automatic' | 'person';

export interface Deployment {
  readonly deploymentKey: string;
  readonly workflowId: string;
  readonly compilationId: string;
  readonly mode: WorkflowMode;
  /** Where "resume" returns to. Set when the workflow is paused. */
  readonly modeBeforePause?: Exclude<WorkflowMode, 'paused'>;
  readonly triggers: { readonly webhook: boolean; readonly schedule?: ScheduleTrigger };
  readonly limits: { readonly dailyRunCap?: number };
  readonly signOff?: SignOff;
  /** A reviewer's judgement per shadow run: could this have been done without a person, or would a person have handled it? */
  readonly shadowReviews: Readonly<Record<string, ShadowJudgement>>;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface WorkspaceControls {
  readonly paused: boolean;
  readonly pausedAt?: string;
  readonly pausedBy?: string;
  readonly reason?: string;
  readonly revision: number;
}
export const NOT_PAUSED: WorkspaceControls = { paused: false, revision: 0 };

export function deploymentKey(compilationId: string, workflowId: string): string {
  return `wfdep_${createHash('sha256').update(`${compilationId}\n${workflowId}`).digest('hex').slice(0, 32)}`;
}

export function defaultDeployment(compilationId: string, workflowId: string, now: string): Deployment {
  return {
    deploymentKey: deploymentKey(compilationId, workflowId),
    workflowId,
    compilationId,
    mode: 'draft',
    triggers: { webhook: false },
    limits: {},
    shadowReviews: {},
    revision: 0,
    createdAt: now,
    updatedAt: now,
    updatedBy: 'system',
  };
}

/** The identity of one version of a workflow: its compilation and its ordered steps. A sign-off is tied to this. */
export function contentHash(v: {
  readonly compilationId: string;
  readonly workflowId: string;
  readonly steps: readonly { readonly order: number; readonly capabilityId: string }[];
}): string {
  return createHash('sha256')
    .update(JSON.stringify({ c: v.compilationId, w: v.workflowId, s: v.steps.map((s) => [s.order, s.capabilityId]) }))
    .digest('hex');
}

// ------------------------------------------------------------------ readiness
export type ReadinessId = 'rules' | 'runnable' | 'signed' | 'limits' | 'practice';
export interface ReadinessItem {
  readonly id: ReadinessId;
  readonly ok: boolean;
  /** One plain sentence: what is true, or what is missing. */
  readonly message: string;
}

export interface ReadinessInput {
  readonly executable: boolean;
  readonly steps: readonly { readonly approved: boolean }[];
  readonly deployment: Deployment;
  readonly currentHash: string;
  readonly shadowRuns: number;
}

export function evaluateReadiness(i: ReadinessInput): ReadinessItem[] {
  const unapproved = i.steps.filter((s) => !s.approved).length;
  const signedCurrent = i.deployment.signOff !== undefined && i.deployment.signOff.contentHash === i.currentHash;
  const cap = i.deployment.limits.dailyRunCap;
  return [
    {
      id: 'rules',
      ok: unapproved === 0 && i.steps.length > 0,
      message:
        unapproved === 0 && i.steps.length > 0
          ? 'Every rule is approved'
          : `${unapproved} of ${i.steps.length} ${i.steps.length === 1 ? 'rule still needs' : 'rules still need'} approval`,
    },
    { id: 'runnable', ok: i.executable, message: i.executable ? 'The platform can run this' : 'The platform cannot run this yet' },
    {
      id: 'signed',
      ok: signedCurrent,
      message: signedCurrent
        ? 'This version is signed off'
        : i.deployment.signOff !== undefined
          ? 'The workflow changed since it was signed off'
          : 'Nobody has signed this version off yet',
    },
    {
      id: 'limits',
      ok: cap !== undefined,
      message: cap !== undefined ? `At most ${cap} ${cap === 1 ? 'run' : 'runs'} a day` : 'No daily limit is set',
    },
    {
      id: 'practice',
      ok: i.shadowRuns > 0,
      message:
        i.shadowRuns > 0 ? `Practised on ${i.shadowRuns} ${i.shadowRuns === 1 ? 'case' : 'cases'}` : 'It has not practised on any case yet',
    },
  ];
}

export interface Refusal {
  readonly reason: string;
  readonly message: string;
}

/** Whether a workflow may move to `to`. Practising needs approved rules and a runnable workflow; going live needs every readiness item. */
export function transitionRefusal(to: WorkflowMode, readiness: readonly ReadinessItem[]): Refusal | undefined {
  const by = (id: ReadinessId) => readiness.find((r) => r.id === id);
  const need = (ids: readonly ReadinessId[]): Refusal | undefined => {
    const missing = ids.map(by).filter((r): r is ReadinessItem => r !== undefined && !r.ok);
    return missing.length === 0 ? undefined : { reason: 'not_ready', message: missing.map((m) => m.message).join('; ') };
  };
  if (to === 'shadow') return need(['rules', 'runnable']);
  if (to === 'live') return need(['rules', 'runnable', 'signed', 'limits', 'practice']);
  return undefined;
}

// ------------------------------------------------------------------ start gate
export type GateDecision =
  | { readonly allowed: true; readonly shadow: boolean }
  | {
      readonly allowed: false;
      readonly reason: 'workspace_paused' | 'workflow_paused' | 'trigger_inactive' | 'daily_cap_reached';
      readonly message: string;
    };

export function evaluateStartGate(i: {
  readonly controls: WorkspaceControls;
  readonly deployment: Deployment;
  readonly trigger: StartTrigger;
  readonly runsToday: number;
}): GateDecision {
  if (i.controls.paused)
    return {
      allowed: false,
      reason: 'workspace_paused',
      message: 'Everything is paused for this workspace, so nothing can start. Resume it from the Workflows page.',
    };
  if (i.deployment.mode === 'paused')
    return { allowed: false, reason: 'workflow_paused', message: 'This workflow is paused, so it cannot be started. Resume it first.' };
  if (i.trigger !== 'manual') {
    const on = i.trigger === 'webhook' ? i.deployment.triggers.webhook : i.deployment.triggers.schedule !== undefined;
    if (!on || (i.deployment.mode !== 'shadow' && i.deployment.mode !== 'live'))
      return {
        allowed: false,
        reason: 'trigger_inactive',
        message: `The ${i.trigger} trigger is not active: it must be switched on and the workflow must be practising or live.`,
      };
  }
  const cap = i.deployment.limits.dailyRunCap;
  if (cap !== undefined && i.runsToday >= cap)
    return {
      allowed: false,
      reason: 'daily_cap_reached',
      message: `This workflow has reached its limit of ${cap} ${cap === 1 ? 'run' : 'runs'} today. It can start again tomorrow, or raise the limit.`,
    };
  return { allowed: true, shadow: i.deployment.mode === 'shadow' };
}

/** Start of the current UTC day: "today" for the daily limit. */
export function startOfUtcDay(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

// ------------------------------------------------------------------ schedule
/** Due when a full interval has passed since the last slot. A server that was off does not catch up: it fires once. */
export function scheduleDue(d: Deployment, now: Date): boolean {
  const s = d.triggers.schedule;
  if (s === undefined) return false;
  if (d.mode !== 'shadow' && d.mode !== 'live') return false;
  const last = Date.parse(s.lastFiredAt);
  return Number.isNaN(last) || now.getTime() - last >= s.everyMinutes * 60_000;
}

// ------------------------------------------------------------------ shadow results
export interface ShadowRunLike {
  readonly workflowExecutionId: string;
  readonly status: string;
  readonly shadow?: { readonly outcome?: 'would_complete' | 'would_escalate' };
}
export interface ShadowSummary {
  /** Practice runs that finished. */
  readonly runs: number;
  readonly wouldComplete: number;
  readonly wouldEscalate: number;
  /** How many a reviewer has judged. */
  readonly reviewed: number;
  /** Of those, how many the reviewer agreed with ("could be done without a person" matches would-complete; "a person would handle it" matches would-escalate). */
  readonly agreed: number;
}

/** What shadow runs did, and how often a reviewer agreed that it was right about needing (or not needing) a person. */
export function summarizeShadow(runs: readonly ShadowRunLike[], reviews: Readonly<Record<string, ShadowJudgement>>): ShadowSummary {
  let wouldComplete = 0;
  let wouldEscalate = 0;
  let reviewed = 0;
  let agreed = 0;
  for (const r of runs) {
    const outcome = r.shadow?.outcome ?? (r.shadow !== undefined && r.status === 'succeeded' ? 'would_complete' : undefined);
    if (outcome === undefined) continue;
    if (outcome === 'would_complete') wouldComplete += 1;
    else wouldEscalate += 1;
    const judged = reviews[r.workflowExecutionId];
    if (judged === undefined) continue;
    reviewed += 1;
    if ((judged === 'automatic') === (outcome === 'would_complete')) agreed += 1;
  }
  return { runs: wouldComplete + wouldEscalate, wouldComplete, wouldEscalate, reviewed, agreed };
}

// ------------------------------------------------------------------ input validation
export function parseDailyCap(v: unknown): number | undefined | 'invalid' {
  if (v === null) return undefined; // clearing the limit
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_DAILY_CAP) return 'invalid';
  return v;
}
export function parseEveryMinutes(v: unknown): number | 'invalid' {
  return typeof v === 'number' && Number.isInteger(v) && v >= MIN_SCHEDULE_MINUTES && v <= MAX_SCHEDULE_MINUTES ? v : 'invalid';
}
