import type { Determinism, StepState, WorkflowDef } from '@xo/workflow-ir';
import type { RunStoreLike } from './journal.js';
import { replayRun } from './runner.js';

export interface ExplainStep {
  readonly step: string;
  readonly type: string;
  readonly determinism: Determinism;
  readonly state: StepState;
  readonly attempts: number;
  readonly outputs?: Readonly<Record<string, unknown>>;
  readonly modelCalls: number;
  readonly rulesFired: readonly string[];
  /** Source sentences / node ids the compiler recorded for this step. */
  readonly provenance: readonly string[];
  readonly call?: {
    readonly connector: string;
    readonly operation: string;
    readonly requestHash?: string;
    readonly responseHash?: string;
    readonly durationMs?: number;
    readonly idempotencyKey?: string;
    readonly dryRun?: boolean;
  };
  readonly shadowAction?: { readonly connector: string; readonly operation: string };
}

export interface RunExplanation {
  readonly runId: string;
  readonly workflow: string;
  readonly version: string;
  readonly state: string;
  readonly shadow: boolean;
  readonly dryRun: boolean;
  readonly inputs: Readonly<Record<string, unknown>>;
  /** Steps in the order they started. Skipped steps are included with state `skipped`. */
  readonly steps: readonly ExplainStep[];
  /** Total model calls made by this run. Zero for a fully deterministic path. */
  readonly modelCalls: number;
  readonly approvals: readonly {
    readonly step: string;
    readonly reviewerId: string;
    readonly role: string;
    readonly action: string;
    readonly approvalId: string;
  }[];
  readonly escalation?: unknown;
  readonly result?: unknown;
  /** The journal's hash chain was verified while reading it (a broken chain throws instead). */
  readonly journalEntries: number;
}

/** Reconstructs why a run did what it did, purely from its verified journal and the workflow document. */
export async function explainRun(store: RunStoreLike, wf: WorkflowDef, runId: string): Promise<RunExplanation> {
  const entries = await store.read(runId);
  const rec = replayRun(entries, wf, runId);
  if (rec === undefined) throw new Error(`unknown run ${runId}`);
  const order: string[] = [];
  const attempts = new Map<string, number>();
  const calls = new Map<string, NonNullable<ExplainStep['call']>>();
  const shadow = new Map<string, { connector: string; operation: string }>();
  const approvals: RunExplanation['approvals'][number][] = [];
  for (const e of entries) {
    const d = e.data as Record<string, string | number | boolean | undefined>;
    const step = d['step'] as string | undefined;
    if (e.type === 'step_started' && step !== undefined) {
      if (!order.includes(step)) order.push(step);
      attempts.set(step, Math.max(attempts.get(step) ?? 0, Number(d['attempt'])));
    }
    if (
      (e.type === 'step_skipped' || e.type === 'approval_requested' || e.type === 'wait_started') &&
      step !== undefined &&
      !order.includes(step)
    )
      order.push(step);
    if (e.type === 'call_intent' && step !== undefined)
      calls.set(step, {
        connector: String(d['connector']),
        operation: String(d['operation']),
        ...(d['requestHash'] !== undefined ? { requestHash: String(d['requestHash']) } : {}),
        ...(d['key'] !== undefined ? { idempotencyKey: String(d['key']) } : {}),
      });
    if (e.type === 'call_outcome' && step !== undefined) {
      const c = calls.get(step);
      if (c !== undefined)
        calls.set(step, {
          ...c,
          ...(d['responseHash'] !== undefined ? { responseHash: String(d['responseHash']) } : {}),
          ...(d['durationMs'] !== undefined ? { durationMs: Number(d['durationMs']) } : {}),
          ...(d['dryRun'] === true ? { dryRun: true } : {}),
        });
    }
    if (e.type === 'shadow_action' && step !== undefined)
      shadow.set(step, { connector: String(d['connector']), operation: String(d['operation']) });
    if (e.type === 'approval_decided')
      approvals.push({
        step: String(d['step']),
        reviewerId: String(d['reviewerId']),
        role: String(d['role']),
        action: String(d['action']),
        approvalId: String(d['approvalId']),
      });
  }
  const steps: ExplainStep[] = order.map((id) => {
    const def = wf.steps.find((s) => s.id === id);
    const s = rec.steps.get(id);
    const call = calls.get(id);
    const sh = shadow.get(id);
    return {
      step: id,
      type: def?.type ?? 'unknown',
      determinism: def?.determinism ?? 'deterministic',
      state: s?.state ?? 'pending',
      attempts: attempts.get(id) ?? 0,
      ...(s?.outputs !== undefined ? { outputs: s.outputs } : {}),
      modelCalls: s?.modelCalls ?? 0,
      rulesFired: s?.rulesFired ?? [],
      provenance: def?.provenance ?? [],
      ...(call !== undefined ? { call } : {}),
      ...(sh !== undefined ? { shadowAction: sh } : {}),
    };
  });
  return {
    runId,
    workflow: wf.id,
    version: wf.version,
    state: rec.state,
    shadow: rec.shadow,
    dryRun: rec.dryRun,
    inputs: rec.inputs,
    steps,
    modelCalls: steps.reduce((n, s) => n + s.modelCalls, 0),
    approvals,
    ...(rec.escalation !== undefined ? { escalation: rec.escalation } : {}),
    ...(rec.result !== undefined ? { result: rec.result } : {}),
    journalEntries: entries.length,
  };
}

export function renderExplanation(x: RunExplanation): string {
  const L: string[] = [
    `run ${x.runId}  ${x.workflow}@${x.version}  state=${x.state}${x.shadow ? '  (shadow: nothing was executed)' : ''}${x.dryRun ? '  (dry run)' : ''}`,
  ];
  L.push(`model calls: ${x.modelCalls}${x.modelCalls === 0 ? '  (deterministic path)' : ''}`);
  L.push(`inputs: ${JSON.stringify(x.inputs)}`);
  for (const s of x.steps) {
    L.push(`- ${s.step} [${s.type}, ${s.determinism}] ${s.state}${s.attempts > 1 ? ` after ${s.attempts} attempts` : ''}`);
    if (s.outputs !== undefined && Object.keys(s.outputs).length > 0) L.push(`    outputs: ${JSON.stringify(s.outputs)}`);
    if (s.rulesFired.length > 0) L.push(`    rules fired: ${s.rulesFired.join(', ')}`);
    if (s.modelCalls > 0) L.push(`    model calls: ${s.modelCalls}`);
    if (s.call !== undefined)
      L.push(
        `    call ${s.call.connector}.${s.call.operation} req=${s.call.requestHash?.slice(0, 12) ?? '-'} resp=${s.call.responseHash?.slice(0, 12) ?? '-'} ${s.call.durationMs ?? '?'}ms key=${s.call.idempotencyKey?.slice(0, 12) ?? '-'}${s.call.dryRun === true ? ' (dry run)' : ''}`,
      );
    if (s.shadowAction !== undefined) L.push(`    would have called ${s.shadowAction.connector}.${s.shadowAction.operation}`);
    if (s.provenance.length > 0) L.push(`    from: ${s.provenance.join('; ')}`);
  }
  for (const a of x.approvals) L.push(`approval at ${a.step}: ${a.action} by ${a.reviewerId} (${a.role}), signature recorded`);
  if (x.escalation !== undefined) L.push(`escalation: ${JSON.stringify(x.escalation)}`);
  if (x.result !== undefined) L.push(`result: ${JSON.stringify(x.result)}`);
  L.push(`journal: ${x.journalEntries} entries, hash chain verified`);
  return L.join('\n');
}
