import { describe, expect, it } from 'vitest';
import {
  PLATFORM_CODE,
  buildInputFromContract,
  canApprove,
  canRun,
  coerceFieldValue,
  describeExecution,
  describeProblem,
  latestExecutionByCapability,
  nextStep,
  reviewStateOf,
  suggestedFieldsFromFailure,
  summarize,
} from '../../src/domain/review';
import { cap, exec } from '../fixtures';

describe('reviewStateOf', () => {
  it('maps only real platform facts to states', () => {
    expect(reviewStateOf(cap({ status: 'resolved', approved: false }))).toBe('ready_for_review');
    expect(reviewStateOf(cap({ status: 'resolved', approved: true }))).toBe('approved');
    for (const status of ['unresolved', 'ambiguous', 'denied'] as const) {
      expect(reviewStateOf(cap({ status }))).toBe('needs_attention');
    }
  });

  it('never shows an unresolved capability as approved even if a server-side approval record exists', () => {
    const c = cap({ status: 'unresolved', approved: true });
    expect(reviewStateOf(c)).toBe('needs_attention');
    expect(canApprove(c)).toBe(false);
    expect(canRun(c)).toBe(false);
  });

  it('offers approve only when ready, and run only when approved', () => {
    expect(canApprove(cap())).toBe(true);
    expect(canRun(cap())).toBe(false);
    expect(canApprove(cap({ approved: true }))).toBe(false);
    expect(canRun(cap({ approved: true }))).toBe(true);
  });
});

describe('summarize', () => {
  it('counts each state', () => {
    const s = summarize([cap(), cap({ approved: true }), cap({ status: 'unresolved' }), cap({ status: 'ambiguous' })]);
    expect(s).toEqual({ total: 4, needsAttention: 2, readyForReview: 1, approved: 1 });
  });
});

describe('executions', () => {
  it('a failed run is described as not completed, with the platform message', () => {
    const v = describeExecution(exec({ status: 'failed', errorMessage: 'input validation failed: claim: missing required property' }));
    expect(v.tone).toBe('danger');
    expect(v.label).toBe('Did not complete');
    expect(v.detail).toContain('missing required property');
  });
  it('a paused human task is a warning, a resolved one is neutral, success is success', () => {
    expect(describeExecution(exec({ status: 'waiting_for_human', humanTask: { status: 'pending' } })).tone).toBe('warning');
    expect(describeExecution(exec({ status: 'waiting_for_human', humanTask: { status: 'resolved', decision: 'approve' } })).tone).toBe(
      'neutral',
    );
    expect(describeExecution(exec({ status: 'succeeded' })).tone).toBe('success');
  });
  it('picks the latest execution per capability within one compilation only', () => {
    const m = latestExecutionByCapability(
      [
        exec({ executionId: 'old', requestedAt: '2026-10-10T09:00:00Z' }),
        exec({ executionId: 'new', requestedAt: '2026-10-10T11:00:00Z' }),
        exec({ executionId: 'other', compilationId: 'cmp_2', requestedAt: '2026-10-10T12:00:00Z' }),
      ],
      'cmp_1',
    );
    expect(m.get('cap_a')?.executionId).toBe('new');
  });
});

describe('suggestedFieldsFromFailure', () => {
  it('extracts required field names from the platform validation message', () => {
    const e = exec({
      status: 'failed',
      errorCode: 'XO_RUNTIME_CAPABILITY_INPUT_INVALID',
      errorMessage: 'input validation failed: claim: missing required property; lossadjuster_assessment: missing required property',
    });
    expect(suggestedFieldsFromFailure(e)).toEqual(['claim', 'lossadjuster_assessment']);
  });
  it('gives no suggestions for other failures or unfamiliar messages', () => {
    expect(
      suggestedFieldsFromFailure(
        exec({ status: 'failed', errorCode: 'XO_BINDING_UNRESOLVED', errorMessage: 'x: missing required property' }),
      ),
    ).toEqual([]);
    expect(
      suggestedFieldsFromFailure(
        exec({
          status: 'failed',
          errorCode: 'XO_RUNTIME_CAPABILITY_INPUT_INVALID',
          errorMessage: 'input validation failed: something else entirely',
        }),
      ),
    ).toEqual([]);
  });
});

describe('coerceFieldValue', () => {
  it('parses JSON when it is JSON and keeps text otherwise', () => {
    expect(coerceFieldValue('{"a":1}')).toEqual({ a: 1 });
    expect(coerceFieldValue('42')).toBe(42);
    expect(coerceFieldValue('true')).toBe(true);
    expect(coerceFieldValue('hello world')).toBe('hello world');
    expect(coerceFieldValue('')).toBe('');
  });
});

describe('describeProblem', () => {
  it('every problem kind yields a title and a next step', () => {
    for (const kind of [
      'unauthenticated',
      'forbidden',
      'not_found',
      'rejected',
      'unavailable',
      'server',
      'network',
      'malformed',
    ] as const) {
      const v = describeProblem({ kind, message: 'm' });
      expect(v.title.length).toBeGreaterThan(0);
      expect(v.next.length).toBeGreaterThan(0);
    }
  });
  it('unavailable explicitly says nothing was attempted', () => {
    expect(describeProblem({ kind: 'unavailable', message: '' }).body).toMatch(/nothing was attempted/i);
  });
});

