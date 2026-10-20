import { describe, expect, it } from 'vitest';
import { replayFrame } from '../../src/domain/replay';
import type { WorkflowRunStep } from '../../src/platform/wire';

const step = (order: number, status: WorkflowRunStep['status'], extra: Partial<WorkflowRunStep> = {}): WorkflowRunStep => ({
  stepId: `s${order}`,
  order,
  capabilityId: `c${order}`,
  capabilityName: `Rule ${order}`,
  status,
  ...extra,
});
const run = { steps: [step(2, 'waiting_for_human'), step(1, 'succeeded')] };

describe('replayFrame', () => {
  it('reveals steps in their recorded order and dims the rest', () => {
    const f = replayFrame(run, 1);
    expect(f.nodes.map((n) => [n.name, n.state])).toEqual([
      ['Rule 1', 'done'],
      ['Rule 2', 'upcoming'],
    ]);
    expect(f.caption).toBe('Step 1 of 2: Rule 1 finished.');
  });

  it('at the end shows each recorded outcome and marks the last revealed step current', () => {
    const f = replayFrame(run, 2);
    expect(f.nodes[1]).toMatchObject({ state: 'waiting', current: true });
    expect(f.caption).toMatch(/waiting for a person/);
  });

  it('clamps the position and starts with no claim about any step', () => {
    expect(replayFrame(run, -5).caption).toMatch(/Move the slider/);
    expect(replayFrame(run, 99).nodes.every((n) => n.state !== 'upcoming')).toBe(true);
  });

  it('carries a failure message through, and never invents timings', () => {
    const f = replayFrame({ steps: [step(1, 'failed', { errorMessage: 'No match' })] }, 1);
    expect(f.nodes[0]).toMatchObject({ state: 'failed', errorMessage: 'No match' });
    expect(JSON.stringify(f)).not.toMatch(/ms|seconds/i);
  });
});
