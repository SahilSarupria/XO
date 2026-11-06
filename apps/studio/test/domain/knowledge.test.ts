import { describe, expect, it } from 'vitest';
import { evidencePanel, independentSources, shortHash, statusView, uncertaintyLine } from '../../src/domain/knowledge';
import type { Statement } from '../../src/platform/wire-knowledge';

const ev = (id: string, source: string) => ({
  evidenceId: id,
  sourceId: source,
  contentHash: 'sha256:0123456789abcdef0123456789abcdef',
  observedAt: '2026-11-03T09:00:00.000Z',
});
const st = (over: Partial<Statement> = {}): Statement => ({
  ref: 'r',
  kind: 'claim',
  text: 't',
  status: 'known',
  origin: 'observed',
  evidence: [ev('1', 'A')],
  reviewRequired: false,
  ...over,
});

describe('statement status wording', () => {
  it('maps C6 status and origin to plain labels, never inventing certainty', () => {
    expect(statusView(st()).label).toBe('Observed');
    expect(statusView(st({ origin: 'stated' })).label).toBe('Stated');
    expect(statusView(st({ origin: 'inferred' })).label).toBe('Inferred, corroborated');
    expect(statusView(st({ status: 'hypothesis', origin: 'inferred', reviewRequired: true })).label).toBe('Unverified guess');
    expect(statusView(st({ kind: 'conflict', status: 'conflicted' })).label).toBe('Conflict');
    expect(statusView(st({ status: 'unknown' })).label).toBe('Unknown');
  });
  it('a review-required statement is never shown as settled', () => {
    expect(statusView(st({ reviewRequired: true })).label).toBe('Unverified guess');
  });
});

describe('evidence panel', () => {
  it('counts independent sources, not evidence rows', () => {
    expect(independentSources([ev('1', 'A'), ev('2', 'A'), ev('3', 'B')])).toBe(2);
    expect(evidencePanel(st({ evidence: [ev('1', 'A'), ev('2', 'A'), ev('3', 'B')] })).backing).toBe('Backed by 2 independent sources.');
  });
  it('says what removal does without claiming immediate disappearance, and that confidence is not a probability', () => {
    const p = evidencePanel(st());
    expect(p.ifRemoved).toMatch(/only if every source behind it is removed/);
    expect(p.ifRemoved).not.toMatch(/immediately|right away/i);
    expect(p.howSure).toMatch(/not a probability/);
    expect(p.visibility).toMatch(/not proof nothing is known/);
  });
  it('an unsupported statement says so instead of implying backing', () => {
    expect(evidencePanel(st({ evidence: [] })).backing).toBe('No evidence is attached to this statement.');
  });
  it('shortens hashes without losing the ends', () => {
    expect(shortHash('sha256:0123456789abcdef0123456789abcdef')).toMatch(/^sha256:0123456….{4}$/);
    expect(shortHash('short')).toBe('short');
  });
});

describe('uncertainty line', () => {
  it('lists only what is flagged', () => {
    expect(uncertaintyLine({ conflicted: 0, hypotheses: 0, reviewRequired: 0, singleSource: 0 })).toBe('Nothing here is flagged.');
    expect(uncertaintyLine({ conflicted: 1, hypotheses: 2, reviewRequired: 3, singleSource: 4 })).toBe(
      '1 conflict · 2 unverified guesses · 3 need review · 4 rest on a single source',
    );
  });
});
