import { parseStructuredCondition, type StructuredCondition } from '@xo/capability-contract';
import type { UnclassifiedSentence } from './types.js';

/**
 * WS1-09: model-assisted rule proposals over the review list, with a human in the loop.
 *
 * The deterministic patterns cannot parse every decision-bearing sentence; those sentences are listed for review
 * (`UnclassifiedSentence`). A language model can read such a sentence and PROPOSE a rule — a condition in the runtime's
 * own grammar and an outcome. This module is deliberately provider-agnostic (a proposer is any async function) and
 * deliberately cannot promote anything on its own (CRD-04):
 *
 *   1. `proposeRules` asks a `RuleProposer` about each review item and VALIDATES the answer. A proposal is only
 *      `valid` when its condition parses in the same grammar the runtime executes, every number in it appears in
 *      the source sentence, its field and outcome words are grounded in the sentence, and the sentence carries no
 *      exception clause (which a single rule cannot represent). Anything else is `rejected` with a reason.
 *   2. A `valid` proposal is still only a proposal. `confirmProposal` turns it into a `ConfirmedRule` and requires
 *      a named reviewer; it refuses invalid proposals.
 *   3. Only `ConfirmedRule`s are accepted by the compiler (`CompileSourcesOptions.confirmedRules`); they emit an
 *      ordinary rule node (confidence 0.75, `rule:confirmed-proposal`) that the existing minter and runtime treat
 *      like any other rule. The source sentence stays the rule's rationale and provenance.
 */

export interface RawRuleProposal {
  readonly condition: string;
  readonly outcome: string;
}

/** Any model (or person, or test double). Returns `undefined` when the sentence is not a rule. */
export type RuleProposer = (sentence: UnclassifiedSentence) => Promise<RawRuleProposal | undefined>;

export type ProposalStatus = 'valid' | 'rejected';

export interface RuleProposal {
  readonly sourceText: string;
  readonly sourceUnitId: string;
  readonly condition: string;
  readonly outcome: string;
  readonly status: ProposalStatus;
  /** Why a proposal was rejected; empty for a valid one. */
  readonly reasons: readonly string[];
}

export interface ConfirmedRule {
  readonly sourceText: string;
  readonly condition: string;
  readonly outcome: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
}

const STOP = new Set([
  'the',
  'a',
  'an',
  'of',
  'to',
  'is',
  'are',
  'be',
  'by',
  'for',
  'in',
  'on',
  'at',
  'and',
  'or',
  'as',
  'than',
  'that',
  'it',
  'with',
]);
/** Words a condition's field phrase may contain without appearing in the sentence (they name the unit or measure, not a fact). */
const FIELD_META = new Set([
  'since',
  'percentage',
  'amount',
  'days',
  'day',
  'hours',
  'hour',
  'working',
  'months',
  'month',
  'years',
  'year',
  'count',
]);
const EXCEPTION = /\b(unless|except|excluding|other than|save for)\b/i;
const MIN_GROUNDED = 0.6;

export function sourceKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

function stem(word: string): string {
  return word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

/** A word is grounded when the sentence has it, its singular, or a word sharing a 3+ letter prefix with it ("age" / "aged"). */
function isGrounded(word: string, source: ReadonlySet<string>): boolean {
  const w = stem(word);
  if (source.has(w)) return true;
  if (w.length < 3) return false;
  for (const s of source) if (s.length >= 3 && (s.startsWith(w) || w.startsWith(s))) return true;
  return false;
}

function groundedShare(words: readonly string[], source: ReadonlySet<string>): number {
  if (words.length === 0) return 1;
  return words.filter((w) => isGrounded(w, source)).length / words.length;
}

function fieldsOf(c: StructuredCondition): string[] {
  if (c.type === 'and' || c.type === 'or') return c.operands.flatMap(fieldsOf);
  const field = (c as { field?: string }).field;
  return field === undefined ? [] : [field];
}

/** Checks one raw proposal against its source sentence. Pure and deterministic. */
export function validateProposal(sentence: UnclassifiedSentence, raw: RawRuleProposal): RuleProposal {
  const reasons: string[] = [];
  const condition = raw.condition.trim();
  const outcome = raw.outcome.trim();
  const source = sentence.text;
  const sourceWords = new Set(contentWords(source).map(stem));

  const parsed = condition.length === 0 ? undefined : parseStructuredCondition(condition);
  if (parsed === undefined) reasons.push('condition is not in the grammar the runtime executes');
  if (outcome.length === 0) reasons.push('outcome is empty');
  else if (outcome.length > 200) reasons.push('outcome is too long to be a single action');
  if (EXCEPTION.test(source)) reasons.push('the sentence has an exception clause, which a single rule cannot represent');

  const sourceNumbers = new Set((source.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, '')));
  for (const n of condition.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) {
    if (!sourceNumbers.has(n.replace(/,/g, ''))) reasons.push(`the number ${n} does not appear in the sentence`);
  }
  if (parsed !== undefined) {
    for (const f of fieldsOf(parsed)) {
      const words = contentWords(f).filter((w) => !FIELD_META.has(w));
      if (groundedShare(words, sourceWords) < MIN_GROUNDED) reasons.push(`the field "${f}" is not grounded in the sentence`);
    }
  }
  if (outcome.length > 0 && groundedShare(contentWords(outcome), sourceWords) < MIN_GROUNDED) {
    reasons.push('the outcome is not grounded in the sentence');
  }
  return {
    sourceText: source,
    sourceUnitId: sentence.sourceUnitId,
    condition,
    outcome,
    status: reasons.length === 0 ? 'valid' : 'rejected',
    reasons,
  };
}

