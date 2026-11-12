import { describe, expect, it } from 'vitest';
import {
  countFilters,
  describeEvery,
  matchesQuery,
  modeLabel,
  needItems,
  summarizeWorkflow,
  weekOfRuns,
} from '../../src/domain/workflowSummary';
import type { Capability, Workflow, WorkflowControl, WorkflowRun } from '../../src/platform/wire';

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
    expect(countFilters([a, b, c])).toEqual({ all: 3, needs: 2, inprogress: 1, ready: 1, blocked: 0, live: 0, shadow: 0, paused: 0 });
  });

  it('searches the title and the description, ignoring case and spaces at the ends', () => {
    expect(matchesQuery(a, '  RECORD ')).toBe(true);
    expect(matchesQuery(a, 'paid')).toBe(true);
    expect(matchesQuery(a, 'zebra')).toBe(false);
    expect(matchesQuery(a, '')).toBe(true);
  });
});

const control = (over: Partial<WorkflowControl> = {}): WorkflowControl => ({
  workflowId: 'wf1',
  compilationId: 'c1',
  mode: 'draft',
  triggers: { webhook: false },
  limits: { runsToday: 0 },
  readiness: [],
  canGoLive: false,
  shadow: { runs: 0, wouldComplete: 0, wouldEscalate: 0, reviewed: 0, agreed: 0 },
  shadowCases: [],
  revision: 1,
  ...over,
});
const approvedCaps = [cap('a', true), cap('b', true)];

describe('summarizeWorkflow with controls', () => {
  it('shows the mode for live, shadow and paused, and keeps the readiness words for a draft', () => {
    const at = (mode: WorkflowControl['mode']) => summarizeWorkflow(wf(), approvedCaps, false, [], NOW, control({ mode })).status;
    expect(at('live')).toEqual({ label: 'Live', tone: 'success', mode: 'live' });
    expect(at('shadow')).toMatchObject({ label: 'Shadow', mode: 'shadow' });
    expect(at('paused')).toMatchObject({ label: 'Paused', tone: 'warning' });
    expect(at('draft')).toEqual({ label: 'Ready to start', tone: 'success' });
    expect(summarizeWorkflow(wf(), approvedCaps, false, [], NOW).status.label).toBe('Ready to start'); // no controls reported: as before
  });

  it('lists how it can start, and marks a trigger as waiting unless the workflow is practising or live and nothing is paused', () => {
    const c = control({ mode: 'draft', triggers: { webhook: true, schedule: { everyMinutes: 90, lastFiredAt: 'x' } } });
    const draft = summarizeWorkflow(wf(), approvedCaps, false, [], NOW, c);
    expect(draft.triggers.map((t) => [t.kind, t.label, t.active])).toEqual([
      ['manual', 'Someone starts it', true],
      ['webhook', 'Webhook', false],
      ['schedule', 'Every 90 minutes', false],
    ]);
    const live = summarizeWorkflow(wf(), approvedCaps, false, [], NOW, { ...c, mode: 'live' });
    expect(live.triggers.filter((t) => t.kind !== 'manual').every((t) => t.active)).toBe(true);
    const paused = summarizeWorkflow(wf(), approvedCaps, false, [], NOW, { ...c, mode: 'live' }, true);
    expect(paused.triggers.filter((t) => t.kind !== 'manual').some((t) => t.active)).toBe(false);
  });

  it('asks for a judgement on practice cases nobody has judged, and reports a reached daily limit', () => {
    const cases = [
      { workflowExecutionId: 'r1', createdAt: 'x', outcome: 'would_complete' as const },
      { workflowExecutionId: 'r2', createdAt: 'x', outcome: 'would_escalate' as const, judgement: 'person' as const },
    ];
    const s = summarizeWorkflow(wf(), approvedCaps, false, [], NOW, control({ mode: 'shadow', shadowCases: cases }));
    expect(s.need).toMatchObject({ kind: 'practice', text: '1 case to review' });
    expect(needItems([s])[0]).toMatchObject({
      kind: 'practice',
      sentence: '1 practice case is waiting for your judgement',
      action: 'Review cases',
    });
    expect(s.filters.has('shadow')).toBe(true);
    const capped = summarizeWorkflow(
      wf(),
      approvedCaps,
      false,
      [],
      NOW,
      control({ mode: 'live', limits: { dailyRunCap: 3, runsToday: 3 } }),
    );
    expect(capped.need).toMatchObject({ kind: 'limit', text: 'Daily limit reached' });
    expect(needItems([capped])).toEqual([]); // nothing for a person to do about it, so not on the needs-you card
  });
});

describe('wording', () => {
  it('describes intervals in the largest whole unit', () => {
    expect([5, 60, 90, 120, 1440, 2880].map(describeEvery)).toEqual([
      'Every 5 minutes',
      'Every hour',
      'Every 90 minutes',
      'Every 2 hours',
      'Every day',
      'Every 2 days',
    ]);
    expect(['draft', 'shadow', 'live', 'paused'].map((m) => modeLabel(m as 'draft'))).toEqual(['Draft', 'Shadow', 'Live', 'Paused']);
  });
});
