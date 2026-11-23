import { EXIT } from '../visual.config.mjs';

/**
 * The single place that decides what a run MEANS, so a red check is never ambiguous.
 *
 *   infra       the suite could not do its job (a service did not start, seeding failed, the browser crashed,
 *               a screen never appeared in a page that never loaded). Says nothing about the UI. Exit 20.
 *   regression  the suite ran and the UI is not what was approved: pixels changed, a screen's size changed,
 *               a screen has no approved reference, or the UI loaded but did not behave as expected. Exit 10.
 *   pass        every screen matched its approved reference. Exit 0.
 *
 * `results` are per-step records ({ status: 'match' | 'pass' | 'todo' | 'diff' | 'size-mismatch' | 'missing-baseline' |
 * 'functional' }). `pass` is a step with no screenshot that did what it should; `todo` is a step Studio cannot do yet (named
 * with the PR that enables it): neither is a failure.
 * An infrastructure problem always wins: if the suite could not finish, nothing else it found can be trusted.
 */
export function classify({ infraError, results }) {
  if (infraError !== undefined) {
    return { kind: 'infra', exitCode: EXIT.infra, headline: `Infrastructure failure: ${infraError}` };
  }
  const judged = results.filter((r) => r.status !== 'todo');
  if (judged.length === 0) {
    return { kind: 'infra', exitCode: EXIT.infra, headline: 'Infrastructure failure: the suite captured no screens.' };
  }
  const todo = results.length - judged.length;
  const bad = judged.filter((r) => r.status !== 'match' && r.status !== 'pass');
  if (bad.length === 0) {
    return {
      kind: 'pass',
      exitCode: EXIT.pass,
      headline: `Journeys passed: ${judged.length} of ${judged.length} steps behave as approved${todo > 0 ? `; ${todo} ${todo === 1 ? 'step is' : 'steps are'} not possible yet (each names the PR that enables it)` : ''}.`,
    };
  }
  return { kind: 'regression', exitCode: EXIT.regression, headline: regressionHeadline(judged, bad) };
}

/** Says what is actually wrong: "no reference yet" is not the same as "the pixels changed". */
function regressionHeadline(results, bad) {
  const total = results.length;
  const count = (status) => bad.filter((r) => r.status === status).length;
  const missing = count('missing-baseline');
  if (missing === total) {
    return `Visual regression: none of the ${total} screens has an approved reference yet (nothing has changed; the references still need to be committed).`;
  }
  const parts = [
    [count('diff') + count('size-mismatch'), 'differ from the approved references'],
    [missing, 'have no approved reference'],
    [count('functional'), 'did not behave as expected'],
  ]
    .filter(([n]) => n > 0)
    .map(([n, what]) => `${n} ${what}`);
  return `Visual regression: ${bad.length} of ${total} screens need attention: ${parts.join(', ')}.`;
}
