import type { ExperienceUnit } from '../semantic/types.js';
import type { CandidateKnowledgeNode } from './extractor-types.js';

/**
 * Escalation policy for the knowledge hybrid extractor: decides, per unit, whether a model call is made.
 *
 * DEFAULT (`mode: 'always'`): escalate EVERY unit that has content (>= `minContentWords` words, default 1, i.e. only empty or
 * whitespace-only units are skipped). No rule confidence and no candidate competition ever suppresses a call by default.
 *
 * Why: the live evaluation (docs/inference-cache-and-policy.md, "Slice 6") found confidence-based gating NOT SUPPORTED. At the
 * default 0.75 threshold the gate escalated every unit anyway (21/21 dev, 22/22 held-out), identical to always-escalate; at 0.60/0.65
 * it escalated 8/21 dev units and lost recall (F1 .648, recall .848, outside the pre-registered 0.02 tolerance). The rules' own
 * confidences are heuristic priors, not validity, so they are not a basis for skipping inference.
 *
 * `mode: 'gated'` is retained ONLY as an explicit opt-in and is EXPERIMENTAL, NOT SUPPORTED by evidence. Its decision order is
 * (first match wins): fragment skip -> no usable candidate -> best usable below threshold -> unresolved competing candidates -> strong.
 * No heuristic was extended after the evaluation, and `minContentWords` values above 1 are UNVALIDATED.
 *
 * This is a pure function over `CandidateKnowledgeNode[]` (it knows nothing about providers or budgets). Whether an escalated unit is
 * actually allowed to call a model is decided afterwards by the compile-scoped spend guard in `@xo/ai-core`; this module never
 * bypasses it.
 */
export interface EscalationPolicyConfig {
  /** `'always'` (DEFAULT): escalate every unit with enough content. `'gated'`: EXPERIMENTAL, NOT SUPPORTED by evidence; explicit opt-in only. */
  readonly mode: 'gated' | 'always';
  /** Gated mode only (experimental): a usable candidate must reach this confidence for the unit to count as strong. */
  readonly confidenceThreshold: number;
  /** Gated mode only (experimental): competing candidates whose confidences differ by at least this much are resolved in favour of the higher one. */
  readonly ambiguityMargin: number;
  /**
   * Units with fewer words than this are never escalated. Default 1 skips only empty/whitespace-only units. Larger values are opt-in
   * and UNVALIDATED: no evaluation supports any particular fragment cut-off.
   */
  readonly minContentWords: number;
  /** Diagnostics and gated mode: a candidate label with more words than this is treated as malformed (not usable). */
  readonly maxLabelWords: number;
}

/**
 * Default: escalate every non-empty unit. Confidence gating is NOT SUPPORTED by the live evaluation (see the header of this file and
 * `docs/inference-cache-and-policy.md`), so no confidence or competition signal suppresses a call unless a caller explicitly opts in
 * to `mode: 'gated'`. The remaining thresholds only matter in that experimental mode and for report diagnostics.
 */
export const DEFAULT_ESCALATION_POLICY: EscalationPolicyConfig = {
  mode: 'always',
  confidenceThreshold: 0.75,
  ambiguityMargin: 0.1,
  minContentWords: 1,
  maxLabelWords: 8,
};

export type EscalationReason = 'always' | 'insufficient_content' | 'no_candidate' | 'low_confidence' | 'ambiguous' | 'strong';

/** What the experimental gate WOULD decide from the rule output alone. Diagnostic only: never affects a call unless `mode` is `'gated'`. */
export type RuleTier = 'no_candidate' | 'low_confidence' | 'strong';

export interface EscalationDecision {
  readonly escalate: boolean;
  readonly reason: EscalationReason;
  /** Human-readable, content-free explanation (no unit text) suitable for logs. */
  readonly detail: string;
  readonly bestUsableConfidence: number | undefined;
  /** Diagnostic counts source (content-free): the rule-confidence tier of this unit, and whether unresolved competing candidates exist. */
  readonly diagnostics?: { readonly ruleTier: RuleTier; readonly competing: boolean };
}

