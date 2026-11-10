import type { ExperienceUnit } from '../semantic/types.js';
import type { CandidateKnowledgeNode } from './extractor-types.js';

/**
 * Confidence-gated escalation: decides, from the deterministic rule-based result ALONE, whether a unit is worth a model call.
 * The goal is not to call the model less; it is to spend inference only where it has a defensible chance of improving the output.
 *
 * This is a pure function over `CandidateKnowledgeNode[]` (it knows nothing about providers or budgets). Whether an escalated unit
 * is actually allowed to call a model is decided afterwards, by the compile-scoped spend guard in `@xo/ai-core`; this module never
 * bypasses it.
 *
 * Decision order (first match wins):
 *  1. `always` mode                                  -> escalate (legacy behaviour: every unit)
 *  2. too little text for a model to add anything    -> skip   (`insufficient_content`)
 *  3. no usable candidate                            -> escalate (`no_candidate`)
 *  4. best usable candidate below the threshold      -> escalate (`low_confidence`)
 *  5. competing candidates the rules cannot settle   -> escalate (`ambiguous`)
 *  6. otherwise                                       -> skip   (`strong`)
 *
 * "Usable" matters because rule confidences are heuristic priors, not validity: the capitalized-run detector assigns 0.65 to a
 * multi-word run even when it spans a line break or a comma (e.g. "Trust Clause\n\nCyber Risk Exclusion Clause"). Such a run is
 * never allowed to make a unit look strong.
 */
export interface EscalationPolicyConfig {
  /** `'always'` restores the pre-gating behaviour (every unit escalates). */
  readonly mode: 'gated' | 'always';
  /** A usable candidate must reach this confidence for the unit to count as strong. */
  readonly confidenceThreshold: number;
  /** Competing candidates whose confidences differ by at least this much are resolved deterministically in favour of the higher one. */
  readonly ambiguityMargin: number;
  /** Units with fewer words than this are never escalated: there is nothing for a model to add. */
  readonly minContentWords: number;
  /** A candidate label with more words than this is treated as malformed (not usable). */
  readonly maxLabelWords: number;
}

/**
 * Defaults come from measurement on the repository's real fixtures — see `docs/inference-cache-and-policy.md` ("Slice 6").
 * The rule extractor's confidences form tiers (0.5 / 0.6 / 0.65 / 0.7 for heuristic output, 0.85 only for an explicit defined term).
 * On 42 hand-annotated real units the heuristic tiers were wrong almost everywhere (41/42 units had an error), including 15 of 16
 * units that a 0.7 threshold would have called "strong". So the default treats ONLY the top tier (>= 0.75) as strong: a unit is
 * skipped on confidence alone when an explicit cue fired. Lowering the threshold saves more calls but, in that data, leaves
 * substantially more errors behind (see the sweep). That top tier did not occur in the fixtures, so skipping on it is a
 * design judgement about a cue, not something the fixtures could confirm.
 */
export const DEFAULT_ESCALATION_POLICY: EscalationPolicyConfig = {
  mode: 'gated',
  confidenceThreshold: 0.75,
  ambiguityMargin: 0.1,
  minContentWords: 4,
  maxLabelWords: 8,
};

export type EscalationReason = 'always' | 'insufficient_content' | 'no_candidate' | 'low_confidence' | 'ambiguous' | 'strong';

export interface EscalationDecision {
  readonly escalate: boolean;
  readonly reason: EscalationReason;
  /** Human-readable, content-free explanation (no unit text) suitable for logs. */
  readonly detail: string;
  readonly bestUsableConfidence: number | undefined;
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
  if (config.mode === 'always')
    return { escalate: true, reason: 'always', detail: 'escalation mode is "always"', bestUsableConfidence: undefined };

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
  if (bestUsable === undefined || (substantive.length === 0 && bestUsable < config.confidenceThreshold)) {
    return {
      escalate: true,
      reason: 'no_candidate',
      detail: 'no usable rule candidate reaches the threshold',
      bestUsableConfidence: bestUsable,
    };
  }
  if (bestUsable < config.confidenceThreshold) {
    return {
      escalate: true,
      reason: 'low_confidence',
      detail: `best usable confidence ${bestUsable} < threshold ${config.confidenceThreshold}`,
      bestUsableConfidence: bestUsable,
    };
  }

  const unresolved = competingPairs(usable).filter(([a, b]) => !resolvedDeterministically(a, b, config.ambiguityMargin));
  if (unresolved.length > 0) {
    return {
      escalate: true,
      reason: 'ambiguous',
      detail: `${unresolved.length} competing candidate pair(s) the rules cannot settle (margin ${config.ambiguityMargin})`,
      bestUsableConfidence: bestUsable,
    };
  }

  return {
    escalate: false,
    reason: 'strong',
    detail: `usable candidate at ${bestUsable} >= threshold ${config.confidenceThreshold}, no unresolved competition`,
    bestUsableConfidence: bestUsable,
  };
}
