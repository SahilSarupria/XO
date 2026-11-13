/**
 * UW-3b — a capability name from ONE clause: the verb and its direct object, nothing past the clause boundary.
 *
 * The previous namer took the verb plus the next six words, whatever they were, so a name ran across commas, into the
 * next instruction and across table cells ("Run existing tests add new ones", "Check naming Diff is clean feedback
 * errors"). Here the object stops at the first clause boundary:
 *
 *   - punctuation that ends a clause: `;` `:` `(` `)` and a sentence-final mark;
 *   - a comma, unless what follows is another item of the same object list ("Check naming, errors, and docs") — a
 *     segment after the comma that opens with an action verb starts a new instruction ("Run existing tests, add ...");
 *   - "and"/"or"/"but"/"then" followed by an action verb (a second instruction);
 *   - a subordinator or relative word (if, when, which, that, because, ...);
 *   - an adjunct preposition (within, after, before, at, per, via, for, using, ...) once the object has at least one word.
 *     "Wait for approval" keeps its prepositional object; "Implement one subtask at a time" stops at "at".
 *
 * Two verbs joined by "and"/"or" right after the first one are one compound verb ("Merge or deploy"). Pure and
 * language-level; no subject-matter vocabulary.
 */
import { isActionVerb } from '../semantic/directive.js';
import { CONDITIONAL_ABBREVIATIONS, NON_TERMINAL_ABBREVIATIONS } from './sentence-split.js';

const SUBORDINATORS = new Set([
  'if',
  'when',
  'whenever',
  'where',
  'which',
  'who',
  'whom',
  'whose',
  'that',
  'unless',
  'because',
  'since',
  'so',
  'while',
  'whereas',
  'although',
  'though',
  'until',
  'once',
]);

const ADJUNCT_PREPOSITIONS = new Set([
  'within',
  'after',
  'before',
  'during',
  'at',
  'per',
  'via',
  'through',
  'using',
  'by',
  'for',
  'from',
  'as',
  'without',
  'including',
  'except',
  'like',
  'such',
  'e.g',
  'i.e',
  'etc',
  'based',
  'according',
]);

const COORDINATORS = new Set(['and', 'or', 'but', 'then', 'nor']);
const SUBJECT_DETERMINERS = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'each', 'every', 'any', 'all', 'such']);
const CLAUSE_MODALS = new Set(['shall', 'must', 'will', 'may', 'should', 'can', 'could', 'would', 'might', 'cannot']);

/** A word that starts a new instruction or clause: an action verb ("add new ones") or a modal ("and shall notify"). */
function opensClause(raw: string): boolean {
  const w = clean(raw);
  return isActionVerb(w) || CLAUSE_MODALS.has(w.toLowerCase());
}
/** Manner and example markers never name what is acted on, even for a verb without an object ("deploy per team process"). */
const ALWAYS_ADJUNCT = new Set([
  'per',
  'via',
  'using',
  'including',
  'except',
  'such',
  'e.g',
  'i.e',
  'etc',
  'based',
  'according',
  'like',
  'during',
  'having',
]);
const DEADLINE_PREPOSITIONS = new Set(['within', 'by', 'before', 'after']);
const TIME_UNITS = /^(?:minutes?|hours?|days?|business|working|calendar|weeks?|months?|years?|seconds?)$/i;

/** "within 30 days", "within 30 calendar days", "by 5 pm": the preposition, the quantity and its unit words. */
function deadlineAt(words: readonly string[], index: number): readonly string[] | undefined {
  const quantity = clean(words[index + 1] ?? '');
  if (!/^\d+(?:[.,]\d+)?$/.test(quantity) && !/^(?:one|two|three|four|five|six|seven|ten|fourteen|thirty|sixty|ninety)$/i.test(quantity))
    return undefined;
  const out = [clean(words[index]!), quantity];
  for (let k = index + 2; k < words.length && k <= index + 3; k += 1) {
    const w = clean(words[k]!);
    if (!TIME_UNITS.test(w)) break;
    out.push(w);
    if (/[,;:.]$/.test(words[k]!)) break;
  }
  return out.length > 2 ? out : undefined;
}
const MAX_OBJECT_WORDS = 6;

export interface ClauseName {
  /** "Merge or deploy", "Check naming, errors, and docs". */
  readonly name: string;
  readonly verbPhrase: string;
  readonly objectWords: readonly string[];
  /** The object stopped at a real clause boundary (true), or ran into the word limit / end of text (false). */
  readonly bounded: boolean;
  /** Share of the clause's words the name uses (1 = the whole clause). */
  readonly consumedShare: number;
  /** The words of the clause the name was taken from, as written. */
  readonly clause: string;
}

const PAIRS: readonly (readonly [string, string])[] = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
  ['“', '”'],
];

