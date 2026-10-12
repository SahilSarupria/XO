import { describe, expect, it } from 'vitest';
import {
  describeRecoveryProblem,
  normalizeNote,
  NOTE_MAX_CHARS,
  recordedNotes,
  describeResumeProblem,
  recoverableRuns,
  describeRun,
  describeStartProblem,
  findActiveRun,
  pendingTasks,
  standaloneExecutions,
  startReadiness,
  stepsNamedInDenials,
  tidyName,
  workflowTitle,
} from '../../src/domain/work';
import type { ApiProblem } from '../../src/platform/client';
import {
  parseExecution,
  parseWorkflowRun,
  tryParseErrorBody,
  WireParseError,
  type Capability,
  type Execution,
  type Workflow,
  type WorkflowRun,
} from '../../src/platform/wire';

const wf: Workflow = {
  workflowId: 'wf_1',
  compilationId: 'cmp_1',
  name: 'a → b',
  description: '',
  status: 'executable_candidate',
  executable: true,
  notExecutableReasons: [],
  gapCount: 0,
  stepCount: 2,
  steps: [
    { order: 0, capabilityId: 'cap_a', name: 'record the payment.', description: 'Record it.' },
    { order: 1, capabilityId: 'cap_b', name: 'Check the balance', description: '' },
  ],
  requiresHumanDecision: false,
  confidence: 0.5,
};
const cap = (id: string, approved: boolean, extra: Partial<Capability> = {}): Capability => ({
  capabilityId: id,
  contractId: id,
  name: id,
  description: '',
  status: 'resolved',
  confidence: 0.5,
  provenance: [],
  approved,
  ...extra,
});
function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    workflowExecutionId: 'wfx_1',
    compilationId: 'cmp_1',
    workflowId: 'wf_1',
    workflowName: 'x',
    revision: 3,
    status: 'waiting_for_human',
    steps: [
      { stepId: 'a#0', order: 0, capabilityId: 'cap_a', capabilityName: 'Record', status: 'waiting_for_human', executionId: 'e0' },
      { stepId: 'b#1', order: 1, capabilityId: 'cap_b', capabilityName: 'Check', status: 'pending' },
    ],
    currentStepIndex: 0,
    currentStepExecutionId: 'e0',
    pendingHumanTask: { stepIndex: 0, executionId: 'e0' },
    createdAt: '2026-10-11T10:00:00Z',
    updatedAt: '2026-10-11T10:00:00Z',
    raw: {},
    ...over,
  };
}

describe('display names (display only)', () => {
  it('tidies whitespace, trailing punctuation and case without inventing words', () => {
    expect(tidyName('  record   the payment. ')).toBe('Record the payment');
    expect(tidyName('')).toBe('Untitled step');
    expect(tidyName('x'.repeat(200)).length).toBeLessThanOrEqual(90);
  });
  it('titles a workflow by what it covers', () => {
    expect(workflowTitle(wf)).toBe('Record the payment, then 1 more step');
    expect(workflowTitle({ ...wf, steps: [wf.steps[0]!] })).toBe('Record the payment');
  });
});

describe('finding an active run', () => {
  it('matches workflow + analysis and ignores finished runs', () => {
    expect(findActiveRun([run()], 'wf_1', 'cmp_1')?.workflowExecutionId).toBe('wfx_1');
    expect(findActiveRun([run({ status: 'succeeded' })], 'wf_1', 'cmp_1')).toBeUndefined();
    expect(findActiveRun([run()], 'wf_1', 'cmp_other')).toBeUndefined();
    expect(findActiveRun([run()], 'wf_other', 'cmp_1')).toBeUndefined();
  });
});

describe('start readiness (advisory; the server decides)', () => {
  it('needs every step approved', () => {
    const r = startReadiness(wf, [cap('cap_a', true), cap('cap_b', false)]);
    expect(r.canStart).toBe(false);
    expect(r.needApproval).toEqual(['Check the balance']);
  });
  it('is startable when all steps are approved', () => {
    expect(startReadiness(wf, [cap('cap_a', true), cap('cap_b', true)]).canStart).toBe(true);
  });
  it('does not start a process the platform says cannot run', () => {
    expect(startReadiness({ ...wf, executable: false }, [cap('cap_a', true), cap('cap_b', true)]).canStart).toBe(false);
  });
  it('does not guess while approvals are unknown', () => {
    expect(startReadiness(wf, undefined).canStart).toBe(false);
  });
});

