/**
 * UW-3b — confidence from the quality of the text a capability was read from.
 *
 * A capability's confidence used to be a constant per syntactic position (0.6 for a sentence-initial verb, 0.45
 * otherwise), so a name stitched from two table columns scored the same as a clean instruction. The positional prior is
 * kept, and multiplied down by what can be observed about the text itself:
 *
 *   cross-column    the unit's text was joined across layout columns (`ExperienceUnit.layoutSuspect`)
 *   label-glued     a capitalised action verb right after the verb ("Review Re-read your diff"): a step label and its
 *                   action glued together by a flattened table
 *   leaked-marker   a row number or marker in front of the verb ("6 Review ..."): structure leaked into the text
 *   fragment        the source sentence is not a complete sentence (no terminal punctuation, an unclosed bracket)
 *   unbounded       the object ran into the word limit without reaching the end of its clause
 *
 * `cross-column` and `label-glued` mark a POSSIBLE EXTRACTION ERROR: the name may mix text that does not belong
 * together, so a person should check it against the source before trusting it.
 */
import { isActionVerb } from '../semantic/directive.js';
import type { ClauseName } from './clause.js';

export type QualityFlag = 'cross-column' | 'label-glued' | 'leaked-marker' | 'fragment' | 'unbounded';

const PENALTY: Readonly<Record<QualityFlag, number>> = {
  'cross-column': 0.5,
  'label-glued': 0.5,
  'leaked-marker': 0.7,
  fragment: 0.8,
  unbounded: 0.9,
};

export interface QualityAssessment {
  readonly flags: readonly QualityFlag[];
  readonly confidence: number;
  readonly possibleExtractionError: boolean;
  /**
   * The text is too damaged to name an action from at all: joined across columns AND showing a second structural
   * defect (a leaked marker or a glued label). Fail closed — such a candidate is not minted.
   */
  readonly reject: boolean;
}

const MARKER_TOKEN = /^(?:\d{1,3}[.)]?|[a-z][.)]|\[[ xX]?\]|[•◦‣·*○-])$/;

export function assessCandidateQuality(args: {
  readonly prior: number;
  readonly sentence: string;
  readonly words: readonly string[];
  readonly verbIndex: number;
  readonly clause: ClauseName;
  readonly layoutSuspect: boolean;
}): QualityAssessment {
  const flags: QualityFlag[] = [];
  if (args.layoutSuspect) flags.push('cross-column');
  const firstObject = args.clause.objectWords[0];
  if (
    firstObject !== undefined &&
    /^\p{Lu}/u.test(firstObject) &&
    isActionVerb(firstObject) &&
    args.clause.verbPhrase.split(' ').length === 1
  ) {
    flags.push('label-glued');
  }
  if (args.verbIndex > 0 && args.words.slice(0, args.verbIndex).some((w) => MARKER_TOKEN.test(w.trim()))) flags.push('leaked-marker');
  const trimmed = args.sentence.trim();
  const opens = (trimmed.match(/\(/g) ?? []).length;
  const closes = (trimmed.match(/\)/g) ?? []).length;
  if (!/[.!?:]["')\]]?$/.test(trimmed) || opens !== closes) flags.push('fragment');
  if (!args.clause.bounded && args.clause.objectWords.length >= 6) flags.push('unbounded');
  let confidence = args.prior;
  for (const f of flags) confidence *= PENALTY[f];
  return {
    flags,
    confidence: Math.round(confidence * 1000) / 1000,
    possibleExtractionError: flags.includes('cross-column') || flags.includes('label-glued'),
    reject: flags.includes('cross-column') && (flags.includes('leaked-marker') || flags.includes('label-glued')),
  };
}

/** Metadata keys a capability carries for its quality assessment (string-valued, like all capability metadata). */
export const QUALITY_FLAGS_KEY = 'quality.flags';
export const EXTRACTION_REVIEW_KEY = 'quality.review';
export const POSSIBLE_EXTRACTION_ERROR = 'possible-extraction-error';

export function qualityMetadata(q: QualityAssessment): Readonly<Record<string, string>> {
  return {
    ...(q.flags.length > 0 ? { [QUALITY_FLAGS_KEY]: q.flags.join(',') } : {}),
    ...(q.possibleExtractionError ? { [EXTRACTION_REVIEW_KEY]: POSSIBLE_EXTRACTION_ERROR } : {}),
  };
}