/** A name keeps a bracket or quote only when it also keeps its partner ("Request a decision]" -> "Request a decision"). */
function balanced(name: string): string {
  let out = name.trim();
  for (const [open, close] of PAIRS) {
    const opens = out.split(open).length - 1;
    const closes = out.split(close).length - 1;
    if (closes > opens) {
      const at = out.lastIndexOf(close);
      out = out.slice(0, at) + out.slice(at + 1);
    } else if (opens > closes) {
      const at = out.indexOf(open);
      out = out.slice(0, at) + out.slice(at + 1);
    }
  }
  if ((out.split('"').length - 1) % 2 === 1) out = out.replace(/^"|"$/, '');
  return out.replace(/\s+/g, ' ').trim();
}

function clean(word: string): string {
  let start = 0;
  let end = word.length;
  const isWordChar = (ch: string): boolean => /[\p{L}\p{N}'/-]/u.test(ch);
  while (start < end && !isWordChar(word[start]!)) start += 1;
  while (end > start && !isWordChar(word[end - 1]!)) end -= 1;
  const out = word.slice(start, end);
  // A token with no letter or digit ("/", "-", "->") is punctuation, not a word of the name.
  return /[\p{L}\p{N}]/u.test(out) ? out : '';
}

function isAbbreviation(raw: string): boolean {
  const core = raw
    .toLowerCase()
    .replace(/^[("'[{]+/, '')
    .replace(/\.$/, '');
  return core === 'vs' || NON_TERMINAL_ABBREVIATIONS.has(core) || CONDITIONAL_ABBREVIATIONS.has(core);
}

function endsClause(raw: string): boolean {
  if (/[;:()]$/.test(raw) || raw.startsWith('(')) return true;
  return /[.!?]["')\]]?$/.test(raw) && !isAbbreviation(raw);
}

function capitalize(word: string): string {
  return word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1);
}

const TRAILING_STOP = new Set([
  'a',
  'an',
  'the',
  'to',
  'of',
  'in',
  'on',
  'with',
  'and',
  'or',
  'is',
  'are',
  'there',
  'this',
  'that',
  'into',
  'against',
  'vs',
  'versus',
  'by',
  'for',
  'from',
  'at',
  'within',
  'after',
  'before',
  'than',
  'as',
  'per',
  'via',
]);

/**
 * Names the action that starts at `words[verbIndex]` (`verb` is its base form). `words` are the sentence's words as
 * written (punctuation attached). Returns the name with its object bounded to one clause.
 */
/**
 * `maxObjectWords` caps the object (6 by default: a capability found mid-prose is named briefly). A procedure step, which is
 * a whole instruction the author wrote as one item, allows more.
 */
export function nameFromClause(words: readonly string[], verbIndex: number, verb: string, maxObjectWords = MAX_OBJECT_WORDS): ClauseName {
  let verbPhrase = capitalize(verb);
  let i = verbIndex + 1;
  // A compound verb: "Merge or deploy", "Review and approve".
  if (
    !endsClause(words[verbIndex] ?? '') &&
    i + 1 < words.length &&
    COORDINATORS.has(clean(words[i]!).toLowerCase()) &&
    isActionVerb(clean(words[i + 1]!))
  ) {
    verbPhrase = `${verbPhrase} ${clean(words[i]!).toLowerCase()} ${clean(words[i + 1]!).toLowerCase()}`;
    i += 2;
  }
  const object: string[] = [];
  let bounded = endsClause(words[verbIndex] ?? '') || endsClause(words[i - 1] ?? '');
  let clauseEnd = i;
  if (!bounded) {
    for (; i < words.length; i += 1) {
      const raw = words[i]!;
      const lower = clean(raw).toLowerCase();
      if (raw.startsWith('(')) {
        bounded = true;
        break;
      }
      if (SUBORDINATORS.has(lower) && object.length > 0) {
        bounded = true;
        break;
      }
      if (ALWAYS_ADJUNCT.has(lower) || (ADJUNCT_PREPOSITIONS.has(lower) && object.length > 0)) {
        // A stated deadline belongs to the action ("Contact the claims department within 30 days"): "within / by /
        // before / after" followed by a quantity is kept, up to its unit, and then the clause ends.
        const deadline = DEADLINE_PREPOSITIONS.has(lower) ? deadlineAt(words, i) : undefined;
        if (deadline !== undefined) {
          object.push(...deadline);
          i += deadline.length;
        }
        bounded = true;
        break;
      }
      if (COORDINATORS.has(lower) && i + 1 < words.length && opensClause(words[i + 1]!)) {
        bounded = true;
        break;
      }
      const word = clean(raw);
      if (word.length > 0) object.push(word);
      if (object.length >= maxObjectWords) {
        i += 1;
        break;
      }
      if (/,$/.test(raw)) {
        // Another item of the same list, or a new instruction?
        const next = clean(words[i + 1] ?? '');
        const afterCoord = COORDINATORS.has(next.toLowerCase()) ? clean(words[i + 2] ?? '') : next;
        if (next.length === 0 || opensClause(afterCoord) || SUBORDINATORS.has(next.toLowerCase())) {
          bounded = true;
          i += 1;
          break;
        }
        object[object.length - 1] = `${word},`;
      }
      if (endsClause(raw)) {
        bounded = true;
        i += 1;
        break;
      }
    }
  }
  clauseEnd = i;
  while (object.length > 0 && TRAILING_STOP.has(object[object.length - 1]!.replace(/,$/, '').toLowerCase())) object.pop();
  if (object.length > 0) object[object.length - 1] = object[object.length - 1]!.replace(/,$/, '');
  const clauseWords = words.slice(verbIndex, Math.max(clauseEnd, verbIndex + 1));
  const name = balanced(object.length > 0 ? `${verbPhrase} ${object.join(' ')}` : verbPhrase);
  const nameWordCount = name.split(/\s+/).length;
  return {
    name,
    verbPhrase,
    objectWords: object,
    bounded,
    consumedShare: Math.min(1, Math.round((nameWordCount / Math.max(1, clauseWords.length)) * 100) / 100),
    clause: clauseWords.join(' '),
  };
}

const PASSIVE_AUX = new Set(['is', 'are', 'was', 'were', 'being', 'be', 'been']);
const MODALS = new Set(['shall', 'must', 'will', 'may', 'should', 'can', 'could', 'would', 'might']);
const ARGUMENT_PREPOSITIONS = new Set(['in', 'into', 'on', 'onto', 'to', 'against', 'with']);
const MAX_SUBJECT_WORDS = 5;
const MAX_PASSIVE_PP_WORDS = 4;

/**
 * UW-3b: a passive clause names what is acted on BEFORE the verb: "Sales invoices are created in Tally Prime" is
 * "Create Sales invoices in Tally Prime", "the settlement amount must be recorded before payment" is "Record the
 * settlement amount". The subject is the words between the clause's start (sentence start, `,` `;` `:` or a
 * subordinator) and the auxiliary; an argument phrase right after the participle ("in Tally Prime") is kept, an adjunct
 * ("before payment", "via direct sales") is not. Undefined when no subject can be found; the caller then names the
 * clause the active way.
 */
export function nameFromPassive(words: readonly string[], participleIndex: number, verb: string): ClauseName | undefined {
  let auxIndex = participleIndex - 1;
  while (
    auxIndex >= 0 &&
    (PASSIVE_AUX.has(clean(words[auxIndex]!).toLowerCase()) ||
      MODALS.has(clean(words[auxIndex]!).toLowerCase()) ||
      clean(words[auxIndex]!).toLowerCase() === 'not')
  )
    auxIndex -= 1;
  const subjectEnd = auxIndex + 1;
  const subject: string[] = [];
  for (let k = auxIndex; k >= 0; k -= 1) {
    const raw = words[k]!;
    if (/[,;:]$/.test(raw) || endsClause(raw)) break;
    const lower = clean(raw).toLowerCase();
    if (SUBORDINATORS.has(lower) || COORDINATORS.has(lower) || /^\d+(?:\.\d+)*[.)]?$/.test(raw)) break;
    const w = clean(raw);
    if (w.length > 0) subject.unshift(w);
    if (subject.length > MAX_SUBJECT_WORDS) return undefined; // a long subject is a whole clause, not a thing acted on
  }
  if (subject.length === 0 || subjectEnd > participleIndex) return undefined;
  const pp: string[] = [];
  let bounded = endsClause(words[participleIndex] ?? '') || /,$/.test(words[participleIndex] ?? '');
  const next = clean(words[participleIndex + 1] ?? '').toLowerCase();
  if (!bounded && ARGUMENT_PREPOSITIONS.has(next)) {
    for (let k = participleIndex + 1; k < words.length && pp.length < MAX_PASSIVE_PP_WORDS; k += 1) {
      const raw = words[k]!;
      const lower = clean(raw).toLowerCase();
      if (raw.startsWith('(') || ((SUBORDINATORS.has(lower) || ADJUNCT_PREPOSITIONS.has(lower)) && pp.length > 0)) {
        bounded = true;
        break;
      }
      pp.push(clean(raw));
      if (/[,;:]$/.test(raw) || endsClause(raw)) {
        bounded = true;
        break;
      }
    }
  } else {
    bounded = true;
  }
  while (pp.length > 0 && TRAILING_STOP.has(pp[pp.length - 1]!.toLowerCase())) pp.pop();
  // A sentence-initial determiner moves behind the verb, so it loses its sentence capital ("The meaning ... is
  // determined" -> "Determine the meaning ..."). Content words keep their case: they may be defined terms.
  if (SUBJECT_DETERMINERS.has(subject[0]!.toLowerCase())) subject[0] = subject[0]!.toLowerCase();
  const objectWords = [...subject, ...pp];
  const name = balanced(`${capitalize(verb)} ${objectWords.join(' ')}`);
  const clauseWords = words.slice(subjectEnd - subject.length, participleIndex + 1 + pp.length);
  return {
    name,
    verbPhrase: capitalize(verb),
    objectWords,
    bounded,
    consumedShare: Math.min(1, Math.round((name.split(/\s+/).length / Math.max(1, clauseWords.length)) * 100) / 100),
    clause: clauseWords.join(' '),
  };
}
