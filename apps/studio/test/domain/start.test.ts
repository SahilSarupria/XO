import { describe, expect, it } from 'vitest';
import { startActions, unavailableActions, type StartFacts } from '../../src/domain/start';

const none: StartFacts = {
  blockedWorkflows: 0,
  activeRuns: 0,
  sources: 0,
  succeededCompilations: 0,
  readyForReview: 0,
  readyWorkflows: 0,
  waitingDecisions: 0,
  incomplete: false,
};
const ids = (f: Partial<StartFacts>) => startActions({ ...none, ...f }).map((a) => a.id);

describe('startActions', () => {
  it('an empty workspace is offered exactly one real action: add a document', () => {
    expect(ids({})).toEqual(['add-document']);
    expect(startActions(none)[0]?.title).toBe('Add your first document');
  });

  it('a document without an analysis is offered Analyse first', () => {
    expect(ids({ sources: 1 })).toEqual(['analyse', 'add-document']);
  });

  it('puts a waiting decision ahead of everything else, then runnable processes, then rules to review', () => {
    expect(ids({ sources: 1, succeededCompilations: 1, readyForReview: 2, readyWorkflows: 1, waitingDecisions: 1 })).toEqual([
      'decide',
      'start-process',
      'review-rules',
      'add-document',
    ]);
  });

  it('only offers what the facts support', () => {
    expect(ids({ sources: 1, succeededCompilations: 1 })).toEqual(['add-document']);
    expect(ids({ sources: 1, succeededCompilations: 1, readyWorkflows: 0 })).not.toContain('start-process');
  });

  it('counts and wording follow the real numbers', () => {
    const a = startActions({ ...none, sources: 1, succeededCompilations: 1, waitingDecisions: 3, readyForReview: 1 });
    expect(a[0]?.title).toBe('Review 3 waiting decisions');
    expect(a[1]?.detail).toMatch(/^1 rule is waiting/);
  });

  it('does not recommend from partial facts when something failed to load', () => {
    expect(ids({ sources: 1, succeededCompilations: 1, waitingDecisions: 1, readyWorkflows: 1, incomplete: true })).toEqual([
      'add-document',
    ]);
  });
});

describe('unavailableActions', () => {
  const why = (f: Partial<StartFacts>) => Object.fromEntries(unavailableActions({ ...none, ...f }).map((a) => [a.id, a.reason]));

  it('explains each missing option from the same facts that hide it', () => {
    const r = why({});
    expect(r['decide']).toBe('Nothing is waiting for a decision.');
    expect(r['start-process']).toMatch(/needs an analysed document/);
    expect(r['review-rules']).toBe('Nothing has been analysed yet.');
    expect(r['analyse']).toBe('Add a document first.');
  });

  it('says why a process cannot start: rules not approved, or one already running', () => {
    expect(why({ sources: 1, succeededCompilations: 1, blockedWorkflows: 2 })['start-process']).toBe(
      '2 processes need their rules approved first.',
    );
    expect(why({ sources: 1, succeededCompilations: 1, activeRuns: 1 })['start-process']).toBe('A process is already running.');
  });

  it('never lists an action as unavailable when it is offered', () => {
    const f = { ...none, sources: 1, succeededCompilations: 1, readyWorkflows: 1, waitingDecisions: 1, readyForReview: 1 };
    const offered = startActions(f).map((a) => a.id);
    expect(unavailableActions(f).filter((u) => offered.includes(u.id))).toEqual([]);
  });

  it('gives no reasons from incomplete facts: that would be a guess', () => {
    expect(unavailableActions({ ...none, incomplete: true })).toEqual([]);
  });
});
