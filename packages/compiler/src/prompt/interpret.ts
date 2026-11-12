/**
 * Prompt interpretation: turns a natural-language instruction ("build X that does Y") into an INSPECTABLE candidate
 * specification — statements, intents, and targeted questions — before anything is compiled.
 *
 * Trust model: a prompt is a `user_instruction`, not document evidence. It states what its author WANTS; it does not
 * prove what an organisation knows or has authorised, and it cannot grant permissions or name integrations that were not
 * declared. So this module:
 *  - separates rule-shaped STATEMENTS (which can flow through the same typed pipeline as documents) from INTENTS
 *    (purpose statements that are not rules and are never turned into executable branches);
 *  - converts every missing fact (threshold, approver, recipient, criterion, deadline) into a QUESTION instead of
 *    inventing a value, a connector, or an approval path;
 *  - flags an unconditional approval for explicit confirmation.
 * Deterministic and language-cue only (no subject-matter vocabulary). No model is involved; an AI interpreter may later
 * PROPOSE a richer interpretation, which must still pass the same validation and confirmation.
 */
import { parseStructuredCondition, type GrammarLexicon } from '@xo/capability-contract';
import { splitSentences } from '../capabilities/sentence-split.js';
import { classifySentenceKind, type ContentKind } from '../document/content-classification.js';
import { classifyModality, type Modality, type Polarity } from '../reasoning/modality.js';
import { classifyOutcomeType, type OutcomeType } from '../reasoning/outcome-type.js';
import { parseSentence } from '../reasoning/rule-pattern-parser.js';

export type QuestionReason =
  | 'missing-threshold'
  | 'missing-approver'
  | 'missing-target'
  | 'missing-criterion'
  | 'missing-duration'
  | 'missing-condition'
  | 'unformalized-condition'
  | 'unconditional-approval';

export interface PromptStatement {
  readonly text: string;
  readonly kind: ContentKind;
  readonly modality: Modality;
  readonly polarity: Polarity;
  readonly outcomeType: OutcomeType;
  /** True when the sentence has a condition that the typed grammar structures completely. */
  readonly structurable: boolean;
}

export interface PromptIntent {
  readonly text: string;
  /** The behaviours the author asked for, split from the purpose statement. They are requests, not rules. */
  readonly behaviours: readonly string[];
}

export interface ClarificationQuestion {
  readonly reason: QuestionReason;
  /** The sentence or behaviour that raised the question. */
  readonly about: string;
  readonly question: string;
}

export type PromptStatus = 'ready' | 'needs_clarification' | 'no_actionable_content';

export interface PromptInterpretation {
  readonly statements: readonly PromptStatement[];
  readonly intents: readonly PromptIntent[];
  readonly questions: readonly ClarificationQuestion[];
  readonly status: PromptStatus;
}

const LIST_PREFIX = /^\s*(?:[-*+\u2022]|\d+(?:\.\d+)*[.)])\s+/;
const INTENT_LEAD =
  /^(?:please\s+)?(?:(?:i|we)\s+(?:want|need|would\s+like)(?:\s+you)?\s+to\s+)?(?:build|create|make|design|set\s+up|develop|generate|implement)\b|^(?:i|we)\s+(?:want|need)\b/i;
const CONDITION_CUE = /\b(?:if|when|whenever|where|unless|provided\s+that|only\s+if|only\s+when|in\s+case|subject\s+to)\b/i;
const NORMATIVE: ReadonlySet<ContentKind> = new Set<ContentKind>(['rule', 'obligation', 'permission', 'prohibition', 'procedure']);

function candidateLines(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(LIST_PREFIX, '').trim();
    if (line.length === 0) continue;
    for (const sentence of splitSentences(line)) {
      const s = sentence.text.trim();
      if (s.split(/\s+/).length >= 3) out.push(s);
    }
  }
  return out;
}

