import type { EvidenceStrength } from '@xo/xoir';

/**
 * How well-supported a claim about the environment is. These are the four
 * epistemic classes the Environment Intelligence principles require, with
 * a *defined interpretation* instead of an arbitrary score:
 *
 * - `directly_observed`      — an authorized source itself states/exhibits it
 *                              (e.g. two files' content digests are equal; an API
 *                              reports an integration).
 * - `corroborated_inference` — we inferred it, and >= 2 independent kinds of
 *                              evidence support it (see {@link CORROBORATION_RULE}).
 * - `candidate_hypothesis`   — we inferred it from a single kind of evidence; it
 *                              is a lead to verify, not a finding.
 * - `unknown`                — the available evidence cannot establish it. Recorded as an
 *                              explicit `Unknown`, never silently omitted or guessed.
 */
export type EpistemicStatus = 'directly_observed' | 'corroborated_inference' | 'candidate_hypothesis' | 'unknown';

/**
 * Validation is a platform concern. This package can only ever emit
 * `not_validated`: the type has no other member on purpose, so no code path
 * here can promote an inference to "validated organizational knowledge".
 * Promotion requires an authoritative platform process (human review +
 * the compiler/XOIR pipeline) that does not exist in this package.
 */
export type ValidationState = 'not_validated';

export const CORROBORATION_RULE =
  'A relationship is corroborated only when at least two different kinds of evidence (for example a file name AND file content) each independently tie both endpoints to it. One kind of evidence, however often repeated, yields a candidate hypothesis.';

/**
 * Maps an epistemic status onto XOIR's existing coarse {@link EvidenceStrength}
 * vocabulary (reused so the two models speak one language). The mapping is
 * the whole interpretation: there is no numeric confidence anywhere in this
 * package, and no claim that any of this is a calibrated probability.
 */
export function strengthOf(status: EpistemicStatus): EvidenceStrength {
  switch (status) {
    case 'directly_observed':
      return 'strong';
    case 'corroborated_inference':
      return 'moderate';
    case 'candidate_hypothesis':
      return 'weak';
    case 'unknown':
      return 'unknown';
  }
}
