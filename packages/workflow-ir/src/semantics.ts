import { createHash } from 'node:crypto';
import { parseTemplate } from './refs.js';
import type { Step, WorkflowDef } from './types.js';

/**
 * Workflow IR semantics 1.0 — the normative execution rules, expressed as pure
 * functions and tables so that two independent runtimes can be tested against the
 * same vectors (see conformance/). docs/WORKFLOW_IR.md is the prose form.
 *
 * Summary of the model
 *  - A run executes one workflow instance (or one forEach item) over an acyclic graph.
 *  - A step is READY when every step in `needs` is `succeeded` or `skipped`.
 *  - A READY step whose `runIf` is falsy becomes `skipped` without running.
 *  - Reading an output of a `skipped` step is an error unless the binding is `optional`
 *    (then the input is absent and a step that needs it fails closed).
 *  - At most `maxConcurrency` steps are `running` at once. READY steps are started in
 *    document order, so a scheduler's choices are deterministic.
 *  - Any step failure after retries applies `onError` (default `fail`):
 *      fail      -> run `failed`; steps not started become `cancelled`; no compensation
 *      escalate  -> run `escalated` (hands the case to a human); steps not started are `cancelled`
 *      compensate-> run `compensating`: completed steps that declare `compensatedBy` are
 *                   compensated in reverse completion order; success => `compensated`;
 *                   a missing compensation or a failed one => `escalated`
 *  - Cancellation behaves as a failure with `cancellation.onCancel` as the policy.
 */

export const STEP_STATES = [
  'pending',
  'ready',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
  'timed_out',
  'compensated',
] as const;
export type StepState = (typeof STEP_STATES)[number];
export const RUN_STATES = [
  'created',
  'running',
  'waiting',
  'completed',
  'failed',
  'escalated',
  'cancelled',
  'compensating',
  'compensated',
] as const;
export type RunState = (typeof RUN_STATES)[number];

const STEP_TRANSITIONS: Readonly<Record<StepState, readonly StepState[]>> = {
  pending: ['ready', 'skipped', 'cancelled'],
  ready: ['running', 'skipped', 'cancelled'],
  running: ['succeeded', 'failed', 'waiting', 'timed_out', 'cancelled'],
  waiting: ['succeeded', 'failed', 'timed_out', 'cancelled'],
  // `timed_out` and `failed` can be retried by moving back to `ready` while attempts remain.
  failed: ['ready'],
  timed_out: ['ready'],
  succeeded: ['compensated'],
  skipped: [],
  cancelled: [],
  compensated: [],
};
const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  created: ['running', 'cancelled'],
  running: ['waiting', 'completed', 'failed', 'escalated', 'cancelled', 'compensating'],
  waiting: ['running', 'failed', 'escalated', 'cancelled', 'compensating'],
  compensating: ['compensated', 'escalated'],
  completed: [],
  failed: [],
  escalated: [],
  cancelled: [],
  compensated: [],
};

export const isLegalStepTransition = (from: StepState, to: StepState): boolean => STEP_TRANSITIONS[from].includes(to);
export const isLegalRunTransition = (from: RunState, to: RunState): boolean => RUN_TRANSITIONS[from].includes(to);
export const isTerminalRunState = (s: RunState): boolean => RUN_TRANSITIONS[s].length === 0;
export const isTerminalStepState = (s: StepState): boolean => s === 'skipped' || s === 'cancelled' || s === 'compensated';

export interface StepRuntimeView {
  readonly state: StepState;
}

/** Steps that are READY now: every dependency finished (`succeeded` or `skipped`) and the step itself still `pending`. Document order. */
export function readySteps(wf: WorkflowDef, states: ReadonlyMap<string, StepState>): string[] {
  return wf.steps
    .filter((s) => s.type !== 'compensate' && (states.get(s.id) ?? 'pending') === 'pending')
    .filter((s) => (s.needs ?? []).every((n) => states.get(n) === 'succeeded' || states.get(n) === 'skipped'))
    .map((s) => s.id);
}

