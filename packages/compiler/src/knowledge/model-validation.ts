import type { ExperienceUnit } from '../semantic/types.js';
import type { ExtractionResult } from './extractor-types.js';

const MAX_LABEL_CHARS = 500;
/** Cheap stemming by 5-letter prefix, so an abstraction like "compliance" is still grounded in "comply". Deliberately tolerant: a literal-word match rejected legitimate paraphrases. */
const stem = (word: string): string => word.slice(0, 5);
const STOPWORDS = new Set([
  'that',
  'this',
  'with',
  'from',
  'shall',
  'will',
  'have',
  'been',
  'were',
  'which',
  'their',
  'there',
  'would',
  'about',
  'into',
  'than',
  'then',
  'such',
  'other',
  'under',
  'upon',
]);

/** The ONLY rejection codes: fixed, content-free, safe to log and report. Never extend with free text, labels, ids or model output. */
export const MODEL_REJECTION_CODES = [
  'empty_label',
  'label_too_long',
  'control_chars',
  'confidence_out_of_range',
  'duplicate_local_id',
  'dangling_edge',
  'ungrounded_label',
  'edge_confidence_out_of_range',
] as const;
export type ModelRejectionCode = (typeof MODEL_REJECTION_CODES)[number];

/**
 * Compile-side validation of model-derived knowledge, applied on top of `@xo/ai-core`'s JSON-schema validation (which only checks
 * STRUCTURE). Returns the violations; an empty array means acceptable. The caller REJECTS the whole model result when any violation
 * is found (all-or-nothing, never a partial silent accept): the rule-based result for the unit stands and the rejection is reported.
 *
 * Returns FIXED CODES only (`ModelRejectionCode`), one entry per violation: no labels, ids, unit text or model output ever appear in
 * the result, so it is safe to count, report and log. Validation stays all-or-nothing.
 *
 * Checks, all deterministic:
 *  - every label is non-empty, bounded in length and free of control characters
 *  - every confidence is a finite number in [0, 1]
 *  - local ids are unique
 *  - every edge references nodes that exist in the same result (no dangling edges)
 *  - GROUNDING (weak by design): every label shares at least one content word stem (5-letter prefix; word >= 4 letters, not a
 *    stopword) with the unit's text or title. This catches output unrelated to the unit; it does NOT prove a paraphrase is faithful,
 *    and a purely abstract label with no shared stem would be rejected (a known false-reject risk, reported rather than hidden).
 */
export function validateModelExtraction(unit: ExperienceUnit, extraction: ExtractionResult): ModelRejectionCode[] {
  const violations: ModelRejectionCode[] = [];
  const stems = new Set((`${unit.title}\n${unit.content}`.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []).map(stem));
  const seen = new Set<string>();

  for (const node of extraction.nodes) {
    if (seen.has(node.localId)) violations.push('duplicate_local_id');
    seen.add(node.localId);
    const label = node.label.trim();
    if (label.length === 0) violations.push('empty_label');
    else if (label.length > MAX_LABEL_CHARS) violations.push('label_too_long');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(node.label)) violations.push('control_chars');
    if (!(Number.isFinite(node.confidence) && node.confidence >= 0 && node.confidence <= 1)) violations.push('confidence_out_of_range');
    if (label.length > 0) {
      const words = label.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? [];
      const content = words.filter((w) => !STOPWORDS.has(w));
      if (content.length > 0 && !content.some((w) => stems.has(stem(w)))) {
        violations.push('ungrounded_label');
      }
    }
  }

  for (const edge of extraction.edges) {
    if (!seen.has(edge.fromLocalId) || !seen.has(edge.toLocalId)) violations.push('dangling_edge');
    if (!(Number.isFinite(edge.confidence) && edge.confidence >= 0 && edge.confidence <= 1))
      violations.push('edge_confidence_out_of_range');
  }
  return violations;
}
