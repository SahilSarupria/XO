import type { DecisionTree } from '@xo/capability-layer';
import { ConnectorError, type ConnectorHost, type Json } from '@xo/connectors';
import {
  DETERMINISTIC_HOST,
  approvalIdentity,
  backoffDelayMs,
  canonicalJson,
  compensationPlan,
  evaluateDecide,
  externalIdempotencyKey,
  hasSideEffects,
  negotiateWorkflows,
  parseRef,
  readySteps,
  renderIdempotencyKey,
  sha256Hex,
  type ActStep,
  type CompensateStep,
  type FieldSpec,
  type RunState,
  type Scalar,
  type Step,
  type StepState,
  type WorkflowComponent,
  type WorkflowDef,
  type WorkflowHostSupport,
} from '@xo/workflow-ir';
import { CircuitBreakers, Semaphore } from './breaker.js';
import {
  ApprovalError,
  verifyDecision,
  type ApprovalRequest,
  type ApprovalSink,
  type ReviewerRegistry,
  type SignedDecision,
} from './approvals.js';
import type { JournalEntry, RunStoreLike } from './journal.js';
import { LeaseError, type LeaseClient } from './lease.js';
import { ExtractionMemo, type UsageCaps } from './limits.js';
import { evaluateExpression, type Scope } from '@xo/capability-layer';
import { isExtractionRefusal } from './extraction-refusal.js';

/** What this runner implements. `for_each` and `wait_event` are not built yet; `approve` needs `approvals` options; workflows needing them are refused whole. */
export const RUNNER_FEATURES = ['approve', 'wait_timer', 'compensation', 'model_extract', 'lookup', 'rules', 'authority_ceilings'] as const;

export interface Extractor {
  extract(req: {
    readonly instruction: string;
    readonly text?: string;
    readonly fields: Readonly<Record<string, FieldSpec>>;
    readonly grounding: 'none' | 'quote_required';
    /** The step's model-call budget; an extractor must never make more calls than this (and must report the true count). */
    readonly maxModelCalls?: number;
  }): Promise<{ readonly facts: Readonly<Record<string, Scalar>>; readonly modelCalls: number }>;
}

export interface Escalation {
  readonly runId: string;
  readonly workflow: string;
  readonly step: string | null;
  readonly code: string;
  readonly reason: string;
  readonly target?: string;
  readonly lane?: string;
  /** Completed side effects that could not be undone (no compensation declared). */
  readonly uncompensated?: readonly string[];
}

export interface RunnerOptions {
  readonly component: WorkflowComponent;
  readonly workflowId: string;
  readonly store: RunStoreLike;
  /**
   * Run ownership. When set, every start/resume/decision first acquires the run's lease, heartbeats while driving, and releases after.
   * `attach/detach` bind the fencing token to the store you passed (a LeasedRunStore, or the remote store from @xo/sdk).
   */
  readonly lease?: {
    readonly client: LeaseClient;
    readonly owner: string;
    readonly ttlMs: number;
    /** 0 disables the timer (tests drive heartbeats by hand). Default ttlMs/3. */
    readonly heartbeatEveryMs?: number;
    readonly attach: (runId: string, token: number) => void;
    readonly detach: (runId: string) => void;
  };
  readonly connectors: ConnectorHost;
  readonly trees?: ReadonlyMap<string, DecisionTree>;
  readonly extractor?: Extractor;
  readonly dryRun?: boolean;
  /** Checked before every step start; true escalates the run without executing anything further. */
  readonly killSwitch?: () => boolean;
  readonly onEscalate?: (e: Escalation) => void | Promise<void>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly breakers?: CircuitBreakers;
  /** Max concurrent calls per connector. Default 4. */
  readonly connectorConcurrency?: number;
  /** Required to run workflows with approve steps. */
  /** Shadow mode: decide everything, execute NO connector call; each would-be action is journaled as `shadow_action`. */
  readonly shadow?: boolean;
  readonly caps?: UsageCaps;
  /** Directory for extraction memoization. Identical normalized cases reuse validated facts instead of calling the model. */
  readonly memoDir?: string;
  readonly approvals?: { readonly reviewers: ReviewerRegistry; readonly sink?: ApprovalSink };
}

export interface RunResult {
  readonly runId: string;
  readonly state: RunState;
  readonly outputs?: Readonly<Record<string, unknown>>;
  readonly escalation?: Escalation;
  readonly accepted: boolean;
}

export class RunInputError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`invalid run input: ${problems.join('; ')}`);
    this.name = 'RunInputError';
  }
}

interface StepRec {
  state: StepState;
  attempt: number;
  outputs?: Record<string, unknown>;
  callOutcome?: { ok: boolean; data?: Json; code?: string };
  waitUntil?: number;
  approval?: { request: ApprovalRequest; deadline: number };
  modelCalls: number;
  rulesFired?: string[];
}
interface RunRec {
  runId: string;
  state: RunState;
  inputs: Record<string, unknown>;
  startedAt: number;
  dryRun: boolean;
  shadow: boolean;
  steps: Map<string, StepRec>;
  order: string[];
  result?: Record<string, unknown>;
  escalation?: Escalation;
}