describe('start refusals in words', () => {
  const denial = (id: string) => `capability "${id}" is not approved for execution in workspace "ws_1"`;
  it('names the steps from the platform denial sentences', () => {
    expect(stepsNamedInDenials([denial('cap_b'), denial('cap_a'), denial('cap_zzz')], wf)).toEqual([
      'Check the balance',
      'Record the payment',
    ]);
  });
  it('explains the known not-approved 403', () => {
    const p: ApiProblem = {
      kind: 'forbidden',
      status: 403,
      code: 'XO_RUNTIME_PERMISSION_DENIED',
      message: 'm',
      denials: [denial('cap_b')],
    };
    const v = describeStartProblem(p, wf)!;
    expect(v.kind).toBe('needs_approval');
    expect(v.items).toEqual(['Check the balance']);
  });
  it('does not call every 403 an approval problem', () => {
    const p: ApiProblem = { kind: 'forbidden', status: 403, message: 'not allowed' };
    expect(describeStartProblem(p, wf)!.kind).toBe('forbidden');
  });
  it('leaves other problems to the generic handler', () => {
    expect(describeStartProblem({ kind: 'server', status: 500, message: 'x' }, wf)).toBeUndefined();
  });
});

describe('resume problems', () => {
  it('treats 409 as a recoverable change and says nothing was applied', () => {
    const v = describeResumeProblem({ kind: 'rejected', status: 409, reason: 'stale_revision', message: 'm' })!;
    expect(v.kind).toBe('conflict');
    expect(v.body).toMatch(/not applied/i);
  });
  it('distinguishes a finished process', () => {
    expect(describeResumeProblem({ kind: 'rejected', status: 409, reason: 'terminal', message: 'm' })!.body).toMatch(/already finished/i);
  });
  it('treats 400 as a bad request, distinct from a conflict', () => {
    expect(describeResumeProblem({ kind: 'rejected', status: 400, message: 'bad' })!.kind).toBe('bad_request');
  });
  it('leaves 403, 5xx and network to the generic handler', () => {
    expect(describeResumeProblem({ kind: 'forbidden', status: 403, message: 'm' })).toBeUndefined();
    expect(describeResumeProblem({ kind: 'network', message: 'm' })).toBeUndefined();
  });
});

describe('run states', () => {
  it('describes a waiting run with its position', () => {
    const v = describeRun(run());
    expect(v.label).toBe('Waiting for a decision');
    expect(v.summary).toMatch(/Step 1 of 2: Record/);
  });
  it('never reports a rejected or failed run as completed', () => {
    expect(describeRun(run({ status: 'rejected', currentStepIndex: null })).label).toBe('Stopped by a person');
    expect(describeRun(run({ status: 'failed', currentStepIndex: null, errorMessage: 'boom' })).tone).toBe('danger');
    expect(describeRun(run({ status: 'interrupted' })).label).toBe('Interrupted');
  });
  it('lists only runs with a pending decision AND the identifiers a resume needs', () => {
    const noId = run({ workflowExecutionId: 'wfx_2' });
    const { currentStepExecutionId: _drop, ...rest } = noId;
    expect(
      pendingTasks([run(), rest as WorkflowRun, run({ workflowExecutionId: 'wfx_3', status: 'succeeded' })]).map(
        (r) => r.workflowExecutionId,
      ),
    ).toEqual(['wfx_1']);
  });
});

describe('not showing one decision twice', () => {
  it('sets aside executions that belong to a workflow run', () => {
    const e = (id: string): Execution => ({
      executionId: id,
      compilationId: 'c',
      capabilityId: 'k',
      status: 'waiting_for_human',
      requestedAt: 't',
      input: {},
    });
    expect(standaloneExecutions([e('e0'), e('e9')], [run()]).map((x) => x.executionId)).toEqual(['e9']);
  });
});

