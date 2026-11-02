import { describe, expect, it } from 'vitest';
import { countFilters, matchesQuery, needItems, summarizeWorkflow, weekOfRuns } from '../../src/domain/workflowSummary';
import type { Capability, Workflow, WorkflowRun } from '../../src/platform/wire';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000 - 1000).toISOString();

const wf = (over: Partial<Workflow> = {}): Workflow => ({
  workflowId: 'wf1',
  compilationId: 'c1',
  name: 'Record before payment',
  description: 'Records the claim before it is paid.',
  status: 'ready',
  executable: true,
  notExecutableReasons: [],
  gapCount: 0,
  stepCount: 2,
  steps: [
    { order: 0, capabilityId: 'a', name: 'Record before payment', description: '' },
    { order: 1, capabilityId: 'b', name: 'Review not covered', description: '' },
  ],
  requiresHumanDecision: true,
  confidence: 0.5,
  ...over,
});
const cap = (id: string, approved: boolean, executionClass = 'automatic'): Capability =>
  ({
    capabilityId: id,
    contractId: id,
    name: id,
    description: '',
    status: 'bound',
    executionClass,
    confidence: 0.5,
    provenance: [],
    approved,
  }) as unknown as Capability;
const run = (over: Partial<WorkflowRun> = {}): WorkflowRun =>
  ({
    workflowExecutionId: 'r1',
    compilationId: 'c1',
    workflowId: 'wf1',
    workflowName: 'x',
    revision: 1,
    status: 'succeeded',
    steps: [],
    currentStepIndex: null,
    createdAt: iso(0),
    updatedAt: iso(0),
    ...over,
  }) as unknown as WorkflowRun;

describe('summarizeWorkflow', () => {
  it('says "Ready to start" and "All clear" only when every step is approved and nothing is running', () => {
    const s = summarizeWorkflow(wf(), [cap('a', true), cap('b', true, 'human_in_the_loop')], false, [], NOW);
    expect(s.status).toEqual({ label: 'Ready to start', tone: 'success' });
    expect(s.need.kind).toBe('clear');
    expect(s.split).toEqual({ xo: 1, person: 1 });
    expect(s.sub).toBe('2 steps · 1 needs a person');
    expect([...s.filters].sort()).toEqual(['all', 'ready']);
  });

  it('never says ready while a rule is unapproved, and counts the rules', () => {
    const s = summarizeWorkflow(wf(), [cap('a', false), cap('b', false)], false, [], NOW);
    expect(s.status.label).toBe('Needs approval');
    expect(s.need).toMatchObject({ kind: 'rules', text: '2 rules to approve' });
    expect(s.filters.has('ready')).toBe(false);
    expect(s.filters.has('needs')).toBe(true);
  });

  it('a person-must-decide run outranks everything else', () => {
    const s = summarizeWorkflow(
      wf(),
      [cap('a', false), cap('b', true)],
      false,
      [run({ status: 'waiting_for_human', currentStepIndex: 1 })],
      NOW,
    );
    expect(s.need.kind).toBe('decision');
    expect(s.filters.has('inprogress')).toBe(true);
    expect(s.filters.has('ready')).toBe(false);
  });

  it('flags a failed last run only when nothing is active, and not an old success', () => {
    const failed = summarizeWorkflow(wf(), [cap('a', true), cap('b', true)], false, [run({ status: 'failed' })], NOW);
    expect(failed.need.kind).toBe('failed');
    const fine = summarizeWorkflow(
      wf(),
      [cap('a', true), cap('b', true)],
      false,
      [run({ status: 'failed', createdAt: iso(3) }), run({ workflowExecutionId: 'r2' })],
      NOW,
    );
    expect(fine.need.kind).toBe('clear');
  });

  it('shows nothing it does not know: no split without approvals, a plain "Unavailable" when they could not be read', () => {
    const s = summarizeWorkflow(wf(), undefined, true, [], NOW);
    expect(s.split).toBeUndefined();
    expect(s.status.label).toBe('Unavailable');
    expect(s.need.kind).toBe('checking');
    expect(summarizeWorkflow(wf(), undefined, false, [], NOW).status.label).toBe('Checking…');
  });

  it('a workflow the platform cannot run is "Cannot run yet" and filterable as such', () => {
    const s = summarizeWorkflow(wf({ executable: false }), [cap('a', true), cap('b', true)], false, [], NOW);
    expect(s.status.label).toBe('Cannot run yet');
    expect(s.need.kind).toBe('blocked');
    expect(s.filters.has('blocked')).toBe(true);
  });
});

describe('weekOfRuns', () => {
  it('counts only this workflow and only the last 7 days, oldest day first, ignoring bad and future dates', () => {
    const w = weekOfRuns(
      [
        run({ createdAt: iso(0) }),
        run({ createdAt: iso(0) }),
        run({ createdAt: iso(6) }),
        run({ createdAt: iso(7.5) }),
        run({ workflowId: 'other' }),
        run({ createdAt: 'nonsense' }),
        run({ createdAt: new Date(NOW + 5000).toISOString() }),
      ],
      'wf1',
      NOW,
    );
    expect(w.total).toBe(3);
    expect(w.perDay).toEqual([1, 0, 0, 0, 0, 0, 2]);
  });
});

describe('needItems, counts and search', () => {
  const caps = [cap('a', false), cap('b', true)];
  const a = summarizeWorkflow(wf({ workflowId: 'w1' }), caps, false, [], NOW);
  const b = summarizeWorkflow(
    wf({ workflowId: 'w2', name: 'Refunds' }),
    [cap('a', true), cap('b', true)],
    false,
    [run({ workflowId: 'w2', status: 'waiting_for_human' })],
    NOW,
  );
  const c = summarizeWorkflow(wf({ workflowId: 'w3' }), [cap('a', true), cap('b', true)], false, [], NOW);

  it('lists what is waiting on a person, most urgent first, with plain sentences', () => {
    const items = needItems([a, b, c]);
    expect(items.map((i) => [i.workflowId, i.kind])).toEqual([
      ['w2', 'decision'],
      ['w1', 'rules'],
    ]);
    expect(items[1]!.sentence).toBe('1 rule needs your approval before this can start');
  });

  it('counts each filter', () => {
    expect(countFilters([a, b, c])).toEqual({ all: 3, needs: 2, inprogress: 1, ready: 1, blocked: 0 });
  });

  it('searches the title and the description, ignoring case and spaces at the ends', () => {
    expect(matchesQuery(a, '  RECORD ')).toBe(true);
    expect(matchesQuery(a, 'paid')).toBe(true);
    expect(matchesQuery(a, 'zebra')).toBe(false);
    expect(matchesQuery(a, '')).toBe(true);
  });
});