const TRANSIENT = new Set(['FAILED', 'TIMEOUT', 'CIRCUIT_OPEN']);
/** Bounded wait: a hung model call must not hang a run. (The underlying request cannot be cancelled through `Extractor`; it is abandoned, and its late result is ignored.) */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  // a late rejection from the abandoned call must not become an unhandled rejection
  p.catch(() => undefined);
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function replayRun(entries: readonly JournalEntry[], wf: WorkflowDef, runId: string): RunRec | undefined {
  let rec: RunRec | undefined;
  const step = (id: string): StepRec => {
    let s = rec?.steps.get(id);
    if (s === undefined) {
      s = { state: 'pending', attempt: 0, modelCalls: 0 };
      rec?.steps.set(id, s);
    }
    return s;
  };
  for (const e of entries) {
    // Journal entries are written only by this module; the shapes below are the ones appended in this file.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = e.data as Record<string, any>;
    if (e.type === 'run_started') {
      rec = {
        runId,
        state: 'running',
        inputs: d['inputs'],
        startedAt: d['startedAtMs'],
        dryRun: d['dryRun'] === true,
        shadow: d['shadow'] === true,
        steps: new Map(),
        order: [],
      };
      for (const s of wf.steps) rec.steps.set(s.id, { state: 'pending', attempt: 0, modelCalls: 0 });
      continue;
    }
    if (rec === undefined) continue;
    switch (e.type) {
      case 'step_started': {
        const s = step(d['step']);
        s.state = 'running';
        s.attempt = d['attempt'];
        break;
      }
      case 'call_outcome':
        step(d['step']).callOutcome = { ok: d['ok'], data: d['data'], code: d['code'] };
        break;
      case 'step_succeeded': {
        const s = step(d['step']);
        s.state = 'succeeded';
        s.outputs = d['outputs'];
        s.modelCalls = d['modelCalls'] ?? 0;
        if (d['rulesFired'] !== undefined) s.rulesFired = d['rulesFired'];
        rec.order.push(d['step']);
        break;
      }
      case 'step_skipped':
        step(d['step']).state = 'skipped';
        break;
      case 'step_failed':
        step(d['step']).state = 'failed';
        break;
      case 'wait_started': {
        const s = step(d['step']);
        s.state = 'waiting';
        s.waitUntil = d['until'];
        break;
      }
      case 'approval_requested': {
        const s = step(d['step']);
        s.state = 'waiting';
        s.approval = { request: d['request'], deadline: Date.parse(d['request'].expiresAt) };
        break;
      }
      case 'approval_decided': {
        const s = step(d['step']);
        s.state = 'succeeded';
        s.outputs = d['outputs'];
        rec.order.push(d['step']);
        break;
      }
      case 'step_cancelled':
        step(d['step']).state = 'cancelled';
        break;
      case 'escalation':
        rec.escalation = d as unknown as Escalation;
        break;
      case 'run_state':
        rec.state = d['state'];
        break;
      case 'run_finished':
        rec.state = d['state'];
        rec.result = d['result'];
        break;
    }
  }
  if (rec !== undefined) for (const s of rec.steps.values()) if (s.state === 'running') s.state = 'pending'; // crashed mid-step: re-run (external calls reuse their key)
  return rec;
}

function typeProblem(name: string, spec: FieldSpec & { required?: boolean }, v: unknown): string | undefined {
  if (v === undefined) return spec.required === true ? `${name} is required` : undefined;
  if (v === null) return spec.nullable === true ? undefined : `${name} must not be null`;
  switch (spec.type) {
    case 'string':
      return typeof v === 'string' && (spec.maxBytes === undefined || Buffer.byteLength(v) <= spec.maxBytes)
        ? undefined
        : `${name} must be a string within its size limit`;
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? undefined : `${name} must be a finite number`;
    case 'integer':
      return Number.isInteger(v) ? undefined : `${name} must be an integer`;
    case 'boolean':
      return typeof v === 'boolean' ? undefined : `${name} must be a boolean`;
    case 'enum':
      return typeof v === 'string' && (spec.enum ?? []).includes(v) ? undefined : `${name} must be one of ${(spec.enum ?? []).join(', ')}`;
    case 'json':
      return Buffer.byteLength(JSON.stringify(v)) <= (spec.maxBytes ?? 0) ? undefined : `${name} exceeds its maxBytes`;
  }
}

export class WorkflowRunner {
  private readonly wf: WorkflowDef;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly breakers: CircuitBreakers;
  private readonly sems = new Map<string, Semaphore>();
  private readonly active = new Set<string>();

  constructor(private readonly o: RunnerOptions) {
    const wf = o.component.workflows.find((w) => w.id === o.workflowId);
    if (wf === undefined) throw new Error(`workflow "${o.workflowId}" is not in this component`);
    const support: WorkflowHostSupport = {
      ...DETERMINISTIC_HOST,
      features: [...RUNNER_FEATURES].filter(
        (f) => (f !== 'model_extract' || o.extractor !== undefined) && (f !== 'approve' || o.approvals !== undefined),
      ),
      modelCapabilities: o.extractor !== undefined ? ['structured_output'] : [],
    };
    const neg = negotiateWorkflows({ ...o.component, workflows: [wf] }, support);
    if (neg.refused.length > 0) throw new Error(`workflow "${wf.id}" cannot run on this runner: ${neg.refused[0]?.reasons.join('; ')}`);
    this.wf = wf;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? sleepReal;
    this.random = o.random ?? Math.random;
    this.breakers = o.breakers ?? new CircuitBreakers(5, 30_000, this.now);
  }

