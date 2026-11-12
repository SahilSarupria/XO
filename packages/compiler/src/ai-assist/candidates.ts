/**
 * Provider-independent, VALIDATED model assistance.
 *
 * A model (any provider, injected by the caller; none is bundled and no key is needed for deterministic compilation) may
 * PROPOSE a semantic reading of one sentence. That proposal is a CANDIDATE, never an authority. It must survive these
 * deterministic checks against the source sentence before anyone sees it as valid:
 *   - it refers to the sentence it was asked about, and quotes evidence that really occurs in it;
 *   - every span it extracts (condition, outcome, exceptions) is VERBATIM in the sentence — no paraphrase, no invented clause;
 *   - every number it uses occurs in the sentence — no invented values;
 *   - it cannot flip meaning: modality and polarity must match the deterministic classification, an outcome type must match
 *     the text (and cannot be claimed when the text states none), and a verbatim span may not drop a preceding negation or
 *     exception cue ("must NOT proceed" -> "proceed", "UNLESS the lead agrees" -> a condition);
 *   - its condition is structured by the DETERMINISTIC grammar (the model's structure is never trusted); a condition the
 *     grammar cannot structure is flagged, not presented as structured.
 * Validated candidates are never merged into the graph. They can enter a compilation only as a `user_instruction` prompt
 * source, which still requires an accountable human confirmation.
 */
import { parseStructuredCondition, type GrammarLexicon, type StructuredCondition } from '@xo/capability-contract';
import { classifyModality, type Modality, type Polarity } from '../reasoning/modality.js';
import { classifyOutcomeType, type OutcomeType } from '../reasoning/outcome-type.js';
import type { PromptSourceInput } from '../sources/prompt-frontend.js';

export interface SemanticCandidate {
  /** The exact source sentence this candidate is about. */
  readonly sentence: string;
  readonly condition?: string;
  readonly outcome?: string;
  readonly exceptions?: readonly string[];
  readonly modality?: Modality;
  readonly polarity?: Polarity;
  readonly outcomeType?: OutcomeType;
  /** A verbatim quote from the sentence that supports the reading. */
  readonly evidence: string;
  readonly confidence?: number;
  readonly rationale?: string;
}

export interface CandidateRequest {
  readonly sentence: string;
  /** Optional reference knowledge (advisory) the caller may pass along. */
  readonly hints?: readonly { readonly label: string; readonly definition: string }[];
}

export interface CandidateProvider {
  propose(request: CandidateRequest): Promise<readonly SemanticCandidate[]>;
}

export interface CandidateValidation {
  readonly status: 'validated' | 'rejected';
  readonly reasons: readonly string[];
  readonly flags: readonly string[];
  /** Condition structure produced by the deterministic grammar (absent when it cannot structure the text). */
  readonly structured?: StructuredCondition;
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.;:,]+$/, '')
    .trim();
const numbersOf = (s: string): string[] => (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ''));
const NEGATION_OR_EXCEPTION = /^(?:not|no|never|cannot|without|neither|nor|unless|except)$|n't$/;

