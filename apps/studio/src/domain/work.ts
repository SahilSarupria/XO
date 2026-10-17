import type { ApiProblem } from '../platform/client';
import type { Capability, Execution, Workflow, WorkflowRun, WorkflowRunStep } from '../platform/wire';
import type { OutcomeTone } from './review';

/**
 * Business-neutral derivations for the Workflows, Runs & History and Home views. Everything here is computed from
 * real platform records; nothing is stored or invented, and nothing here is a security boundary —
 * the server decides what is allowed.
 */

/** Display-only tidy of a platform name. Never used as an identity and never sent back to the platform. */
export function tidyName(name: string, max = 90): string {
  const t = name
    .replace(/\s+/g, ' ')
    .replace(/[\s:;,.→-]+$/u, '')
    .trim();
  if (t.length === 0) return 'Untitled step';
  const cased = t.charAt(0).toUpperCase() + t.slice(1);
  return cased.length > max ? `${cased.slice(0, max - 1).trimEnd()}…` : cased;
}

function titleFromSteps(firstName: string, count: number, _lastName: string | undefined): string {
  const head = tidyName(firstName, 70);
  if (count <= 1) return head;
  return `${head}, then ${count - 1} more ${count - 1 === 1 ? 'step' : 'steps'}`;
}

/** The platform names a workflow by joining its steps; for people, say what it covers and how long it is. */
export function runStepsTitle(steps: readonly { readonly name: string }[], fallback: string): string {
  const first = steps[0];
  if (first === undefined) return tidyName(fallback);
  return titleFromSteps(first.name, steps.length, steps[steps.length - 1]?.name);
}

export function workflowTitle(w: Pick<Workflow, 'steps' | 'name'>): string {
  const first = w.steps[0];
  const last = w.steps[w.steps.length - 1];
  if (first === undefined) return tidyName(w.name);
  return titleFromSteps(first.name, w.steps.length, last?.name);
}

export const ACTIVE_RUN_STATUSES: ReadonlySet<WorkflowRun['status']> = new Set(['created', 'running', 'waiting_for_human', 'interrupted']);

export function isActiveRun(r: WorkflowRun): boolean {
  return ACTIVE_RUN_STATUSES.has(r.status);
}

