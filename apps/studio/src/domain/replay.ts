import type { WorkflowRun, WorkflowRunStep, WorkflowStepStatus } from '../platform/wire';

/** How a step is drawn at a given replay position. */
export type ReplayState = 'upcoming' | 'done' | 'waiting' | 'failed' | 'skipped';

export interface ReplayNode {
  readonly stepId: string;
  readonly name: string;
  readonly state: ReplayState;
  /** The step being described by the caption right now. */
  readonly current: boolean;
  readonly recorded: WorkflowStepStatus;
  readonly errorMessage: string | undefined;
}

const STATE_OF: Record<WorkflowStepStatus, ReplayState> = {
  succeeded: 'done',
  failed: 'failed',
  rejected: 'failed',
  waiting_for_human: 'waiting',
  interrupted: 'waiting',
  skipped: 'skipped',
  running: 'waiting',
  pending: 'upcoming',
};

const WORDS: Record<WorkflowStepStatus, string> = {
  succeeded: 'finished',
  failed: 'did not complete',
  rejected: 'was declined by a person',
  waiting_for_human: 'is waiting for a person',
  interrupted: 'was stopped',
  skipped: 'was skipped',
  running: 'was running',
  pending: 'had not started',
};

/**
 * The platform records the order and final outcome of each step, not when each started or how long it took. A replay
 * therefore reveals steps one at a time in their recorded order; it never shows timings or intermediate states.
 */
export function replayFrame(run: Pick<WorkflowRun, 'steps'>, position: number): { nodes: ReplayNode[]; caption: string } {
  const steps: readonly WorkflowRunStep[] = [...run.steps].sort((a, b) => a.order - b.order);
  const shown = Math.max(0, Math.min(position, steps.length));
  const nodes = steps.map<ReplayNode>((s, i) => ({
    stepId: s.stepId,
    name: s.capabilityName,
    state: i < shown ? STATE_OF[s.status] : 'upcoming',
    current: i === shown - 1,
    recorded: s.status,
    errorMessage: s.errorMessage,
  }));
  const at = shown === 0 ? undefined : steps[shown - 1];
  const caption =
    at === undefined
      ? 'Move the slider or press Play to step through this run.'
      : `Step ${shown} of ${steps.length}: ${at.capabilityName} ${WORDS[at.status]}.`;
  return { nodes, caption };
}
