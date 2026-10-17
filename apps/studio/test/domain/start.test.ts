import { describe, expect, it } from 'vitest';
import { startActions, type StartFacts } from '../../src/domain/start';

const none: StartFacts = {
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