describe('wire: workflow runs and error context', () => {
  it('rejects an unknown run status instead of rendering it', () => {
    expect(() => parseWorkflowRun({ status: 'teleported' })).toThrow(WireParseError);
  });
  it('reads reason and denials from the error context, leniently', () => {
    expect(tryParseErrorBody({ error: { code: 'C', message: 'M', context: { reason: 'stale_revision' } } })).toEqual({
      code: 'C',
      message: 'M',
      reason: 'stale_revision',
    });
    expect(tryParseErrorBody({ error: { code: 'C', message: 'M', context: { denials: ['a'] } } })?.denials).toEqual(['a']);
    expect(tryParseErrorBody({ error: { code: 'C', message: 'M', context: 'weird' } })).toEqual({ code: 'C', message: 'M' });
  });
});

describe('recovery', () => {
  it('lists only interrupted runs as recoverable (failed and completed are not)', () => {
    const rs = [
      run({ workflowExecutionId: 'a', status: 'interrupted' }),
      run({ workflowExecutionId: 'b', status: 'failed' }),
      run({ workflowExecutionId: 'c', status: 'succeeded' }),
      run({ workflowExecutionId: 'd' }),
    ];
    expect(recoverableRuns(rs).map((r) => r.workflowExecutionId)).toEqual(['a']);
  });
  it('explains a 409 as "not continued again", never as a decision problem', () => {
    const v = describeRecoveryProblem({ kind: 'rejected', status: 409, reason: 'stale_revision', message: 'm' })!;
    expect(v.kind).toBe('conflict');
    expect(v.body).toMatch(/not continued again/i);
    expect(v.body).not.toMatch(/decision/i);
  });
  it('leaves 403, 5xx and network to the generic handler', () => {
    expect(describeRecoveryProblem({ kind: 'forbidden', status: 403, message: 'm' })).toBeUndefined();
    expect(describeRecoveryProblem({ kind: 'network', message: 'm' })).toBeUndefined();
  });
  it('describes an interrupted run honestly and points to Tasks', () => {
    const v = describeRun(run({ status: 'interrupted', currentStepIndex: 1 }));
    expect(v.label).toBe('Interrupted');
    expect(v.summary).toMatch(/step 2 of 2/i);
    expect(v.summary).toMatch(/continue it from Tasks/i);
  });
});

describe('decision notes', () => {
  it('trims, treats blank as no note, and rejects (never truncates) an over-long one', () => {
    expect(normalizeNote('  hi  ')).toEqual({ note: 'hi' });
    expect(normalizeNote('   ')).toEqual({});
    expect(normalizeNote('x'.repeat(NOTE_MAX_CHARS)).note).toHaveLength(NOTE_MAX_CHARS);
    expect(normalizeNote('x'.repeat(NOTE_MAX_CHARS + 1)).error).toMatch(/500/);
    expect(normalizeNote('x'.repeat(NOTE_MAX_CHARS + 1).concat('')).note).toBeUndefined();
  });
  it('reads a recorded note, resolver and time from the platform record only', () => {
    const e = parseExecution({
      executionId: 'e1',
      compilationId: 'c',
      capabilityId: 'k',
      status: 'succeeded',
      requestedAt: 't',
      input: {},
      humanTask: {
        status: 'resolved',
        decision: 'approve',
        decisionData: { note: 'ok', other: 1 },
        resolverIdentityId: 'sally',
        resolvedAt: '2026-10-11T10:00:00Z',
      },
    });
    expect(recordedNotes([e]).get('e1')).toEqual({ note: 'ok', by: 'sally', at: '2026-10-11T10:00:00Z' });
  });
  it('ignores non-string notes and pending tasks', () => {
    const base = { executionId: 'e2', compilationId: 'c', capabilityId: 'k', status: 'waiting_for_human', requestedAt: 't', input: {} };
    expect(recordedNotes([parseExecution({ ...base, humanTask: { status: 'pending' } })]).size).toBe(0);
    expect(
      recordedNotes([parseExecution({ ...base, status: 'succeeded', humanTask: { status: 'resolved', decisionData: { note: 5 } } })]).size,
    ).toBe(0);
  });
});