function precedingCue(normSentence: string, normSpan: string): string | undefined {
  const idx = normSentence.indexOf(normSpan);
  if (idx <= 0) return undefined;
  const tokens = normSentence
    .slice(0, idx)
    .split(' ')
    .map((t) => t.replace(/[^\p{L}\p{N}']/gu, ''))
    .filter((t) => t.length > 0)
    .slice(-3);
  return tokens.find((t) => NEGATION_OR_EXCEPTION.test(t));
}

export function validateCandidate(candidate: unknown, sentence: string, lexicon?: GrammarLexicon): CandidateValidation {
  const reasons: string[] = [];
  const flags: string[] = [];
  const c = candidate as Partial<SemanticCandidate> | null;
  if (c === null || typeof c !== 'object' || typeof c.sentence !== 'string' || typeof c.evidence !== 'string') {
    return { status: 'rejected', reasons: ['malformed candidate (missing sentence or evidence)'], flags };
  }
  const ns = norm(sentence);
  if (norm(c.sentence) !== ns) reasons.push('the candidate is about a different sentence than the one it was asked about');
  const ev = norm(c.evidence);
  if (ev.length < 8 || !ns.includes(ev)) reasons.push('the evidence quote does not occur in the sentence');

  const spans: { kind: 'condition' | 'outcome' | 'exception'; text: string }[] = [];
  if (c.condition !== undefined) spans.push({ kind: 'condition', text: c.condition });
  if (c.outcome !== undefined) spans.push({ kind: 'outcome', text: c.outcome });
  for (const e of c.exceptions ?? []) spans.push({ kind: 'exception', text: e });

  const sentenceNumbers = new Set(numbersOf(sentence));
  for (const span of spans) {
    const nspan = norm(span.text);
    if (nspan.length === 0 || !ns.includes(nspan)) {
      reasons.push(`the ${span.kind} text is not verbatim in the sentence (no paraphrase or invented clause)`);
      continue;
    }
    for (const n of numbersOf(span.text))
      if (!sentenceNumbers.has(n)) reasons.push(`the ${span.kind} uses the number ${n}, which does not occur in the sentence`);
    if (span.kind !== 'exception') {
      const cue = precedingCue(ns, nspan);
      if (cue !== undefined)
        reasons.push(`the ${span.kind} span drops a preceding negation/exception cue ("${cue}"), which would change its meaning`);
    }
  }

  const modalityText = c.outcome ?? sentence;
  const det = classifyModality(modalityText);
  if (c.modality !== undefined && c.modality !== det.modality)
    reasons.push(`modality "${c.modality}" contradicts the text (deterministic reading: ${det.modality})`);
  if (c.polarity !== undefined && c.polarity !== det.polarity)
    reasons.push(`polarity "${c.polarity}" contradicts the text (deterministic reading: ${det.polarity})`);
  if (c.outcomeType !== undefined) {
    const detOutcome = classifyOutcomeType(c.outcome ?? sentence);
    if (c.outcomeType !== detOutcome) {
      reasons.push(
        detOutcome === 'none'
          ? `an outcome "${c.outcomeType}" is claimed but the text states no such outcome`
          : `outcome type "${c.outcomeType}" contradicts the text (deterministic reading: ${detOutcome})`,
      );
    }
  }

  if (reasons.length > 0) return { status: 'rejected', reasons, flags };
  let structured: StructuredCondition | undefined;
  if (c.condition !== undefined) {
    structured = parseStructuredCondition(c.condition, lexicon);
    if (structured === undefined) flags.push('unstructured-condition');
  }
  return { status: 'validated', reasons: [], flags, ...(structured !== undefined ? { structured } : {}) };
}

export interface CandidateRunResult {
  readonly sentence: string;
  readonly results: readonly { readonly candidate: SemanticCandidate; readonly validation: CandidateValidation }[];
  /** Set when the provider failed; the failure never propagates into compilation. */
  readonly error?: string;
}

const MAX_CANDIDATES_PER_SENTENCE = 5;

export async function runCandidateProvider(
  provider: CandidateProvider,
  targets: readonly CandidateRequest[],
  options: { readonly lexicon?: GrammarLexicon } = {},
): Promise<CandidateRunResult[]> {
  const runs: CandidateRunResult[] = [];
  for (const target of targets) {
    try {
      const out = await provider.propose(target);
      const list = Array.isArray(out) ? out.slice(0, MAX_CANDIDATES_PER_SENTENCE) : [];
      runs.push({
        sentence: target.sentence,
        results: list.map((candidate) => ({
          candidate: candidate as SemanticCandidate,
          validation: validateCandidate(candidate, target.sentence, options.lexicon),
        })),
      });
    } catch (cause) {
      runs.push({ sentence: target.sentence, results: [], error: (cause as Error).message });
    }
  }
  return runs;
}

/**
 * Turns VALIDATED candidates into prompt sources built only from their verbatim spans. They are `user_instruction` sources
 * and compile only when `confirmedBy` names a person; with a blank identity they stay unconfirmed (and contribute nothing).
 */
export function acceptedCandidatesToPromptSources(runs: readonly CandidateRunResult[], confirmedBy: string): PromptSourceInput[] {
  const who = confirmedBy.trim();
  const out: PromptSourceInput[] = [];
  for (const run of runs) {
    for (const { candidate, validation } of run.results) {
      if (validation.status !== 'validated' || candidate.outcome === undefined) continue;
      const exception =
        candidate.exceptions !== undefined && candidate.exceptions.length > 0 ? ` unless ${candidate.exceptions.join(' or ')}` : '';
      const text = `${candidate.condition !== undefined ? `If ${candidate.condition}, ` : ''}${candidate.outcome}${exception}.`;
      out.push({ kind: 'prompt', text, sourcePath: `ai-candidate-${out.length + 1}`, ...(who.length > 0 ? { confirmedBy: who } : {}) });
    }
  }
  return out;
}