describe('nextStep', () => {
  it('walks the journey from real facts', () => {
    expect(nextStep({ sources: 0, succeededCompilations: 0, summary: undefined, executions: 0 }).step).toBe('context');
    expect(nextStep({ sources: 1, succeededCompilations: 0, summary: undefined, executions: 0 }).step).toBe('analyze');
    expect(
      nextStep({
        sources: 1,
        succeededCompilations: 1,
        summary: { total: 3, needsAttention: 1, readyForReview: 2, approved: 0 },
        executions: 0,
      }).step,
    ).toBe('review');
    expect(
      nextStep({
        sources: 1,
        succeededCompilations: 1,
        summary: { total: 3, needsAttention: 1, readyForReview: 1, approved: 1 },
        executions: 0,
      }).step,
    ).toBe('run');
    expect(
      nextStep({
        sources: 1,
        succeededCompilations: 1,
        summary: { total: 3, needsAttention: 1, readyForReview: 1, approved: 1 },
        executions: 2,
      }).step,
    ).toBe('done');
  });
});

describe('WP2-D error semantics', () => {
  it('binding codes get specific wording regardless of HTTP class, and say nothing was recorded or run', () => {
    for (const code of [PLATFORM_CODE.BINDING_UNRESOLVED, PLATFORM_CODE.BINDING_AMBIGUOUS, PLATFORM_CODE.BINDING_DENIED]) {
      for (const status of [403, 422]) {
        const v = describeProblem({
          kind: status === 403 ? 'forbidden' : 'rejected',
          status,
          code,
          message: 'internal resolver detail should not appear',
        });
        expect(v.title).toMatch(/cannot carry this rule out yet/i);
        expect(v.body).toMatch(/nothing was recorded or run/i);
        expect(v.body).not.toMatch(/internal resolver detail/);
      }
    }
  });
  it('403 does not claim to know whether the cause is approval or permission', () => {
    const v = describeProblem({ kind: 'forbidden', status: 403, code: 'XO_RUNTIME_PERMISSION_DENIED', message: 'x' });
    expect(v.body).toMatch(/either the rule is not approved or your account/i);
    expect(v.body).toMatch(/nothing was run/i);
  });
  it('404 does not claim the resource does not exist (the platform hides inaccessible resources)', () => {
    const v = describeProblem({ kind: 'not_found', status: 404, message: 'x' });
    expect(v.body).toMatch(/does not exist, or you do not have access/i);
    expect(v.body).toMatch(/does not say which/i);
  });
  it('credentials and raw platform messages never appear in the wording for non-"rejected" kinds', () => {
    for (const kind of ['unauthenticated', 'forbidden', 'not_found', 'unavailable', 'server', 'network', 'malformed'] as const) {
      const v = describeProblem({ kind, message: 'Bearer xoak_SECRET stack trace at /srv/xo/internal.ts' });
      expect(JSON.stringify(v)).not.toMatch(/xoak_|stack trace|internal\.ts/);
    }
  });
  it('failed executions carry guidance only for codes the platform defines', () => {
    expect(describeExecution(exec({ status: 'failed', errorCode: PLATFORM_CODE.BINDING_UNRESOLVED, errorMessage: 'm' })).hint).toMatch(
      /nothing ran/i,
    );
    expect(describeExecution(exec({ status: 'failed', errorCode: PLATFORM_CODE.INPUT_INVALID, errorMessage: 'm' })).hint).toMatch(
      /nothing ran/i,
    );
    expect(describeExecution(exec({ status: 'failed', errorCode: 'XO_SOMETHING_ELSE', errorMessage: 'm' })).hint).toBeUndefined();
    expect(describeExecution(exec({ status: 'succeeded' })).hint).toBeUndefined();
  });
});

describe('buildInputFromContract', () => {
  const contract = {
    required: ['claim_amount', 'loss'],
    properties: { claim_amount: { type: 'number' }, loss: { type: 'string' }, reported: { type: 'boolean' } },
  } as const;

  it('converts to the declared types and omits empty optional fields', () => {
    expect(buildInputFromContract(contract, { claim_amount: ' 1200.5 ', loss: 'fire' })).toEqual({
      ok: true,
      input: { claim_amount: 1200.5, loss: 'fire' },
    });
    expect(buildInputFromContract(contract, { claim_amount: '1', loss: 'x', reported: 'true' })).toEqual({
      ok: true,
      input: { claim_amount: 1, loss: 'x', reported: true },
    });
  });

  it('reports every problem and never builds partial input', () => {
    const r = buildInputFromContract(contract, { claim_amount: 'abc', reported: 'maybe' });
    expect(r).toEqual({ ok: false, errors: { claim_amount: 'Enter a number.', loss: 'Required.', reported: 'Choose true or false.' } });
  });

  it('keeps text as text even when it looks numeric, and only ever sends declared properties', () => {
    const r = buildInputFromContract(contract, { claim_amount: '1', loss: '42', not_declared: 'x' });
    expect(r).toEqual({ ok: true, input: { claim_amount: 1, loss: '42' } });
  });

  it('a rule with an empty contract builds empty input', () => {
    expect(buildInputFromContract({ required: [], properties: {} }, {})).toEqual({ ok: true, input: {} });
  });
});
