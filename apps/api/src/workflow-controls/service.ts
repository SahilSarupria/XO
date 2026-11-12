import { ErrorCode, XoError } from '@xo/errors';
import { TERMINAL_WORKFLOW_STATUSES } from '../workflows/workflow-execution.js';
import { listWorkflowExecutions, type WorkflowRunnerContext } from '../workflows/workflow-runner.js';
import type { WorkflowView } from '../workflows/workflow-catalog.js';
import type { FsControlsStore } from './fs-controls-store.js';
import {
  contentHash,
  defaultDeployment,
  evaluateReadiness,
  evaluateStartGate,
  startOfUtcDay,
  summarizeShadow,
  transitionRefusal,
  type Deployment,
  type ReadinessItem,
  type ShadowSummary,
  type StartTrigger,
  type WorkflowMode,
  type WorkspaceControls,
} from './model.js';

export interface ShadowCase {
  readonly workflowExecutionId: string;
  readonly createdAt: string;
  readonly outcome: 'would_complete' | 'would_escalate';
  readonly stepName?: string;
  readonly judgement?: 'automatic' | 'person';
}

/** What the API tells a client about one workflow's controls. Never contains anything secret. */
export interface DeploymentView {
  readonly workflowId: string;
  readonly compilationId: string;
  readonly mode: WorkflowMode;
  readonly triggers: {
    readonly manual: true;
    readonly webhook: boolean;
    readonly schedule?: {
      readonly everyMinutes: number;
      readonly lastFiredAt: string;
      readonly lastOutcome?: string;
      readonly input?: Readonly<Record<string, unknown>>;
    };
  };
  readonly limits: { readonly dailyRunCap?: number; readonly runsToday: number };
  readonly signOff?: { readonly identityId: string; readonly displayName?: string; readonly at: string; readonly current: boolean };
  readonly readiness: readonly ReadinessItem[];
  readonly canGoLive: boolean;
  readonly shadow: ShadowSummary;
  /** The most recent practice runs, newest first, with the reviewer's judgement if there is one. */
  readonly shadowCases: readonly ShadowCase[];
  readonly revision: number;
  readonly updatedAt?: string;
}

const RECENT_CASES = 10;

type RunLite = Awaited<ReturnType<typeof listWorkflowExecutions>>[number];

export function viewOf(v: WorkflowView, stored: Deployment | undefined, runs: readonly RunLite[], now: Date): DeploymentView {
  const d = stored ?? defaultDeployment(v.compilationId, v.workflowId, now.toISOString());
  const mine = runs.filter((r) => r.workflowId === v.workflowId && r.compilationId === v.compilationId);
  const dayStart = startOfUtcDay(now);
  const runsToday = mine.filter((r) => Date.parse(r.createdAt) >= dayStart).length;
  const shadowRuns = mine.filter((r) => r.shadow !== undefined && TERMINAL_WORKFLOW_STATUSES.has(r.status));
  const shadow = summarizeShadow(shadowRuns, d.shadowReviews);
  const hash = contentHash(v);
  const readiness = evaluateReadiness({
    executable: v.executable,
    steps: v.steps,
    deployment: d,
    currentHash: hash,
    shadowRuns: shadow.runs,
  });
  const cases: ShadowCase[] = [...shadowRuns]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, RECENT_CASES)
    .flatMap((r): ShadowCase[] => {
      const outcome = r.shadow?.outcome ?? 'would_complete';
      const judgement = d.shadowReviews[r.workflowExecutionId];
      return [
        {
          workflowExecutionId: r.workflowExecutionId,
          createdAt: r.createdAt,
          outcome,
          ...(r.shadow?.stepName !== undefined ? { stepName: r.shadow.stepName } : {}),
          ...(judgement !== undefined ? { judgement } : {}),
        },
      ];
    });
  const sched = d.triggers.schedule;
  return {
    workflowId: v.workflowId,
    compilationId: v.compilationId,
    mode: d.mode,
    triggers: {
      manual: true,
      webhook: d.triggers.webhook,
      ...(sched !== undefined
        ? {
            schedule: {
              everyMinutes: sched.everyMinutes,
              lastFiredAt: sched.lastFiredAt,
              ...(sched.lastOutcome !== undefined ? { lastOutcome: sched.lastOutcome } : {}),
              ...(sched.input !== undefined ? { input: sched.input } : {}),
            },
          }
        : {}),
    },
    limits: { ...(d.limits.dailyRunCap !== undefined ? { dailyRunCap: d.limits.dailyRunCap } : {}), runsToday },
    ...(d.signOff !== undefined
      ? {
          signOff: {
            identityId: d.signOff.identityId,
            ...(d.signOff.displayName !== undefined ? { displayName: d.signOff.displayName } : {}),
            at: d.signOff.at,
            current: d.signOff.contentHash === hash,
          },
        }
      : {}),
    readiness,
    canGoLive: transitionRefusal('live', readiness) === undefined,
    shadow,
    shadowCases: cases,
    revision: d.revision,
    ...(stored !== undefined ? { updatedAt: d.updatedAt } : {}),
  };
}