/** The newest still-active run of this workflow in this analysis, if the platform reports one. */
export function findActiveRun(runs: readonly WorkflowRun[], workflowId: string, compilationId: string): WorkflowRun | undefined {
  return runs
    .filter((r) => r.workflowId === workflowId && r.compilationId === compilationId && isActiveRun(r))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export interface RunView {
  readonly label: string;
  readonly tone: OutcomeTone;
  readonly summary: string;
}

export function currentStep(run: WorkflowRun): WorkflowRunStep | undefined {
  return run.currentStepIndex === null ? undefined : run.steps[run.currentStepIndex];
}

export function describeRun(run: WorkflowRun): RunView {
  const total = run.steps.length;
  const done = run.steps.filter((s) => s.status === 'succeeded').length;
  const cur = currentStep(run);
  switch (run.status) {
    case 'waiting_for_human':
      return {
        label: 'Waiting for a decision',
        tone: 'warning',
        summary: `Step ${(run.currentStepIndex ?? 0) + 1} of ${total}${cur !== undefined ? `: ${tidyName(cur.capabilityName)}` : ''}. ${done} of ${total} finished.`,
      };
    case 'succeeded':
      return { label: 'Completed', tone: 'success', summary: `All ${total} steps finished.` };
    case 'rejected':
      return {
        label: 'Stopped by a person',
        tone: 'neutral',
        summary: `A person rejected a step, so the process stopped. ${done} of ${total} steps finished first.`,
      };
    case 'failed':
      return {
        label: 'Did not complete',
        tone: 'danger',
        summary: run.errorMessage ?? `A step failed. ${done} of ${total} steps finished first.`,
      };
    case 'interrupted':
      return {
        label: 'Interrupted',
        tone: 'warning',
        summary: `The service stopped while step ${(run.currentStepIndex ?? 0) + 1} of ${total}${cur !== undefined ? ` (${tidyName(cur.capabilityName)})` : ''} was running. ${done} of ${total} steps had finished. You can continue it from Tasks.`,
      };
    case 'created':
    case 'running':
      return { label: 'Running', tone: 'neutral', summary: `${done} of ${total} steps finished.` };
  }
}

/** Interrupted runs: the platform supports continuing these with its own resume operation. */
export function recoverableRuns(runs: readonly WorkflowRun[]): WorkflowRun[] {
  return runs.filter((r) => r.status === 'interrupted').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** A refused continue, in words. 409 means the run changed; nothing was re-run. */
export function describeRecoveryProblem(p: ApiProblem): WorkProblemView | undefined {
  if (p.status === 409) {
    const why =
      p.reason === 'stale_revision'
        ? 'Someone else, or another window, changed this process after you opened it.'
        : p.reason === 'terminal'
          ? 'This process has already finished.'
          : p.reason === 'in_flight'
            ? 'XO is already working on this process.'
            : 'This process changed after you opened it.';
    return {
      kind: 'conflict',
      title: 'This process has changed',
      body: `${why} It was not continued again. The latest state is shown below.`,
      items: [],
    };
  }
  if (p.status === 400)
    return { kind: 'bad_request', title: 'XO could not continue this process', body: `${p.message} Nothing changed.`, items: [] };
  return undefined;
}

/** Runs that need a person right now. Only what the platform marks as waiting, with the identifiers a resume needs. */
export function pendingTasks(runs: readonly WorkflowRun[]): WorkflowRun[] {
  return runs
    .filter((r) => r.status === 'waiting_for_human' && r.pendingHumanTask !== undefined && r.currentStepExecutionId !== undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Workflow steps are real capability executions, so they also appear in the plain execution list.
 * To avoid showing one decision twice, executions that belong to a workflow run are set aside.
 */
export function standaloneExecutions(executions: readonly Execution[], runs: readonly WorkflowRun[]): Execution[] {
  const owned = new Set<string>();
  for (const r of runs) for (const s of r.steps) if (s.executionId !== undefined) owned.add(s.executionId);
  return executions.filter((e) => !owned.has(e.executionId));
}

export interface StartReadiness {
  readonly canStart: boolean;
  /** Plain-language reason Start is unavailable; absent when it can start. */
  readonly reason?: string;
  /** Steps whose capability is not approved (or not resolved) according to the current view. */
  readonly needApproval: readonly string[];
}

/** Advisory only. The server re-checks approval on every start and its answer always wins. */
export function startReadiness(w: Workflow, caps: readonly Capability[] | undefined): StartReadiness {
  if (!w.executable) return { canStart: false, reason: 'The platform cannot run this process yet.', needApproval: [] };
  if (caps === undefined) return { canStart: false, reason: 'Checking approvals…', needApproval: [] };
  const byId = new Map(caps.map((c) => [c.capabilityId, c]));
  const needApproval = w.steps.filter((s) => byId.get(s.capabilityId)?.approved !== true).map((s) => tidyName(s.name));
  if (needApproval.length > 0) {
    return {
      canStart: false,
      reason: `${needApproval.length} of ${w.steps.length} steps still need your approval before this can start.`,
      needApproval,
    };
  }
  return { canStart: true, needApproval: [] };
}

/** How many steps of a workflow are decisions a person makes, per each step's own execution class. */
export function humanStepCount(w: Workflow, caps: readonly Capability[] | undefined): number | undefined {
  if (caps === undefined) return undefined;
  const byId = new Map(caps.map((c) => [c.capabilityId, c]));
  return w.steps.filter((s) => byId.get(s.capabilityId)?.executionClass === 'human_in_the_loop').length;
}

/** Turns the platform's per-capability denial sentences into the step names the person recognises. */
export function stepsNamedInDenials(denials: readonly string[], w: Pick<Workflow, 'steps'>): string[] {
  const names: string[] = [];
  for (const d of denials) {
    const m = /capability "([^"]+)"/.exec(d);
    const step = m?.[1] === undefined ? undefined : w.steps.find((s) => s.capabilityId === m[1]);
    if (step !== undefined && !names.includes(tidyName(step.name))) names.push(tidyName(step.name));
  }
  return names;
}

export type WorkProblemKind = 'needs_approval' | 'forbidden' | 'conflict' | 'bad_request' | 'unavailable' | 'other';
export interface WorkProblemView {
  readonly kind: WorkProblemKind;
  readonly title: string;
  readonly body: string;
  /** Names to list under the message (e.g. the steps that still need approval). */
  readonly items: readonly string[];
}

/** A refused start, in words. Distinguishes the known "not approved" denial from any other refusal. */
export function describeStartProblem(p: ApiProblem, w: Pick<Workflow, 'steps'>): WorkProblemView | undefined {
  if (p.kind === 'forbidden') {
    const named = p.denials === undefined ? [] : stepsNamedInDenials(p.denials, w);
    const approvalDenial = p.denials?.some((d) => /not approved/i.test(d)) === true;
    if (approvalDenial && named.length > 0) {
      return {
        kind: 'needs_approval',
        title: 'Some steps need approval first',
        body: 'XO did not start this process because these steps have no recorded approval. Approve them in Sources, then start again. Nothing ran.',
        items: named,
      };
    }
    if (approvalDenial) {
      return {
        kind: 'needs_approval',
        title: 'Some steps need approval first',
        body: 'XO did not start this process because a step has no recorded approval. Approve the steps in Sources, then start again. Nothing ran.',
        items: [],
      };
    }
    return {
      kind: 'forbidden',
      title: 'XO did not allow this',
      body: 'Your account is not permitted to start this process. Nothing ran. Ask an administrator for access.',
      items: [],
    };
  }
  if (p.status === 409 && (p.reason === 'idempotency_key_expired' || p.reason === 'idempotency_key_reused')) {
    return {
      kind: 'conflict',
      title: 'XO did not start this',
      body: 'This start request could not be matched to the earlier attempt, so nothing was created. Start it again; Studio will use a new request.',
      items: [],
    };
  }
  return undefined;
}

/** What a 409 / 400 from a resume means for the person. Reasons come from the platform's own error context. */
export function describeResumeProblem(p: ApiProblem): WorkProblemView | undefined {
  if (p.status === 409) {
    const why =
      p.reason === 'stale_revision' || p.reason === 'stale_step_execution'
        ? 'Someone else, or another window, changed this process after you opened it.'
        : p.reason === 'terminal'
          ? 'This process has already finished.'
          : p.reason === 'not_resumable'
            ? 'This process is not waiting for a decision any more.'
            : p.reason === 'in_flight'
              ? 'XO is still working on this process.'
              : 'This process changed after you opened it.';
    return {
      kind: 'conflict',
      title: 'This process has changed',
      body: `${why} Your decision was not applied. The latest state is shown below; choose again if a decision is still needed.`,
      items: [],
    };
  }
  if (p.status === 400) {
    return {
      kind: 'bad_request',
      title: 'XO could not read that decision',
      body: `${p.message} Nothing changed. Reload the page and try again.`,
      items: [],
    };
  }
  return undefined;
}

export function stepStatusLabel(s: WorkflowRunStep['status']): string {
  switch (s) {
    case 'pending':
      return 'Not started';
    case 'running':
      return 'Running';
    case 'waiting_for_human':
      return 'Waiting for a decision';
    case 'succeeded':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'rejected':
      return 'Rejected';
    case 'skipped':
      return 'Skipped';
    case 'interrupted':
      return 'Interrupted';
  }
}

/** The most a note may hold. The platform allows 8 KB of decision data; this keeps a note a note. */
export const NOTE_MAX_CHARS = 500;

/** Trims; an empty or whitespace-only note is no note. Never truncates silently: too long is a validation error. */
export function normalizeNote(raw: string): { readonly note?: string; readonly error?: string } {
  const t = raw.trim();
  if (t.length === 0) return {};
  if (t.length > NOTE_MAX_CHARS) return { error: `Keep the note to ${NOTE_MAX_CHARS} characters or fewer (it is ${t.length}).` };
  return { note: t };
}

export interface RecordedNote {
  readonly note: string;
  readonly by?: string;
  readonly at?: string;
}

/** Notes the platform has recorded, keyed by the step execution they were attached to. Only what the platform returned. */
export function recordedNotes(executions: readonly Execution[]): Map<string, RecordedNote> {
  const out = new Map<string, RecordedNote>();
  for (const e of executions) {
    const h = e.humanTask;
    if (h?.status === 'resolved' && h.decisionNote !== undefined && h.decisionNote.length > 0) {
      out.set(e.executionId, {
        note: h.decisionNote,
        ...(h.resolverId !== undefined ? { by: h.resolverId } : {}),
        ...(h.resolvedAt !== undefined ? { at: h.resolvedAt } : {}),
      });
    }
  }
  return out;
}

/** A fresh key for ONE start intent (8-128 chars of A-Za-z0-9_.:- as the platform requires). Reused only to retry that same intent. */
export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const id = c?.randomUUID !== undefined ? c.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  return `xo-start-${id}`;
}

/** A failure where the platform may or may not have received the request. Such outcomes are never retried automatically. */
export function isAmbiguousFailure(p: ApiProblem): boolean {
  return p.kind === 'network' || p.kind === 'server' || p.kind === 'malformed';
}