export function validateEscalationPolicy(config: EscalationPolicyConfig): EscalationPolicyConfig {
  const bad = (name: string, rule: string): never => {
    throw new RangeError(`escalation ${name} ${rule}`);
  };
  if (config.mode !== 'gated' && config.mode !== 'always') bad('mode', "must be 'gated' or 'always'");
  if (!(Number.isFinite(config.confidenceThreshold) && config.confidenceThreshold >= 0 && config.confidenceThreshold <= 1))
    bad('confidenceThreshold', 'must be in [0, 1]');
  if (!(Number.isFinite(config.ambiguityMargin) && config.ambiguityMargin >= 0 && config.ambiguityMargin <= 1))
    bad('ambiguityMargin', 'must be in [0, 1]');
  if (!(Number.isInteger(config.minContentWords) && config.minContentWords >= 0)) bad('minContentWords', 'must be an integer >= 0');
  if (!(Number.isInteger(config.maxLabelWords) && config.maxLabelWords >= 1)) bad('maxLabelWords', 'must be an integer >= 1');
  return config;
}

/** Reads `XO_COMPILER_ESCALATION_{MODE,CONFIDENCE_THRESHOLD,AMBIGUITY_MARGIN,MIN_CONTENT_WORDS}`; unset values keep the defaults, invalid ones throw. */
export function resolveEscalationPolicy(env: Readonly<Record<string, string | undefined>> = process.env): EscalationPolicyConfig {
  const num = (name: string): number | undefined => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new RangeError(`${name} must be a number, got "${raw.slice(0, 40)}"`);
    return value;
  };
  const mode = env['XO_COMPILER_ESCALATION_MODE']?.trim();
  if (mode !== undefined && mode !== '' && mode !== 'gated' && mode !== 'always')
    throw new RangeError('XO_COMPILER_ESCALATION_MODE must be "gated" or "always"');
  return validateEscalationPolicy({
    ...DEFAULT_ESCALATION_POLICY,
    ...(mode === 'gated' || mode === 'always' ? { mode } : {}),
    confidenceThreshold: num('XO_COMPILER_ESCALATION_CONFIDENCE_THRESHOLD') ?? DEFAULT_ESCALATION_POLICY.confidenceThreshold,
    ambiguityMargin: num('XO_COMPILER_ESCALATION_AMBIGUITY_MARGIN') ?? DEFAULT_ESCALATION_POLICY.ambiguityMargin,
    minContentWords: num('XO_COMPILER_ESCALATION_MIN_CONTENT_WORDS') ?? DEFAULT_ESCALATION_POLICY.minContentWords,
  });
}

const wordCount = (text: string): number => text.split(/\s+/).filter((w) => w.length > 0).length;
const normalize = (label: string): string =>
  label
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,:;]+$/, '')
    .trim();

/** A label is usable when it is a single clean phrase: non-empty, bounded length, no line break/comma/semicolon/colon inside. */
export function isUsableLabel(label: string, maxLabelWords: number): boolean {
  const core = label.trim().replace(/[.,:;]+$/, '');
  return core.length > 0 && wordCount(core) <= maxLabelWords && !/[\n\r,;:]/.test(core);
}

/** More specific interpretations win deterministically over less specific ones for the same text. */
const SPECIFICITY: Readonly<Record<string, number>> = { organization: 2, entity: 1, definition: 2, concept: 1 };