export class StartRefusedError extends XoError {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(ErrorCode.PRECONDITION_FAILED, message, { context: { reason } });
  }
}

/**
 * The one check every start goes through (manual, webhook, schedule): is everything paused, is this workflow paused,
 * is the trigger active, has today's limit been reached? Returns whether to run it as practice. Throws
 * {@link StartRefusedError} (HTTP 412 with a `reason`) otherwise. Fails closed: if the controls cannot be read, the
 * error propagates and nothing starts.
 */
export async function enforceStart(
  store: FsControlsStore,
  ctx: WorkflowRunnerContext,
  target: { readonly compilationId: string; readonly workflowId: string },
  trigger: StartTrigger,
  now: Date,
): Promise<{ readonly shadow: boolean }> {
  const controls = await store.getControls();
  const stored = await store.getDeployment(target.compilationId, target.workflowId);
  const deployment = stored ?? defaultDeployment(target.compilationId, target.workflowId, now.toISOString());
  const needsCount = deployment.limits.dailyRunCap !== undefined;
  const runsToday = needsCount ? await countRunsToday(ctx, target, now) : 0;
  const decision = evaluateStartGate({ controls, deployment, trigger, runsToday });
  if (!decision.allowed) throw new StartRefusedError(decision.reason, decision.message);
  return { shadow: decision.shadow };
}

/** Only the global switch: for starts that are not a compiled workflow (a saved draft). */
export async function enforceNotPaused(store: FsControlsStore): Promise<void> {
  const controls: WorkspaceControls = await store.getControls();
  if (controls.paused)
    throw new StartRefusedError(
      'workspace_paused',
      'Everything is paused for this workspace, so nothing can start. Resume it from the Workflows page.',
    );
}

export async function countRunsToday(
  ctx: WorkflowRunnerContext,
  target: { readonly compilationId: string; readonly workflowId: string },
  now: Date,
): Promise<number> {
  const runs = await listWorkflowExecutions(ctx);
  const dayStart = startOfUtcDay(now);
  return runs.filter(
    (r) => r.workflowId === target.workflowId && r.compilationId === target.compilationId && Date.parse(r.createdAt) >= dayStart,
  ).length;
}

import type { StartWorkflowRequest } from '../workflows/workflow-runner.js';

/**
 * Starts a compiled workflow through the gate. Every entry point that is not a person on the draft launcher uses this.
 * The gate only decides whether a start is ALLOWED (pause, limits, practice mode); the start itself is the caller's audited,
 * idempotent, approval-checked and authorized path (`startWorkflowAudited`), so no trigger has a weaker way in.
 */
export async function startGated<T>(
  store: FsControlsStore,
  ctx: WorkflowRunnerContext,
  request: Omit<StartWorkflowRequest, 'shadow' | 'trigger'>,
  trigger: StartTrigger,
  now: Date,
  start: (gated: StartWorkflowRequest) => Promise<T>,
): Promise<T> {
  const { shadow } = await enforceStart(store, ctx, request, trigger, now);
  return start({
    ...request,
    ...(shadow ? { shadow: true } : {}),
    ...(trigger !== 'manual' ? { trigger } : {}),
  });
}