  /** Accepts a run at most once per runId (or per dedupeKey) and drives it. Re-sending an accepted run returns its state without re-executing. */
  async start(req: {
    readonly inputs: Record<string, unknown>;
    readonly runId?: string;
    readonly dedupeKey?: string;
    readonly triggerId?: string;
  }): Promise<RunResult> {
    const problems: string[] = [];
    for (const [k, spec] of Object.entries(this.wf.inputs)) {
      const p = typeProblem(k, spec, req.inputs[k]);
      if (p !== undefined) problems.push(p);
    }
    for (const k of Object.keys(req.inputs)) if (!(k in this.wf.inputs)) problems.push(`unknown input "${k}"`);
    if (problems.length > 0) throw new RunInputError(problems);
    const runId =
      req.runId ??
      (req.dedupeKey !== undefined
        ? `run_${sha256Hex(canonicalJson({ w: this.wf.id, d: req.dedupeKey })).slice(0, 32)}`
        : `run_${sha256Hex(`${this.wf.id}:${this.now()}:${this.random()}`).slice(0, 32)}`);
    const created = await this.o.store.create(runId);
    if (!created) return { ...(await this.status(runId)), accepted: false };
    return this.withLease(runId, async () => {
      await this.o.store.append(runId, 'run_started', {
        workflow: this.wf.id,
        version: this.wf.version,
        inputs: req.inputs,
        triggerId: req.triggerId ?? null,
        dryRun: this.o.dryRun === true,
        shadow: this.o.shadow === true,
        startedAtMs: this.now(),
      });
      return { ...(await this.drive(runId)), accepted: true };
    });
  }

  /** Continues a run from its journal: after a crash, after a timer elapses, or after a kill-switch is cleared. */
  async resume(runId: string): Promise<RunResult> {
    return this.withLease(runId, async () => ({ ...(await this.drive(runId)), accepted: false }));
  }

