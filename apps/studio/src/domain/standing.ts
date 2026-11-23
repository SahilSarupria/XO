import type { StandingLimitsView, StandingPeriod, StandingView } from '../platform/wire-control';

/**
 * UW-16c (ADR 0051): standing approvals in plain words. The platform sends codes; these are the words a person reads. An unknown
 * code is shown as "another reason (<code>)", never hidden.
 */

const PERIOD_WORD: Record<StandingPeriod, string> = { day: 'day', week: 'week', month: 'month' };

export const periodWord = (p: StandingPeriod): string => PERIOD_WORD[p];

/** Why a run under a standing approval went outside what was approved. */
export function reasonWords(code: string, period: StandingPeriod = 'day'): string {
  switch (code) {
    case 'too_many_items':
      return 'more items than allowed in one run';
    case 'period_items':
      return `it would pass the limit for this ${period}`;
    case 'period_runs':
      return `it would run more often than allowed this ${period}`;
    case 'value_not_approved':
      return 'a value is not one that was approved (for example a new recipient)';
    case 'excluded_rows':
      return 'more rows were left out than allowed';
    case 'exceptions':
      return 'some items stop for a person';
    case 'not_exact':
      return 'some items cannot be shown exactly';
    case 'effect_not_allowed':
      return 'it would do something the approval does not cover';
    case 'binding_changed':
      return 'the sending account or connection changed';
    case 'input_changed':
      return 'its settings changed';
    case 'revoked':
      return 'the standing approval was revoked';
    case 'expired':
      return 'the standing approval expired';
    case 'not_yet_valid':
      return 'the standing approval is not valid yet';
    case 'not_approved':
      return 'the standing approval is not approved yet';
    default:
      return `another reason (${code})`;
  }
}

export const reasonsSentence = (codes: readonly string[], period: StandingPeriod = 'day'): string =>
  codes.map((c) => reasonWords(c, period)).join('; ');

/** The refusals the platform gives when someone approves, in words a person can act on. */
export function standingRefusalWords(reason: string | undefined): string | undefined {
  switch (reason) {
    case 'separation_of_duties':
      return 'Someone other than the person who asked, or the person it runs as, must approve this.';
    case 'standing_requires_person':
      return 'A standing approval is approved by a person who signed in, not by a key or a service.';
    case 'policy_mismatch':
      return 'This is not the version you were shown. Review the current one and approve that.';
    case 'sample_expired':
      return 'The sample this was asked with has expired (24 hours). Ask again.';
    case 'not_proposed':
      return 'This is no longer waiting for a decision.';
    default:
      return undefined;
  }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The bounds, one line each, as the approver reads them before approving. */
export function boundsLines(s: StandingView): string[] {
  const l: StandingLimitsView = s.limits;
  const per = periodWord(l.period);
  return [
    `At most ${plural(l.maxItemsPerRun, 'item', 'items')} in one run.`,
    `At most ${plural(l.maxItemsPerPeriod, 'item', 'items')} and ${plural(l.maxRunsPerPeriod, 'run', 'runs')} in a ${per}.`,
    l.maxExcludedRows > 0
      ? `Up to ${plural(l.maxExcludedRows, 'row', 'rows')} may be left out.`
      : 'No rows may be left out; if any are, the run waits for a person.',
    `May start: ${s.triggers.map((t) => (t === 'manual' ? 'by hand' : 'on a schedule')).join(' and ')}, as ${s.startsAs.id}.`,
    ...s.pinned.map((p) =>
      s.mayVary.some((m) => m.step === p.step && m.argument === p.argument)
        ? `"${p.argument}" may change.`
        : `"${p.argument}" must be one of the ${plural(p.count, 'value', 'values')} in the sample.`,
    ),
    s.effects.length > 0 ? `Does only: ${s.effects.map((e) => `${e.connector} ${e.operation.replace(/_/g, ' ')}`).join(', ')}.` : '',
  ].filter((x) => x !== '');
}

export const statusWords = (s: StandingView['status']): string =>
  s === 'proposed'
    ? 'Waiting for someone else to approve'
    : s === 'changes_requested'
      ? 'Sent back for changes'
      : s === 'active'
        ? 'Active'
        : s === 'expired'
          ? 'Expired'
          : 'Revoked';
