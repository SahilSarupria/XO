/**
 * UW-3b — is this sentence an instruction, and which kind?
 *
 * Language-level only: the mood and the deontic words of English, never subject-matter vocabulary. An instruction is a
 * sentence that opens with a base-form verb ("Run the tests."), a negative imperative ("Never commit secrets.", "Do not
 * mix changes.", "Avoid dead code."), "Always ...", or that carries a modal ("Reviewers must ...", "You should ...").
 *
 * The verb list is a general-purpose list of English action verbs (plus the capability lexicon's), not a domain list. A
 * verb it does not know simply makes the sentence "not recognised as an instruction" — the conservative direction: the
 * sentence then goes to the ordinary extractors exactly as before.
 */
import { CAPABILITY_VERBS } from '../capabilities/capability-lexicon.js';

const GENERAL_ACTION_VERBS = `
  accept add adjust agree align allocate announce answer apply approve archive arrange ask assign attach attend audit
  avoid back backup book break bring build calculate call cancel capture change charge check choose clarify classify
  clean clear close collect combine comment commit communicate compare compile complete compute configure confirm
  connect consider contact continue copy correct create cut debug decide define delegate delete deliver deploy
  describe design determine develop discuss document download draft drop edit eliminate email enable encrypt enter
  ensure escalate estimate evaluate examine exclude execute explain export fetch file fill finalize find fix flag
  follow forward gather generate get give go grant handle hold identify implement import improve include inform
  install inspect integrate investigate invite issue keep label launch leave limit link list load lock log look maintain
  make mark measure meet merge migrate mix monitor move name note notify obtain open order organize pass pause pay
  perform pick place plan post prepare present prevent print prioritize process produce protect provide publish pull
  push put raise read rebase receive record reduce refactor refer refresh register reject release remove rename repeat
  replace reply report reproduce request require reserve reset resolve respond restart restore retest retry return
  review revise rotate route run save scan schedule search secure select send separate set setup share sign skip sort
  specify split start state stop store submit summarize supply support switch take talk test timebox track train
  transfer translate try turn understand unlock update upgrade upload use validate verify wait walk wash watch work
  write
`
  .split(/\s+/)
  .filter((w) => w.length > 0);

const ACTION_VERBS: ReadonlySet<string> = new Set([...GENERAL_ACTION_VERBS, ...Object.keys(CAPABILITY_VERBS)]);

/** First word, lower-cased, with a leading "re-"/"pre-" prefix allowed ("Re-read", "Pre-fill"). */
function leadWord(text: string): string {
  const first = text.trim().split(/\s+/)[0] ?? '';
  return first.replace(/[^\p{L}'-]/gu, '').toLowerCase();
}

export function isActionVerb(word: string): boolean {
  const w = word.toLowerCase();
  if (ACTION_VERBS.has(w)) return true;
  const m = /^(?:re|pre|un|co)-?(\p{L}+)$/u.exec(w);
  return m !== null && ACTION_VERBS.has(m[1]!);
}

/** A sentence that opens with a base-form action verb ("Read the task.", "Re-read your diff."). */
export function isImperative(sentence: string): boolean {
  const text = sentence.trim().replace(/^(?:please|then|next|finally|first|now)[,]?\s+/i, '');
  return isActionVerb(leadWord(text));
}

const NEGATIVE_LEAD = /^(?:never|do\s+not|don['’]t|avoid|no\s+\p{L})/iu;
const ALWAYS_LEAD = /^always\s+/i;
const PROHIBITION_MODAL = /\b(?:must\s+not|shall\s+not|may\s+not|cannot|can\s*not|must\s+never|should\s+not|should\s+never)\b/i;
const OBLIGATION_MODAL = /\b(?:must|shall|(?:is|are)\s+required\s+to|(?:need|needs|has|have)\s+to)\b/i;
const ADVISORY_MODAL = /\b(?:should|ought\s+to|(?:is|are)\s+(?:recommended|encouraged))\b/i;

export interface Directive {
  readonly modality: 'obligation' | 'prohibition' | 'advisory';
  readonly polarity: 'positive' | 'negative';
}

/**
 * The directive a sentence states, or undefined when it states none. Negative imperatives are prohibitions; positive
 * imperatives and "must" are obligations; "should" is advisory. A conditional opening ("If the requirement is unclear,
 * ask ...") is still read from its main clause, after the comma.
 */
export function directiveOf(sentence: string): Directive | undefined {
  let text = sentence.trim();
  const conditional = /^(?:if|when|whenever|before|after|once|unless|until|while)\b[^,]{1,120},\s*(.+)$/i.exec(text);
  if (conditional !== null) text = conditional[1]!;
  if (NEGATIVE_LEAD.test(text)) return { modality: 'prohibition', polarity: 'negative' };
  if (PROHIBITION_MODAL.test(text)) return { modality: 'prohibition', polarity: 'negative' };
  if (ALWAYS_LEAD.test(text)) return { modality: 'obligation', polarity: 'positive' };
  if (isImperative(text)) return { modality: 'obligation', polarity: 'positive' };
  if (OBLIGATION_MODAL.test(text)) return { modality: 'obligation', polarity: 'positive' };
  if (ADVISORY_MODAL.test(text)) return { modality: 'advisory', polarity: 'positive' };
  return undefined;
}
