/**
 * UW-12a — which person a file is about, from its name: "Asha_Rao_certificate.pdf", "asharao.pdf", "A. Rao.pdf", "Venky Iyengar.pdf",
 * "Laxmi Shrivastav.pdf".
 *
 * Matching runs in tiers, strongest first, and a file is decided at the first tier where anyone matches: exactly one person is a
 * match of that kind, more than one is ambiguous (never a guess). So "Asha Rao" written out in full is never overridden by an
 * initials match for someone else.
 *
 *   full      every word of the name is a word of the path
 *   joined    the name written as one word (`asharao`, `raoasha`)
 *   spelling  every word matches by a spelling key for Indian romanisations (Lakshmi/Laxmi, Chaudhary/Choudhari), or by one typing
 *             error in a word of five letters or more
 *   nickname  the surname, and a common short form of the first name (`Venky` for Venkatesh, `Bob` for Robert) or its first four
 *             letters or more (`Venkat`, `Srini`)
 *   initials  the surname and the first name's initial (`A Rao`, `Rao A`, `arao`)
 *
 * A one-word name matches only in the first three tiers. Matches below `joined` are reported as needing a look.
 */

export type NameMatchKind = 'full' | 'joined' | 'spelling' | 'nickname' | 'initials';
export const NAME_MATCH_TIERS: readonly NameMatchKind[] = ['full', 'joined', 'spelling', 'nickname', 'initials'];

/** Words of a name or path: accents removed, camelCase and letter/digit boundaries split, lower case. */
export function nameWords(s: string): string[] {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{L})(\p{N})|(\p{N})(\p{L})/gu, '$1$3 $2$4')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

/** Common short forms, both Indian and English: first name → nicknames. */
const NICKNAMES: Readonly<Record<string, readonly string[]>> = {
  abhishek: ['abhi'],
  aditya: ['adi'],
  alexander: ['alex', 'sasha'],
  andrew: ['andy', 'drew'],
  anthony: ['tony'],
  benjamin: ['ben'],
  catherine: ['kate', 'cathy', 'katie'],
  katherine: ['kate', 'kathy', 'katie'],
  christopher: ['chris'],
  daniel: ['dan', 'danny'],
  david: ['dave'],
  elizabeth: ['liz', 'beth', 'lizzie', 'betty'],
  gurpreet: ['guri'],
  harpreet: ['harry'],
  jennifer: ['jen', 'jenny'],
  jonathan: ['jon'],
  joseph: ['joe'],
  krishnamurthy: ['krishna'],
  margaret: ['maggie', 'meg', 'peggy'],
  matthew: ['matt'],
  michael: ['mike', 'mick'],
  mohammed: ['mohd', 'md'],
  mohammad: ['mohd', 'md'],
  muhammad: ['mohd', 'md'],
  nicholas: ['nick'],
  rajendra: ['raju'],
  rajesh: ['raju'],
  ramesh: ['ramu'],
  richard: ['rick', 'rich', 'dick'],
  robert: ['rob', 'bob', 'bobby'],
  samuel: ['sam'],
  sanjay: ['sanju'],
  srinivas: ['srini', 'cheenu'],
  srinivasan: ['srini', 'cheenu'],
  subramanian: ['subbu', 'mani'],
  subramaniam: ['subbu', 'mani'],
  suresh: ['suri'],
  thomas: ['tom', 'tommy'],
  venkatesh: ['venky', 'venkat'],
  venkataraman: ['venky', 'venkat'],
  vijay: ['viju'],
  vikram: ['vicky', 'vikki'],
  william: ['will', 'bill', 'billy'],
  zachary: ['zach'],
};

/**
 * A spelling key for Latin-script Indian names (the same rules as `@xo/ai-core`'s `phoneticKey`, kept here so `@xo/connect` does not
 * depend on the model layer): ksh/x, aspirates, sh/s, ph/f, w/v, z/j, q/k, long vowels, doubled letters, a final vowel, vowel runs.
 */
export function spellingKey(word: string): string {
  let w = word;
  w = w.replace(/ksh|x/g, 'ks');
  w = w.replace(/([bcdgjkpt])h/g, '$1');
  w = w.replace(/sh/g, 's');
  w = w.replace(/ph/g, 'f');
  w = w.replace(/w/g, 'v');
  w = w.replace(/z/g, 'j');
  w = w.replace(/q/g, 'k');
  w = w.replace(/ee|ii|y$/g, 'i');
  w = w.replace(/oo|uu/g, 'u');
  w = w.replace(/ou|au/g, 'o');
  w = w.replace(/(.)\1+/g, '$1');
  w = w.replace(/(?<=.)[aeiou]+$/, '');
  w = w.replace(/(?<=.)[aeiou]+(?=.)/g, (v) => v[0]!);
  return w;
}