function behavioursOf(sentence: string): string[] {
  const body = sentence.replace(/[.!?]+$/, '');
  const rest = /\b(?:that|which|to)\s+(.+)$/i.exec(body)?.[1];
  if (rest === undefined) return [];
  return rest
    .split(/,\s*(?:and\s+)?|\s+and\s+/i)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

function behaviourQuestions(behaviour: string, about: string): ClarificationQuestion[] {
  const qs: ClarificationQuestion[] = [];
  const ask = (reason: QuestionReason, question: string): void => void qs.push({ reason, about, question });
  const hasNumber = /\d/.test(behaviour);
  if (
    /\b(?:check|checks|validate|validates|verify|verifies|review|reviews)\b/i.test(behaviour) &&
    !/\b(?:against|whether|if|that|matches?|contains?|has|have|is|are)\b/i.test(behaviour)
  ) {
    ask('missing-criterion', `What exactly counts as acceptable when "${behaviour}" (what are the criteria)?`);
  }
  if (/\b(?:limits?|thresholds?|caps?|maximum|minimum|budget|ceiling|quota)\b/i.test(behaviour) && !hasNumber) {
    ask('missing-threshold', `What is the value (and unit) of the limit in "${behaviour}"?`);
  }
  if (/\b(?:approval|approve|approves|sign-?off|authori[sz]ation)\b/i.test(behaviour)) {
    ask('missing-approver', `Who gives the approval in "${behaviour}", and through which declared integration or channel is it requested?`);
  }
  if (/\b(?:email|emails|notify|notifies|alert|alerts|message|messages|send|sends|post|posts|call|calls)\b/i.test(behaviour)) {
    ask(
      'missing-target',
      `Who or what receives the output of "${behaviour}", and through which declared integration should it be delivered?`,
    );
  }
  if (/\b(?:promptly|quickly|timely|soon|deadline|on\s+time)\b/i.test(behaviour) && !hasNumber) {
    ask('missing-duration', `How long is allowed in "${behaviour}"?`);
  }
  if (/\bescalat\w*\b/i.test(behaviour) && !/\b(?:when|if|to)\b/i.test(behaviour)) {
    ask('missing-condition', `Under what condition, and to whom, should "${behaviour}" happen?`);
  }
  return qs;
}

function statementOf(sentence: string, lexicon?: GrammarLexicon): PromptStatement | undefined {
  const kind = classifySentenceKind(sentence);
  if (!NORMATIVE.has(kind)) return undefined;
  const { modality, polarity } = classifyModality(sentence);
  const candidates = parseSentence(sentence).candidates.filter((c) => c.nodeType === 'rule' || c.nodeType === 'decision');
  const structurable = candidates.some((c) => c.condition !== undefined && parseStructuredCondition(c.condition, lexicon) !== undefined);
  return { text: sentence, kind, modality, polarity, outcomeType: classifyOutcomeType(sentence), structurable };
}

/**
 * The prompt text with every INTENT sentence removed, line structure preserved. This is what flows into the extraction
 * pipeline: a purpose statement ("build a system that emails the owner") is a request, not evidence, and must not be
 * mistaken by capability discovery for a recognised, existing capability. Intents stay visible through
 * `interpretPrompt` and the `prompt/unformalized-intent` diagnostic.
 */
export function stripIntentSentences(text: string): string {
  const kept: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const prefixMatch = LIST_PREFIX.exec(rawLine);
    const prefix = prefixMatch?.[0] ?? '';
    const body = rawLine.slice(prefix.length).trim();
    if (body.length === 0) {
      kept.push(rawLine);
      continue;
    }
    const sentences = splitSentences(body).map((x) => x.text.trim());
    const remaining = sentences.filter((x) => !INTENT_LEAD.test(x));
    if (remaining.length === sentences.length) kept.push(rawLine);
    else if (remaining.length > 0) kept.push(`${prefix}${remaining.join(' ')}`);
  }
  return kept.join('\n');
}

export function interpretPrompt(text: string, lexicon?: GrammarLexicon): PromptInterpretation {
  const statements: PromptStatement[] = [];
  const intents: PromptIntent[] = [];
  const questions: ClarificationQuestion[] = [];

  for (const sentence of candidateLines(text)) {
    if (INTENT_LEAD.test(sentence)) {
      const behaviours = behavioursOf(sentence);
      intents.push({ text: sentence, behaviours });
      for (const b of behaviours) questions.push(...behaviourQuestions(b, sentence));
      continue;
    }
    const statement = statementOf(sentence, lexicon);
    if (statement === undefined) continue;
    statements.push(statement);

    const conditional = CONDITION_CUE.test(sentence);
    if (conditional && !statement.structurable) {
      questions.push({
        reason: 'unformalized-condition',
        about: sentence,
        question: `I could not formalize the condition in "${sentence}". Could you restate it as a measurable comparison, a status, or a duration?`,
      });
    }
    if (statement.outcomeType === 'approve' && !conditional) {
      questions.push({
        reason: 'unconditional-approval',
        about: sentence,
        question: `"${sentence}" approves without any condition. Is that intended?`,
      });
    }
  }

  const status: PromptStatus =
    statements.length === 0 && intents.length === 0 ? 'no_actionable_content' : questions.length > 0 ? 'needs_clarification' : 'ready';
  return { statements, intents, questions, status };
}
