import { describe, expect, it } from 'vitest';
import { homeMetrics, scriptedReply } from '../../src/domain/home';
import type { WorkflowRun } from '../../src/platform/wire';

const run = (status: string, extra: Partial<WorkflowRun> = {}): WorkflowRun => ({ status, ...extra }) as unknown as WorkflowRun;

describe('homeMetrics', () => {
  it('has no success rate until a run has finished (no invented number)', () => {
    const m = homeMetrics([run('running')]);
    expect(m).toMatchObject({ total: 1, inProgress: 1, finished: 0, successPercent: undefined });
  });

  it('computes the success rate from finished runs only', () => {
    const m = homeMetrics([run('succeeded'), run('succeeded'), run('failed'), run('running')]);
    expect(m).toMatchObject({ total: 4, finished: 3, succeeded: 2, successPercent: 67, inProgress: 1 });
  });

  it('an empty list is all zeros', () => {
    expect(homeMetrics([])).toMatchObject({ total: 0, finished: 0, waiting: 0, successPercent: undefined });
  });
});

describe('scriptedReply', () => {
  it('points at a real place, never claims to have done anything', () => {
    expect(scriptedReply('analyse my policy').action?.target).toBe('documents');
    expect(scriptedReply('what is waiting for me').action?.target).toBe('tasks');
    expect(scriptedReply('start a process').action?.target).toBe('workflows');
    expect(scriptedReply('review the rules').action?.target).toBe('rules');
  });

  it('says it is a preview when it cannot help', () => {
    const r = scriptedReply('hello');
    expect(r.action).toBeUndefined();
    expect(r.text).toMatch(/preview/i);
  });
});