function overlaps(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

/**
 * Pairs of candidates that make DIFFERENT claims about the same text: same normalized label with different types, or overlapping
 * character spans with different types (two non-primary candidates). Same label AND same type is a duplicate, not a competition.
 */
function competingPairs(nodes: readonly CandidateKnowledgeNode[]): [CandidateKnowledgeNode, CandidateKnowledgeNode][] {
  const pairs: [CandidateKnowledgeNode, CandidateKnowledgeNode][] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      if (a.semanticType === b.semanticType) continue;
      const sameLabel = normalize(a.label) === normalize(b.label);
      const ra = a.provenance.charOffsetRange;
      const rb = b.provenance.charOffsetRange;
      const spanClash = !a.isUnitPrimary && !b.isUnitPrimary && ra !== undefined && rb !== undefined && overlaps(ra, rb);
      if (sameLabel || spanClash) pairs.push([a, b]);
    }
  }
  return pairs;
}

/** `true` when the rules can settle this pair themselves: a clear confidence gap, or an explicit specificity ordering. */
function resolvedDeterministically(a: CandidateKnowledgeNode, b: CandidateKnowledgeNode, margin: number): boolean {
  if (Math.abs(a.confidence - b.confidence) >= margin) return true;
  const sa = SPECIFICITY[a.semanticType];
  const sb = SPECIFICITY[b.semanticType];
  return sa !== undefined && sb !== undefined && sa !== sb;
}

export function decideEscalation(
  unit: ExperienceUnit,
  ruleNodes: readonly CandidateKnowledgeNode[],
  config: EscalationPolicyConfig = DEFAULT_ESCALATION_POLICY,
): EscalationDecision {
  // Fragment skip applies in every mode. With the default minContentWords of 1 it only skips empty/whitespace-only units.
  const words = wordCount(unit.content);
  if (words < config.minContentWords) {
    return {
      escalate: false,
      reason: 'insufficient_content',
      detail: `${words} word(s) < minContentWords ${config.minContentWords}`,
      bestUsableConfidence: undefined,
    };
  }

  const usable = ruleNodes.filter((n) => isUsableLabel(n.label, config.maxLabelWords));
  const bestUsable = usable.length === 0 ? undefined : Math.max(...usable.map((n) => n.confidence));
  const substantive = usable.filter((n) => !n.isUnitPrimary);
  const unresolved = competingPairs(usable).filter(([a, b]) => !resolvedDeterministically(a, b, config.ambiguityMargin));
  const ruleTier: RuleTier =
    bestUsable === undefined || (substantive.length === 0 && bestUsable < config.confidenceThreshold)
      ? 'no_candidate'
      : bestUsable < config.confidenceThreshold
        ? 'low_confidence'
        : 'strong';
  const diagnostics = { ruleTier, competing: unresolved.length > 0 } as const;

  if (config.mode === 'always')
    return { escalate: true, reason: 'always', detail: 'escalation mode is "always"', bestUsableConfidence: bestUsable, diagnostics };

  // ---- EXPERIMENTAL gated mode (NOT SUPPORTED by evidence; explicit opt-in only) ----
  if (ruleTier === 'no_candidate') {
    return {
      escalate: true,
      reason: 'no_candidate',
      detail: 'no usable rule candidate reaches the threshold',
      bestUsableConfidence: bestUsable,
      diagnostics,
    };
  }
  if (ruleTier === 'low_confidence') {
    return {
      escalate: true,
      reason: 'low_confidence',
      detail: `best usable confidence ${bestUsable} < threshold ${config.confidenceThreshold}`,
      bestUsableConfidence: bestUsable,
      diagnostics,
    };
  }
  if (unresolved.length > 0) {
    return {
      escalate: true,
      reason: 'ambiguous',
      detail: `${unresolved.length} competing candidate pair(s) the rules cannot settle (margin ${config.ambiguityMargin})`,
      bestUsableConfidence: bestUsable,
      diagnostics,
    };
  }
  return {
    escalate: false,
    reason: 'strong',
    detail: `usable candidate at ${bestUsable} >= threshold ${config.confidenceThreshold}, no unresolved competition`,
    bestUsableConfidence: bestUsable,
    diagnostics,
  };
}