/** How many more steps may start given the workflow's concurrency bound. */
export function startBudget(wf: WorkflowDef, states: ReadonlyMap<string, StepState>): number {
  let running = 0;
  for (const st of states.values()) if (st === 'running') running++;
  return Math.max(0, wf.maxConcurrency - running);
}

/** Compensation order: succeeded steps with a declared compensation, most recently completed first. */
export function compensationPlan(
  wf: WorkflowDef,
  completionOrder: readonly string[],
): { readonly compensate: readonly string[]; readonly uncompensatable: readonly string[] } {
  const byId = new Map(wf.steps.map((s) => [s.id, s]));
  const compensate: string[] = [];
  const uncompensatable: string[] = [];
  for (const id of [...completionOrder].reverse()) {
    const s = byId.get(id);
    if (s === undefined || s.type !== 'act' || s.sideEffect === 'read') continue;
    if (s.compensatedBy !== undefined) compensate.push(s.compensatedBy);
    else uncompensatable.push(id);
  }
  return { compensate, uncompensatable };
}

/** Backoff delay for a 1-based failed attempt. `random` in [0,1) is injected so replays are testable; full jitter draws uniformly from [0, delay]. */
export function backoffDelayMs(step: Step, failedAttempt: number, random: () => number): number {
  const r = step.retry;
  if (r === undefined) return 0;
  const raw = r.backoff.kind === 'fixed' ? r.backoff.baseMs : r.backoff.baseMs * 2 ** (failedAttempt - 1);
  const capped = Math.min(raw, r.backoff.maxMs);
  return r.backoff.jitter === 'full' ? Math.floor(random() * (capped + 1)) : capped;
}

/** Canonical JSON: keys sorted, no insignificant whitespace. Hash inputs MUST use this so two runtimes agree byte for byte. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export interface InstanceId {
  readonly runId: string;
  /** forEach item index, else 0. */
  readonly index: number;
}

/**
 * The identity of one approval decision. Derived, never authored, so an approval
 * granted for one run, step or item can never satisfy another: `appr_<sha256>`.
 */
export function approvalIdentity(wf: Pick<WorkflowDef, 'id' | 'version'>, stepId: string, inst: InstanceId): string {
  return `appr_${sha256Hex(canonicalJson({ w: wf.id, v: wf.version, s: stepId, r: inst.runId, i: inst.index }))}`;
}

export type RefResolver = (ref: string) => string | number | boolean | null | undefined;

/**
 * Renders a validated idempotency-key template. An unresolvable placeholder makes
 * the call refuse to run (returns undefined): a key that silently degrades to a
 * constant would collapse distinct actions into one.
 */
export function renderIdempotencyKey(
  template: string,
  wf: Pick<WorkflowDef, 'id' | 'version'>,
  stepId: string,
  resolve: RefResolver,
): string | undefined {
  const t = parseTemplate(template);
  if ('error' in t) return undefined;
  let out = '';
  for (const p of t.parts) {
    if ('literal' in p) out += p.literal;
    else if ('ident' in p) out += p.ident === 'step.id' ? stepId : p.ident === 'workflow.id' ? wf.id : wf.version;
    else {
      const name = p.ref.kind === 'step' ? `steps.${p.ref.step}.${p.ref.output}` : `${p.ref.kind}.${p.ref.name}`;
      const v = resolve(name);
      if (v === undefined || v === null) return undefined;
      out += String(v);
    }
  }
  return out;
}

/**
 * The key actually sent to an external system: namespaced by workflow+version+step so
 * that equal business keys in different steps never collide, then hashed so no
 * business data leaks into a third-party system's logs. A takeover runner derives the
 * identical value from the same journal inputs.
 */
export function externalIdempotencyKey(wf: Pick<WorkflowDef, 'id' | 'version'>, stepId: string, rendered: string): string {
  return `xo_${sha256Hex(canonicalJson({ w: wf.id, s: stepId, k: rendered }))}`;
}
