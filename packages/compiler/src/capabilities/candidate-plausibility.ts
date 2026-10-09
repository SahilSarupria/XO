/**
 * Phase 0 requirement #5 ("Prevent bad source text from becoming
 * capability candidates"): a general, structural plausibility filter
 * `rule-based-extractor.ts` runs every candidate name/identifier through
 * before it is ever pushed into `CapabilityExtractionResult.capabilities`
 * — a rejected candidate simply never exists downstream, which is what
 * keeps this a rejection ("don't invent executable semantics from
 * untrustworthy text"), not a redaction of source content. No specific
 * string is ever special-cased here; every rule is justified on its own
 * structural shape and is exercised by this package's own regression
 * fixtures (`../../test/capabilities/candidate-plausibility.test.ts`),
 * not tuned to any one document.
 */

import { findSuspiciousTokens } from '../document/text-legibility.js';

/**
 * A `command-snippet-detector.ts` match (`identifier(args)`) is only
 * good evidence of *real* command/API usage — the narrow thing that
 * detector is meant to surface — when the identifier itself has the
 * shape of a programming identifier: lowerCamelCase (`sendEmail`),
 * dotted (`xo.compile`), or snake_case (`process_order`). Every genuine
 * positive fixture in this package's own tests
 * (`../../test/capabilities/command-snippet-detector.test.ts`) is
 * written in exactly one of those forms.
 *
 * A bare word that starts with an uppercase letter and contains neither
 * a `.` nor a `_` is, by contrast, indistinguishable in shape from an
 * ordinary capitalized English noun/label sitting next to an unrelated
 * parenthetical remark — `Building(s)` (the standard English
 * optional-plural convention), `Sion(E)` (a place name followed by a
 * one-letter disambiguator, from a real address), `Region(E)`,
 * `Renewal(s)` (a form's column-header labels followed by a value
 * hint). None of these are command/API usage, and none of them should
 * be deleted as source text (they're legitimate) — they should simply
 * never have been treated as capability evidence in the first place.
 * This is the general rule that keeps that from happening, independent
 * of which specific capitalized word appears.
 */
export function isPlausibleCommandIdentifier(identifier: string): boolean {
  if (identifier.length === 0) return false;
  if (identifier.includes('.') || identifier.includes('_')) return true;
  return /^[a-z]/.test(identifier);
}

/**
 * Backstop applied to every candidate's `name` (verb-based, title-based,
 * and snippet-based alike): if any whitespace-delimited word inside the
 * name matches one of `text-legibility.ts`'s general corruption shapes
 * (a digit/letter mash, a fused-Title-Case-word pair, a pathologically
 * long single "word"), the *whole* candidate is implausible — reflecting
 * requirement #5's "reject/filter the affected candidate" (not a partial
 * edit of its name, which would risk fabricating a plausible-looking
 * name out of an untrustworthy one).
 */
export function isPlausibleCandidateName(name: string): boolean {
  return findSuspiciousTokens(name).length === 0;
}