  /**
   * Holds the run's lease around `fn`. Losing it (heartbeat refused, or a fenced write refused) stops the runner: it throws LeaseError('LOST')
   * and must not retry; reconcile by reading status from the authoritative journal.
   */
  private async withLease<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const l = this.o.lease;
    if (l === undefined) return fn();
    const lease = await l.client.acquire(runId, l.owner, l.ttlMs);
    l.attach(runId, lease.token);
    let lost: LeaseError | undefined;
    const every = l.heartbeatEveryMs ?? Math.floor(l.ttlMs / 3);
    const timer =
      every > 0
        ? setInterval(() => {
            l.client.heartbeat(runId, l.owner, lease.token, l.ttlMs).catch((e: unknown) => {
              lost = e instanceof LeaseError ? e : new LeaseError('LOST', (e as Error).message);
            });
          }, every)
        : undefined;
    timer?.unref();
    try {
      const r = await fn();
      if (lost !== undefined) throw lost;
      return r;
    } finally {
      if (timer !== undefined) clearInterval(timer);
      l.detach(runId);
      await l.client.release(runId, l.owner, lease.token).catch(() => undefined);
    }
  }

  async status(runId: string): Promise<Omit<RunResult, 'accepted'>> {
    const rec = replayRun(await this.o.store.read(runId), this.wf, runId);
    if (rec === undefined) throw new Error(`unknown run ${runId}`);
    return {
      runId,
      state: rec.state,
      ...(rec.result !== undefined ? { outputs: rec.result } : {}),
      ...(rec.escalation !== undefined ? { escalation: rec.escalation } : {}),
    };
  }

  /** Resumes every run that is waiting on a timer. Call periodically. */
  async tick(): Promise<RunResult[]> {
    const out: RunResult[] = [];
    for (const id of await this.o.store.list()) {
      const rec = replayRun(await this.o.store.read(id), this.wf, id);
      if (rec?.state !== 'waiting' && rec?.state !== 'running') continue;
      try {
        out.push(await this.resume(id));
      } catch (e) {
        if (e instanceof LeaseError && e.code === 'HELD') continue; // another runner owns it; not ours to touch
        throw e;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------------

  private async drive(runId: string): Promise<Omit<RunResult, 'accepted'>> {
    if (this.active.has(runId)) throw new Error(`run ${runId} is already being driven by this runner`);
    this.active.add(runId);
    try {
      const { store } = this.o;
      let rec = replayRun(await store.read(runId), this.wf, runId);
      if (rec === undefined) throw new Error(`unknown run ${runId}`);
      const terminal = (s: RunState): boolean => ['completed', 'failed', 'escalated', 'cancelled', 'compensated'].includes(s);
      const reload = async (): Promise<RunRec> => (rec = replayRun(await store.read(runId), this.wf, runId) as RunRec);
      if (terminal(rec.state)) return this.summary(runId, rec);
      if (rec.state === 'waiting') await store.append(runId, 'run_state', { state: 'running' });

      for (let guard = 0; guard < 10_000; guard++) {
        rec = await reload();
        if (terminal(rec.state)) break;
        if (this.o.killSwitch?.() === true) return this.escalate(runId, null, 'KILL_SWITCH', 'kill switch is engaged');
        if (this.now() - rec.startedAt > this.wf.runTimeoutMs)
          return this.escalate(runId, null, 'RUN_TIMEOUT', `run exceeded ${this.wf.runTimeoutMs}ms`);

        const states = new Map([...rec.steps].map(([id, s]) => [id, s.state] as const));
        // approval requests that outlived their deadline escalate; they are never approved by default
        for (const [id, s] of rec.steps)
          if (s.state === 'waiting' && s.approval !== undefined && this.now() >= s.approval.deadline) {
            await store.append(runId, 'step_failed', { step: id, code: 'APPROVAL_TIMEOUT', message: 'no decision before the deadline' });
            return this.escalate(runId, id, 'APPROVAL_TIMEOUT', `approval ${s.approval.request.approvalId} expired without a decision`);
          }
        // due timers
        for (const [id, s] of rec.steps)
          if (s.state === 'waiting' && s.waitUntil !== undefined && this.now() >= s.waitUntil)
            await store.append(runId, 'step_succeeded', { step: id, outputs: {}, modelCalls: 0 });
        if ([...rec.steps.values()].some((s) => s.state === 'waiting' && s.waitUntil !== undefined && this.now() >= s.waitUntil)) continue;

        const ready = readySteps(this.wf, states);
        let progressed = false;
        const toRun: Step[] = [];
        for (const id of ready) {
          const step = this.wf.steps.find((s) => s.id === id) as Step;
          const { values, missing } = this.resolveInputs(step, rec);
          if (step.runIf !== undefined) {
            let truthy: boolean;
            try {
              truthy = Boolean(evaluateExpression(step.runIf, values as Scope));
            } catch (e) {
              return this.failStep(runId, step, 'RUNIF_ERROR', (e as Error).message);
            }
            if (!truthy) {
              await store.append(runId, 'step_skipped', { step: id });
              progressed = true;
              continue;
            }
          }
          if (missing.length > 0) return this.failStep(runId, step, 'MISSING_INPUT', `step input(s) unavailable: ${missing.join(', ')}`);
          toRun.push(step);
        }
        if (progressed) continue;

        if (toRun.length === 0) {
          const open = [...rec.steps.entries()].filter(
            ([id, s]) => this.wf.steps.find((x) => x.id === id)?.type !== 'compensate' && !['succeeded', 'skipped'].includes(s.state),
          );
          if (open.length === 0) {
            const result = this.resolveResult(rec);
            if (result === undefined) return this.escalate(runId, null, 'RESULT_UNAVAILABLE', 'a declared result value is unavailable');
            await store.append(runId, 'run_finished', { state: 'completed', result });
            continue;
          }
          const parked = open.filter(([, s]) => s.state === 'waiting');
          if (parked.length > 0 && open.every(([, s]) => s.state === 'waiting' || s.state === 'pending')) {
            if (rec.state !== 'waiting') await store.append(runId, 'run_state', { state: 'waiting' });
            const until = Math.min(...parked.map(([, s]) => s.waitUntil ?? s.approval?.deadline ?? Infinity));
            if (this.o.sleep === undefined || until === Infinity || parked.some(([, s]) => s.approval !== undefined)) break; // leave it to tick() / decide()
            await this.sleep(Math.max(0, until - this.now()));
            continue;
          }
          break; // nothing runnable and not waiting: a dependency failed; state was already set by failStep
        }

        const batch = toRun.slice(0, Math.max(1, this.wf.maxConcurrency));
        const failures = await Promise.all(batch.map((s) => this.runStep(runId, s, rec as RunRec)));
        const failed = failures.find((f) => f !== undefined);
        if (failed !== undefined) return failed;
      }
      return this.summary(runId, await reload());
    } finally {
      this.active.delete(runId);
    }
  }

  private summary(runId: string, rec: RunRec): Omit<RunResult, 'accepted'> {
    return {
      runId,
      state: rec.state,
      ...(rec.result !== undefined ? { outputs: rec.result } : {}),
      ...(rec.escalation !== undefined ? { escalation: rec.escalation } : {}),
    };
  }

  private resolveRef(from: string, rec: RunRec): { found: boolean; value?: unknown } {
    const ref = parseRef(from);
    if (ref === undefined) return { found: false };
    if (ref.kind === 'input')
      return ref.name in rec.inputs && rec.inputs[ref.name] !== undefined ? { found: true, value: rec.inputs[ref.name] } : { found: false };
    if (ref.kind === 'run') return { found: true, value: ref.name === 'id' ? rec.runId : 0 };
    if (ref.kind === 'step') {
      const s = rec.steps.get(ref.step);
      return s?.state === 'succeeded' && s.outputs !== undefined && ref.output in s.outputs
        ? { found: true, value: s.outputs[ref.output] }
        : { found: false };
    }
    return { found: false };
  }

  private resolveInputs(step: Step, rec: RunRec): { values: Record<string, unknown>; missing: string[] } {
    const values: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const [name, b] of Object.entries(step.inputs ?? {})) {
      if ('const' in b) values[name] = b.const;
      else {
        const r = this.resolveRef(b.from, rec);
        if (r.found) values[name] = r.value;
        else if (b.optional !== true) missing.push(name);
      }
    }
    return { values, missing };
  }

  private resolveResult(rec: RunRec): Record<string, unknown> | undefined {
    const out: Record<string, unknown> = {};
    for (const [name, b] of Object.entries(this.wf.result ?? {})) {
      if ('const' in b) out[name] = b.const;
      else {
        const r = this.resolveRef(b.from, rec);
        if (r.found) out[name] = r.value;
        else if (b.optional !== true) return undefined;
      }
    }
    return out;
  }

  private buildRequest(
    runId: string,
    step: Extract<Step, { type: 'approve' }>,
    values: Record<string, unknown>,
    rec: RunRec,
  ): ApprovalRequest {
    const now = this.now();
    const editable = Object.fromEntries(Object.entries(step.outputs ?? {}).filter(([k]) => k !== 'decision'));
    const dependents = this.wf.steps
      .filter((s) => (s.type === 'act' || s.type === 'compensate') && closureHas(this.wf, s.id, step.id))
      .map((s) => `${(s as ActStep).connector}.${(s as ActStep).operation} (${(s as ActStep).sideEffect}) in step ${s.id}`);
    const render = (t: string): string =>
      t.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, p: string) => {
        if (p === 'workflow.id') return this.wf.id;
        if (p === 'workflow.version') return this.wf.version;
        if (p === 'step.id') return step.id;
        const r = this.resolveRef(p, rec);
        return r.found && r.value !== null ? String(r.value) : '(unknown)';
      });
    return {
      approvalId: approvalIdentity(this.wf, step.id, { runId, index: 0 }),
      runId,
      workflow: this.wf.id,
      version: this.wf.version,
      step: step.id,
      roles: step.roles,
      summary: render(step.summary),
      case: values,
      evidence: Object.fromEntries((step.evidence ?? []).map((k) => [k, values[k] ?? null])),
      trace: [...rec.steps]
        .filter(([, s]) => s.rulesFired !== undefined)
        .map(([id, s]) => ({ step: id, rulesFired: s.rulesFired as string[] })),
      proposedActions: dependents,
      allowEdit: step.allowEdit === true,
      editable,
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + step.timeoutMs).toISOString(),
    };
  }

  /** Pending approval requests across runs (for a frontend to list). Auditors and anyone else read the same data; deciding needs a signed decision. */
  async listApprovals(): Promise<ApprovalRequest[]> {
    const out: ApprovalRequest[] = [];
    for (const id of await this.o.store.list()) {
      const rec = replayRun(await this.o.store.read(id), this.wf, id);
      if (rec === undefined) continue;
      for (const s of rec.steps.values()) if (s.state === 'waiting' && s.approval !== undefined) out.push(s.approval.request);
    }
    return out;
  }

  async getApproval(approvalId: string): Promise<ApprovalRequest | undefined> {
    return (await this.listApprovals()).find((r) => r.approvalId === approvalId);
  }

  /**
   * Applies a signed reviewer decision, then continues the run. Refusals (unknown/expired/already-decided request, unknown or revoked
   * reviewer, bad signature, role not permitted, bad edits) throw ApprovalError and change nothing. The decision is journaled with its
   * signature, so `xo explain` and audits can re-verify it later.
   */
  async decideApproval(runId: string, d: SignedDecision): Promise<RunResult> {
    if (this.o.approvals === undefined) throw new Error('this runner has no approvals configuration');
    return this.withLease(runId, () => this.decideLocked(runId, d));
  }

  private async decideLocked(runId: string, d: SignedDecision): Promise<RunResult> {
    const rec = replayRun(await this.o.store.read(runId), this.wf, runId);
    if (rec === undefined) throw new ApprovalError('UNKNOWN_APPROVAL', `unknown run ${runId}`);
    const pending = [...rec.steps.entries()].find(([, s]) => s.approval?.request.approvalId === d.payload.approvalId);
    if (pending === undefined) throw new ApprovalError('UNKNOWN_APPROVAL', 'no such approval request on this run');
    const [stepId, sr] = pending;
    const reviewers = this.o.approvals?.reviewers;
    if (reviewers === undefined) throw new Error('this runner has no approvals configuration');
    if (sr.state !== 'waiting') throw new ApprovalError('ALREADY_DECIDED', 'this approval was already decided or is no longer pending');
    const { role, outputs } = verifyDecision((sr.approval as { request: ApprovalRequest }).request, d, reviewers, this.now());
    await this.o.store.append(runId, 'approval_decided', {
      step: stepId,
      approvalId: d.payload.approvalId,
      reviewerId: d.payload.reviewerId,
      role,
      action: d.payload.action,
      outputs,
      payload: d.payload as unknown as Record<string, unknown>,
      signature: d.signature,
    });
    return { ...(await this.drive(runId)), accepted: false };
  }

  private async escalate(
    runId: string,
    stepId: string | null,
    code: string,
    reason: string,
    extra: Partial<Escalation> = {},
  ): Promise<Omit<RunResult, 'accepted'>> {
    const e: Escalation = { runId, workflow: this.wf.id, step: stepId, code, reason, ...extra };
    await this.o.store.append(runId, 'escalation', e as unknown as Record<string, unknown>);
    const rec0 = replayRun(await this.o.store.read(runId), this.wf, runId) as RunRec;
    for (const [id, s] of rec0.steps)
      if (['pending', 'ready', 'waiting'].includes(s.state) && this.wf.steps.find((x) => x.id === id)?.type !== 'compensate')
        await this.o.store.append(runId, 'step_cancelled', { step: id });
    await this.o.store.append(runId, 'run_state', { state: 'escalated' });
    await this.o.onEscalate?.(e);
    return { runId, state: 'escalated', escalation: e };
  }

  private async failStep(runId: string, step: Step, code: string, message: string): Promise<Omit<RunResult, 'accepted'>> {
    await this.o.store.append(runId, 'step_failed', { step: step.id, code, message });
    const policy = step.type === 'decide' ? 'escalate' : (step.onError ?? 'fail');
    if (policy === 'escalate') return this.escalate(runId, step.id, code, message);
    if (policy === 'compensate') return this.compensate(runId, step, code, message);
    const rec0 = replayRun(await this.o.store.read(runId), this.wf, runId) as RunRec;
    for (const [id, s] of rec0.steps)
      if (['pending', 'ready', 'waiting'].includes(s.state) && this.wf.steps.find((x) => x.id === id)?.type !== 'compensate')
        await this.o.store.append(runId, 'step_cancelled', { step: id });
    await this.o.store.append(runId, 'run_finished', { state: 'failed', result: { error: code, message, step: step.id } });
    return { runId, state: 'failed' };
  }

  private async compensate(runId: string, failed: Step, code: string, message: string): Promise<Omit<RunResult, 'accepted'>> {
    const { store } = this.o;
    await store.append(runId, 'run_state', { state: 'compensating' });
    const rec = replayRun(await store.read(runId), this.wf, runId) as RunRec;
    const plan = compensationPlan(this.wf, rec.order);
    for (const cid of plan.compensate) {
      const c = this.wf.steps.find((s) => s.id === cid) as CompensateStep;
      const r = await this.callConnector(runId, c, rec, true);
      await store.append(runId, 'compensation_step', { step: cid, ok: r.ok, ...(r.ok ? {} : { message: r.message }) });
      if (!r.ok)
        return this.escalate(
          runId,
          cid,
          'COMPENSATION_FAILED',
          `compensation ${cid} failed after "${failed.id}" failed (${code}): ${r.message}`,
          { uncompensated: plan.uncompensatable },
        );
    }
    if (plan.uncompensatable.length > 0)
      return this.escalate(
        runId,
        failed.id,
        'UNCOMPENSATABLE',
        `step "${failed.id}" failed (${code}: ${message}) and these completed steps cannot be undone: ${plan.uncompensatable.join(', ')}`,
        { uncompensated: plan.uncompensatable },
      );
    await store.append(runId, 'run_finished', { state: 'compensated', result: { error: code, message, step: failed.id } });
    return { runId, state: 'compensated' };
  }

  private async runStep(runId: string, step: Step, rec: RunRec): Promise<Omit<RunResult, 'accepted'> | undefined> {
    const { store } = this.o;
    const sr = rec.steps.get(step.id) as StepRec;
    const { values } = this.resolveInputs(step, rec);

    if (hasSideEffects(step) && this.wf.authority !== undefined) {
      for (const c of this.wf.authority.ceilings) {
        const v = 'const' in c.value ? c.value.const : this.resolveRef(c.value.from, rec).value;
        if (typeof v !== 'number' || !Number.isFinite(v))
          return this.escalate(runId, step.id, 'CEILING_UNKNOWN', 'authority ceiling value is unavailable; refusing to act');
        if (v > c.max) return this.escalate(runId, step.id, 'CEILING_EXCEEDED', `value ${v} exceeds the authority ceiling ${c.max}`);
      }
    }

    if (hasSideEffects(step) && !rec.shadow && !rec.dryRun && this.o.caps !== undefined) {
      try {
        if (!(await this.o.caps.consume('effects')))
          return this.escalate(runId, step.id, 'DAILY_CAP', 'the daily limit on side-effecting calls is reached');
      } catch (e) {
        return this.escalate(runId, step.id, 'CAPS_UNAVAILABLE', (e as Error).message);
      }
    }
    const maxAttempts = step.retry?.maxAttempts ?? 1;
    let lastCode = 'FAILED';
    let lastMessage = 'step failed';
    for (let attempt = sr.attempt + 1; attempt <= Math.max(maxAttempts, sr.attempt + 1); attempt++) {
      await store.append(runId, 'step_started', { step: step.id, attempt });
      const r = await this.execute(runId, step, values, rec, sr);
      if (r.kind === 'ok') {
        await store.append(runId, 'step_succeeded', {
          step: step.id,
          outputs: r.outputs,
          modelCalls: r.modelCalls ?? 0,
          ...(r.rulesFired !== undefined ? { rulesFired: r.rulesFired } : {}),
        });
        return undefined;
      }
      if (r.kind === 'approval') {
        await store.append(runId, 'approval_requested', { step: step.id, request: r.request as unknown as Record<string, unknown> });
        await this.o.approvals?.sink?.(r.request);
        return undefined;
      }
      if (r.kind === 'wait') {
        await store.append(runId, 'wait_started', { step: step.id, until: r.until });
        return undefined;
      }
      if (r.kind === 'escalate') {
        await store.append(runId, 'step_failed', { step: step.id, code: r.code, message: r.message });
        return this.escalate(runId, step.id, r.code, r.message, r.extra);
      }
      lastCode = r.code;
      lastMessage = r.message;
      await store.append(runId, 'attempt_failed', { step: step.id, attempt, code: r.code, message: r.message });
      if (!TRANSIENT.has(r.code) || attempt >= maxAttempts) break;
      await this.sleep(backoffDelayMs(step, attempt, this.random));
    }
    return this.failStep(runId, step, lastCode, lastMessage);
  }

  private async execute(runId: string, step: Step, values: Record<string, unknown>, rec: RunRec, sr: StepRec): Promise<StepOutcome> {
    switch (step.type) {
      case 'decide': {
        const r = evaluateDecide(step, values, this.o.trees !== undefined ? { trees: this.o.trees } : {});
        return r.ok
          ? { kind: 'ok', outputs: { ...r.outputs }, rulesFired: [...r.rulesFired] }
          : { kind: 'escalate', code: `DECIDE_${r.code.toUpperCase()}`, message: r.detail };
      }
      case 'branch': {
        for (const c of step.cases) {
          try {
            if (Boolean(evaluateExpression(c.when, values as Scope))) return { kind: 'ok', outputs: { route: c.route } };
          } catch (e) {
            return { kind: 'fail', code: 'BRANCH_ERROR', message: (e as Error).message };
          }
        }
        return { kind: 'ok', outputs: { route: step.default } };
      }
      case 'extract':
        return this.extract(step, values);
      case 'wait':
        if (step.for.kind !== 'timer')
          return { kind: 'escalate', code: 'UNSUPPORTED_WAIT', message: `wait kind ${step.for.kind} is not supported by this runner` };
        return sr.waitUntil !== undefined ? { kind: 'ok', outputs: {} } : { kind: 'wait', until: this.now() + step.for.delayMs };
      case 'escalate': {
        const render = (t: string): string =>
          t.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, p: string) => {
            if (p === 'workflow.id') return this.wf.id;
            if (p === 'workflow.version') return this.wf.version;
            if (p === 'step.id') return step.id;
            const r = this.resolveRef(p, rec);
            return r.found && r.value !== null ? String(r.value) : '(unknown)';
          });
        return {
          kind: 'escalate',
          code: 'ESCALATE_STEP',
          message: render(step.reason),
          extra: { target: render(step.target), ...(step.lane !== undefined ? { lane: step.lane } : {}) },
        };
      }
      case 'approve':
        return { kind: 'approval', request: this.buildRequest(runId, step, values, rec) };
      case 'act':
      case 'compensate': {
        const r = await this.callConnector(runId, step, rec, false, sr);
        if (!r.ok) return { kind: 'fail', code: r.code, message: r.message };
        const data = r.data;
        const outs: Record<string, unknown> = {};
        const declared = Object.keys(step.outputs ?? {});
        if (declared.length > 0) {
          if (typeof data !== 'object' || data === null || Array.isArray(data))
            return { kind: 'fail', code: 'BAD_RESULT', message: 'connector result is not an object' };
          for (const k of declared) {
            if (!(k in data)) return { kind: 'fail', code: 'BAD_RESULT', message: `connector result lacks declared output "${k}"` };
            outs[k] = (data as Record<string, unknown>)[k];
          }
        }
        return { kind: 'ok', outputs: outs };
      }
    }
  }

  private async extract(step: Extract<Step, { type: 'extract' }>, values: Record<string, unknown>): Promise<StepOutcome> {
    const fields = step.outputs ?? {};
    const structured = values['structured'];
    if (step.structuredFirst === true && typeof structured === 'object' && structured !== null && !Array.isArray(structured)) {
      const s = structured as Record<string, unknown>;
      const problems = Object.entries(fields)
        .map(([k, spec]) => (k in s ? typeProblem(k, { ...spec, required: true }, s[k]) : `${k} missing`))
        .filter((p) => p !== undefined);
      if (problems.length === 0)
        return { kind: 'ok', outputs: Object.fromEntries(Object.keys(fields).map((k) => [k, s[k]])), modelCalls: 0 };
    }
    const text = values['text'];
    if (this.o.extractor === undefined || typeof text !== 'string')
      return {
        kind: 'escalate',
        code: 'EXTRACTION_UNAVAILABLE',
        message: 'structured input was incomplete and no text/extractor is available to read the facts',
      };
    const memo = this.o.memoDir !== undefined ? new ExtractionMemo(this.o.memoDir) : undefined;
    const memoKey = ExtractionMemo.key(step.instruction, fields, text);
    const hit = await memo?.get(memoKey);
    if (hit !== undefined && Object.entries(fields).every(([k, spec]) => k in hit && typeProblem(k, spec, hit[k]) === undefined))
      return { kind: 'ok', outputs: Object.fromEntries(Object.keys(fields).map((k) => [k, hit[k] ?? null])), modelCalls: 0 };
    if (this.o.caps !== undefined) {
      try {
        if (!(await this.o.caps.consume('modelCalls')))
          return { kind: 'escalate', code: 'DAILY_CAP', message: 'the daily limit on model calls is reached' };
      } catch (e) {
        return { kind: 'escalate', code: 'CAPS_UNAVAILABLE', message: (e as Error).message };
      }
    }
    try {
      const r = await withTimeout(
        this.o.extractor.extract({
          instruction: step.instruction,
          text,
          fields,
          grounding: step.grounding ?? 'none',
          maxModelCalls: step.maxModelCalls ?? 1,
        }),
        step.timeoutMs,
        `extraction exceeded the step timeout (${step.timeoutMs} ms)`,
      );
      if (r.modelCalls > (step.maxModelCalls ?? 1))
        return { kind: 'escalate', code: 'MODEL_CALL_BUDGET', message: 'extractor exceeded the step model-call budget' };
      const problems = Object.entries(fields)
        .map(([k, spec]) => (k in r.facts ? typeProblem(k, spec, r.facts[k]) : spec.nullable === true ? undefined : `${k} missing`))
        .filter((p) => p !== undefined);
      if (problems.length > 0) return { kind: 'escalate', code: 'EXTRACTION_INVALID', message: problems.join('; ') };
      const facts = Object.fromEntries(Object.keys(fields).map((k) => [k, r.facts[k] ?? null]));
      await memo?.set(memoKey, facts as Record<string, Scalar>);
      return { kind: 'ok', outputs: facts, modelCalls: r.modelCalls };
    } catch (e) {
      // an answer that cannot be verified is a case for a person, not a retry and not a guess
      if (isExtractionRefusal(e)) return { kind: 'escalate', code: e.code, message: e.message };
      return { kind: 'fail', code: 'FAILED', message: (e as Error).message };
    }
  }

  /**
   * Journal discipline for an external call: `call_intent` is durable BEFORE the call, `call_outcome` AFTER and BEFORE the next step.
   * After a crash: outcome present => reuse it, never call again; intent without outcome => call again with the SAME key (the
   * external system dedupes if it supports idempotency; if it does not, a duplicate is possible and is documented, not hidden).
   */
  private async callConnector(
    runId: string,
    step: ActStep | CompensateStep,
    rec: RunRec,
    _isCompensation: boolean,
    sr?: StepRec,
  ): Promise<{ ok: true; data: Json } | { ok: false; code: string; message: string }> {
    const { store } = this.o;
    if (sr?.callOutcome !== undefined)
      return sr.callOutcome.ok
        ? { ok: true, data: sr.callOutcome.data ?? null }
        : { ok: false, code: sr.callOutcome.code ?? 'FAILED', message: 'recorded failure' };
    const { values } = this.resolveInputs(step, rec);
    let key: string | undefined;
    if (step.idempotencyKey !== undefined) {
      const rendered = renderIdempotencyKey(step.idempotencyKey, this.wf, step.id, (r) => {
        if (r === 'run.id') return runId;
        const f = this.resolveRef(r, rec);
        return f.found ? (f.value as Scalar) : undefined;
      });
      if (rendered === undefined)
        return { ok: false, code: 'KEY_UNRESOLVED', message: 'idempotency key could not be rendered; refusing to call' };
      key = externalIdempotencyKey(this.wf, step.id, rendered);
    }
    if (rec.shadow) {
      const declared = Object.fromEntries(Object.keys(step.outputs ?? {}).map((k) => [k, null]));
      await store.append(runId, 'shadow_action', {
        step: step.id,
        connector: step.connector,
        operation: step.operation,
        sideEffect: step.sideEffect,
        args: values as Record<string, unknown>,
      });
      await store.append(runId, 'call_outcome', { step: step.id, ok: true, data: declared, dryRun: true });
      return { ok: true, data: declared };
    }
    if (!this.breakers.allow(step.connector))
      return { ok: false, code: 'CIRCUIT_OPEN', message: `circuit open for connector "${step.connector}"` };
    const requestHash = sha256Hex(canonicalJson({ c: step.connector, o: step.operation, a: values }));
    const startedAt = this.now();
    await store.append(runId, 'call_intent', {
      step: step.id,
      connector: step.connector,
      operation: step.operation,
      requestHash,
      ...(key !== undefined ? { key } : {}),
    });
    let sem = this.sems.get(step.connector);
    if (sem === undefined) this.sems.set(step.connector, (sem = new Semaphore(this.o.connectorConcurrency ?? 4)));
    const release = await sem.acquire();
    let callResult: { data: Json; dryRun: boolean } | undefined;
    try {
      const res = await this.o.connectors.call({
        connector: step.connector,
        operation: step.operation,
        args: values as Record<string, Json>,
        runId,
        stepId: step.id,
        timeoutMs: step.timeoutMs,
        ...(key !== undefined ? { idempotencyKey: key } : {}),
        ...(rec.dryRun ? { dryRun: true } : {}),
      });
      this.breakers.success(step.connector);
      callResult = res;
    } catch (e) {
      const ce = e instanceof ConnectorError ? e : new ConnectorError('FAILED', (e as Error).message);
      if (TRANSIENT.has(ce.code)) this.breakers.failure(step.connector);
      // Permanent refusals are final and recorded; transient failures are not recorded as outcomes so a retry may call again with the same key.
      if (!TRANSIENT.has(ce.code)) await store.append(runId, 'call_outcome', { step: step.id, ok: false, code: ce.code });
      return { ok: false, code: ce.code, message: ce.message };
    } finally {
      release();
    }
    // Journal failures must propagate (they are a crash, not a step failure), so this sits outside the try above.
    await store.append(runId, 'call_outcome', {
      step: step.id,
      ok: true,
      data: callResult.data,
      dryRun: callResult.dryRun,
      requestHash,
      responseHash: sha256Hex(canonicalJson(callResult.data)),
      durationMs: this.now() - startedAt,
    });
    return { ok: true, data: callResult.data };
  }
}

type StepOutcome =
  | { kind: 'ok'; outputs: Record<string, unknown>; modelCalls?: number; rulesFired?: string[] }
  | { kind: 'wait'; until: number }
  | { kind: 'approval'; request: ApprovalRequest }
  | { kind: 'fail'; code: string; message: string }
  | { kind: 'escalate'; code: string; message: string; extra?: Partial<Escalation> };

export { replayRun as _replayRun };

function closureHas(wf: WorkflowDef, stepId: string, target: string, seen = new Set<string>()): boolean {
  const s = wf.steps.find((x) => x.id === stepId);
  if (s === undefined || seen.has(stepId)) return false;
  seen.add(stepId);
  return (s.needs ?? []).some((n) => n === target || closureHas(wf, n, target, seen));
}