/** Asks `propose` about each review item. A thrown or empty answer yields no proposal for that item; it never aborts the batch. */
export async function proposeRules(items: readonly UnclassifiedSentence[], propose: RuleProposer): Promise<readonly RuleProposal[]> {
  const out: RuleProposal[] = [];
  for (const item of items) {
    let raw: RawRuleProposal | undefined;
    try {
      raw = await propose(item);
    } catch {
      continue;
    }
    if (raw === undefined) continue;
    out.push(validateProposal(item, raw));
  }
  return out;
}

/** The human step. Requires a named reviewer and refuses a proposal that did not validate. */
export function confirmProposal(proposal: RuleProposal, confirmedBy: string, confirmedAt: string): ConfirmedRule {
  if (confirmedBy.trim().length === 0) throw new Error('a confirmed rule needs a named reviewer');
  if (proposal.status !== 'valid') throw new Error(`cannot confirm a rejected proposal: ${proposal.reasons.join('; ')}`);
  return { sourceText: proposal.sourceText, condition: proposal.condition, outcome: proposal.outcome, confirmedBy, confirmedAt };
}

// --- Provider-agnostic model adapter ---------------------------------------------------------------

/** The instruction a model receives. It lists the exact condition shapes the runtime can run, so a proposal is checkable. */
export function buildProposalPrompt(sentence: UnclassifiedSentence): string {
  return [
    'You convert one sentence from an insurance document into a checkable rule, or decline.',
    'Reply with JSON only: {"rule": null} when the sentence is not a rule that can be checked from numbers or categories,',
    'otherwise {"rule": {"condition": "...", "outcome": "..."}}.',
    'The condition must use ONLY one of these shapes, with numbers copied exactly from the sentence:',
    '  "the <field> exceeds N" | "the <field> is at least N" | "the <field> is at most N" | "the <field> is less than N" | "the <field> equals N"',
    '  "the <days|hours|working days|months|years> since <event> is at most N"   (a deadline)',
    '  conditions may be joined with "and" / "or".',
    'The outcome is the required action, using words from the sentence. Do not invent numbers, fields or actions.',
    'If the sentence has an exception ("unless", "except"), decline.',
    `Sentence: ${JSON.stringify(sentence.text)}`,
  ].join('\n');
}

/** Tolerant parse of a model reply. Anything that is not the requested shape is "no proposal". */
export function parseProposalResponse(reply: string): RawRuleProposal | undefined {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const rule = (data as { rule?: unknown }).rule;
  if (rule === null || typeof rule !== 'object') return undefined;
  const { condition, outcome } = rule as { condition?: unknown; outcome?: unknown };
  return typeof condition === 'string' && typeof outcome === 'string' ? { condition, outcome } : undefined;
}

/** Wraps any text-completion function (a hosted model, a local model, a recorded replay) as a `RuleProposer`. */
export function modelProposer(complete: (prompt: string) => Promise<string>): RuleProposer {
  return async (sentence) => parseProposalResponse(await complete(buildProposalPrompt(sentence)));
}
