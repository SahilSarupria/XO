import { describe, expect, it } from 'vitest';
import { durationMs, formatMs, runRow, runsOf, shortRunId, stepRecord } from '../../src/domain/executions';
import type { Execution, WorkflowRun } from '../../src/platform/wire';
import { exec } from '../fixtures';

const run = (over: Partial<WorkflowRun> = {}): WorkflowRun =>
  ({
    workflowExecutionId: 'wfx_0000abcdef',
    workflowId: 'wf_1',
    compilationId: 'cmp_1',
    workflowName: 'x',
    status: 'succeeded',
    revision: 1,
    currentStepIndex: null,
    createdAt: '2026-10-19T10:00:00.000Z',
    updatedAt: '2026-10-19T10:00:02.000Z',
    steps: [
      { stepId: 'a#0', order: 0, capabilityId: 'a', capabilityName: 'Validate claim', status: 'succeeded', executionId: 'exe_1' },
      { stepId: 'b#1', order: 1, capabilityId: 'b', capabilityName: 'Decide', status: 'pending' },
    ],
    ...over,
  }) as WorkflowRun;

describe('run rows', () => {
  it('lists only this process, newest first', () => {
    const rows = runsOf(
      [run({ workflowExecutionId: 'wfx_old', createdAt: '2026-10-01T00:00:00Z' }), run({ workflowExecutionId: 'wfx_new', createdAt: '2026-10-02T00:00:00Z' }), run({ workflowId: 'other' })],
      'wf_1',
    );
    expect(rows.map((r) => r.workflowExecutionId)).toEqual(['wfx_new', 'wfx_old']);
  });

  it('shows a duration only when both timestamps were recorded', () => {
    expect(runRow(run({ completedAt: '2026-10-19T10:00:01.900Z' })).duration).toBe('1.9 s');
    expect(runRow(run()).duration).toBeUndefined();
    expect(durationMs('2026-10-19T10:00:05Z', '2026-10-19T10:00:00Z')).toBeUndefined(); // end before start: not believable, not shown
    expect(durationMs('not a date', '2026-10-19T10:00:00Z')).toBeUndefined();
  });

  it('says where a failed run stopped, from the step that failed', () => {
    const failed = run({
      status: 'failed',
      steps: [{ stepId: 'a#0', order: 0, capabilityId: 'a', capabilityName: 'Validate claim', status: 'failed' }],
    });
    expect(runRow(failed)).toMatchObject({ status: 'Did not complete at Validate claim', tone: 'danger' });
  });

  it('uses a short stable id and readable durations', () => {
    expect(shortRunId('wfx_0000abcdef')).toBe('abcdef');
    expect(shortRunId('wfx_12')).toBe('12');
    expect(formatMs(412)).toBe('412 ms');
    expect(formatMs(90_000)).toBe('2 min');
  });
});

describe('stepRecord', () => {
  const executions: Execution[] = [
    exec({
      executionId: 'exe_1',
      requestedAt: '2026-10-19T10:00:00.000Z',
      completedAt: '2026-10-19T10:00:00.700Z',
      input: { claim: 1 },
      output: { ok: true },
      humanTask: { status: 'resolved', decision: 'approve', decisionNote: 'looks fine', resolvedAt: '2026-10-19T10:00:00.600Z' },
    }),
  ];

  it('joins a step to the execution it produced, with its recorded duration and events', () => {
    const rec = stepRecord(run(), 'a#0', executions)!;
    expect(rec.execution?.output).toEqual({ ok: true });
    expect(rec.durationMs).toBe(700);
    expect(rec.events.map((e) => e.label)).toEqual(['Requested', 'A person approved this step', 'Note: looks fine', 'Ended as succeeded']);
  });

  it('a step with no execution has no output, input, duration or events: nothing is filled in', () => {
    const rec = stepRecord(run(), 'b#1', executions)!;
    expect(rec).toMatchObject({ execution: undefined, durationMs: undefined, events: [] });
    expect(stepRecord(run(), 'missing', executions)).toBeUndefined();
  });
});
