/**
 * Negation scope for capability extraction.
 *
 * "Do not create a missing receipt" and "Never promise what the insurer has not confirmed" are PROHIBITIONS. Reading the
 * verb inside them as a capability ("Create a missing receipt") inverts the document, which is a safety defect, not a
 * quality one: a workflow could be composed that does exactly what the document forbids. This module decides whether
 * a verb sits inside a negated clause and extracts the prohibition itself so it can be kept as a safety constraint.
 *
 * Scope rule: a negator opens a negated clause that runs to the next clause break (comma, semicolon, colon, full stop,
 * or "but / instead / however / otherwise / rather"). "and" and "or" do NOT end it ("do not create or edit receipts").
 */

const NEGATORS = new Set([
  'not',
  'never',
  'cannot',
  'dont',
  'doesnt',
  'didnt',
  'cant',
  'wont',
  'mustnt',
  'shouldnt',
  'shant',
  'neednt',
  'avoid',
  'refrain',
  'without',
  'prohibited',
  'forbidden',
  'no',
]);
const BREAKERS = new Set(['but', 'instead', 'however', 'otherwise', 'rather', 'except']);

const norm = (w: string): string =>
  w
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]/g, '');
const endsClause = (raw: string): boolean => /[,;:.!?)]$/.test(raw);

/** true when the word at `index` is inside a clause opened by a negator earlier in the same sentence */
export function isNegatedAt(words: readonly string[], index: number): boolean {
  let negated = false;
  for (let i = 0; i <= index && i < words.length; i++) {
    const raw = words[i]!;
    const w = norm(raw);
    if (BREAKERS.has(w)) negated = false;
    if (i === index) return negated;
    if (NEGATORS.has(w)) negated = true;
    // contractions the splitter keeps whole: "don't", "can't"
    else if (/n['’]t$/i.test(raw)) negated = true;
    if (endsClause(raw)) negated = false;
  }
  return negated;
}

/** is the capability named `name` (verb first) described by a sentence that forbids it? */
export function candidateIsNegated(description: string, name: string): boolean {
  const verb = norm(name.split(/\s+/)[0] ?? '');
  if (verb.length < 3) return false;
  const stem = verb.slice(0, Math.max(3, verb.length - 2));
  const words = description.split(/\s+/).filter((w) => w.length > 0);
  const i = words.findIndex((w) => norm(w).startsWith(stem));
  return i >= 0 && isNegatedAt(words, i);
}

export interface ExtractedProhibition {
  /** the sentence that forbids it, verbatim */
  readonly sentence: string;
  /** what is forbidden, as written ("create a missing receipt") */
  readonly predicate: string;
}

const PROHIBITION =
  /\b(?:do not|don['’]t|does not|doesn['’]t|never|must not|mustn['’]t|may not|shall not|should not|shouldn['’]t|cannot|can['’]t|is not allowed to|are not allowed to|not allowed to|is not permitted to|are not permitted to|not permitted to|is prohibited from|are prohibited from|is forbidden to|are forbidden to|avoid|refrain from)\s+([^.;]+)/i;

/** prohibitions stated in `sentences`, in order */
export function extractProhibitions(sentences: readonly string[]): ExtractedProhibition[] {
  const out: ExtractedProhibition[] = [];
  for (const s of sentences) {
    const m = PROHIBITION.exec(s);
    if (m !== null) out.push({ sentence: s, predicate: m[1]!.trim().replace(/[,\s]+$/, '') });
  }
  return out;
}