/** At most one insertion, deletion, substitution or adjacent swap. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diff: number[] = [];
    for (let i = 0; i < a.length && diff.length <= 2; i++) if (a[i] !== b[i]) diff.push(i);
    if (diff.length === 1) return true;
    return diff.length === 2 && diff[1] === diff[0]! + 1 && a[diff[0]!] === b[diff[1]!] && a[diff[1]!] === b[diff[0]!];
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < s.length && s[i] === l[i]) i++;
  return s.slice(i) === l.slice(i + 1);
}

/** Honorifics and the like, which are not part of matching a name. */
const SKIP = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'shri', 'sri', 'smt', 'kumari', 'km', 'mx', 'prof']);

export interface PersonName {
  readonly index: number;
  readonly words: readonly string[];
}

export function personName(index: number, value: string): PersonName | undefined {
  const words = nameWords(value).filter((w) => !SKIP.has(w) && /\p{L}/u.test(w));
  return words.length === 0 ? undefined : { index, words };
}

function matchesAt(kind: NameMatchKind, p: PersonName, have: ReadonlySet<string>, haveList: readonly string[]): boolean {
  const w = p.words;
  const first = w[0]!;
  const last = w[w.length - 1]!;
  switch (kind) {
    case 'full':
      return w.every((x) => have.has(x));
    case 'joined': {
      if (w.length < 2) return false;
      const forms = [w.join(''), [last, ...w.slice(0, -1)].join(''), `${first}${last}`, `${last}${first}`];
      return forms.some((f) => f.length >= 6 && have.has(f));
    }
    case 'spelling':
      return w.every(
        (x) =>
          x.length >= 4 &&
          haveList.some(
            (h) => h.length >= 4 && (spellingKey(h) === spellingKey(x) || (x.length >= 5 && h.length >= 5 && withinOneEdit(h, x))),
          ),
      );
    case 'nickname': {
      if (w.length < 2 || !have.has(last)) return false;
      const nicks = NICKNAMES[first] ?? [];
      return haveList.some(
        (h) =>
          h !== last &&
          (nicks.includes(h) || (h.length >= 4 && h.length < first.length && h.length * 2 >= first.length && first.startsWith(h))),
      );
    }
    case 'initials': {
      if (w.length < 2) return false;
      const initial = first[0]!;
      if (have.has(`${initial}${last}`) || have.has(`${last}${initial}`)) return true;
      if (!have.has(last)) return false;
      const i = haveList.indexOf(last);
      // The initial must stand next to the surname ("A Rao", "Rao A"), not anywhere in the path.
      return haveList[i - 1] === initial || haveList[i + 1] === initial;
    }
  }
}

export type DocumentMatch =
  | { readonly outcome: 'matched'; readonly person: number; readonly kind: NameMatchKind }
  | { readonly outcome: 'ambiguous'; readonly people: readonly number[]; readonly kind: NameMatchKind }
  | { readonly outcome: 'none' };

/** Which person a path names (see the tiers above). `path` is matched without its extension. */
export function matchPath(path: string, people: readonly PersonName[]): DocumentMatch {
  const dot = path.lastIndexOf('.');
  const haveList = nameWords(dot > path.lastIndexOf('/') ? path.slice(0, dot) : path);
  const have = new Set(haveList);
  for (const kind of NAME_MATCH_TIERS) {
    const hits = people.filter((p) => matchesAt(kind, p, have, haveList));
    if (hits.length === 1) return { outcome: 'matched', person: hits[0]!.index, kind };
    if (hits.length > 1) {
      // The same person listed twice is still one person.
      const distinct = [...new Set(hits.map((h) => h.words.join(' ')))];
      if (distinct.length === 1) return { outcome: 'matched', person: hits[0]!.index, kind };
      return { outcome: 'ambiguous', people: hits.map((h) => h.index), kind };
    }
  }
  return { outcome: 'none' };
}

/**
 * UW-5: does `person` match the text at exactly this tier? The resolver needs the per-tier test for a (person, text) pair, where
 * `matchPath` answers "which person does this one path name".
 */
export function matchesTier(kind: NameMatchKind, person: PersonName, text: string): boolean {
  const dot = text.lastIndexOf('.');
  const haveList = nameWords(dot > text.lastIndexOf('/') ? text.slice(0, dot) : text);
  return matchesAt(kind, person, new Set(haveList), haveList);
}
