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
 * `results` are per-screen records ({ status: 'match' | 'diff' | 'size-mismatch' | 'missing-baseline' | 'functional' }).
 * An infrastructure problem always wins: if the suite could not finish, nothing else it found can be trusted.
 */
export function classify({ infraError, results }) {
  if (infraError !== undefined) {
    return { kind: 'infra', exitCode: EXIT.infra, headline: `Infrastructure failure: ${infraError}` };
  }
  if (results.length === 0) {
    return { kind: 'infra', exitCode: EXIT.infra, headline: 'Infrastructure failure: the suite captured no screens.' };
  }
  const bad = results.filter((r) => r.status !== 'match');
  if (bad.length === 0) {
    return { kind: 'pass', exitCode: EXIT.pass, headline: `Visual check passed: ${results.length} of ${results.length} screens match.` };
  }
  return {
    kind: 'regression',
    exitCode: EXIT.regression,
    headline: `Visual regression: ${bad.length} of ${results.length} screens differ from the approved references.`,
  };
}
