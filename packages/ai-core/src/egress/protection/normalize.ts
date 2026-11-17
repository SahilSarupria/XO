/**
 * UW-14c — the one text form detectors match in, with a map back to the original text so a hit can be masked where it stands.
 *
 * Per code point: NFKC (full-width digits and letters, ligatures), Unicode look-alikes mapped to the Latin letter they imitate
 * (Cyrillic `а`, Greek `ο`, …), diacritics removed (`é` → `e`), lower case; format characters (zero-width joiners and spaces, soft
 * hyphens, bidirectional marks) dropped. Each normalised character keeps the index of the original code point it came from.
 */

/** Cyrillic and Greek letters drawn like Latin ones (the confusables that matter for names and identifiers). */
const LOOKALIKES: Readonly<Record<string, string>> = {
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  і: 'i',
  ї: 'i',
  ј: 'j',
  ѕ: 's',
  ԁ: 'd',
  ԛ: 'q',
  ԝ: 'w',
  һ: 'h',
  А: 'a',
  В: 'b',
  Е: 'e',
  К: 'k',
  М: 'm',
  Н: 'h',
  О: 'o',
  Р: 'p',
  С: 'c',
  Т: 't',
  У: 'y',
  Х: 'x',
  І: 'i',
  Ј: 'j',
  Ѕ: 's',
  α: 'a',
  β: 'b',
  ε: 'e',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  Α: 'a',
  Β: 'b',
  Ε: 'e',
  Ζ: 'z',
  Η: 'h',
  Ι: 'i',
  Κ: 'k',
  Μ: 'm',
  Ν: 'n',
  Ο: 'o',
  Ρ: 'p',
  Τ: 't',
  Υ: 'y',
  Χ: 'x',
  ı: 'i',
  ℓ: 'l',
  '０': '0',
};

export interface NormalizedText {
  /** The normalised text. */
  readonly text: string;
  /** `origin[i]` is the index in the original string of the code point normalised character `i` came from. */
  readonly origin: readonly number[];
  /** `originEnd[i]` is where that code point ends in the original string. */
  readonly originEnd: readonly number[];
  /** Length of the original string (end of the last code point). */
  readonly originalLength: number;
}

const FORMAT = /\p{Cf}/u;
const MARK = /\p{M}/gu;

export function normalizeForMatch(input: string): NormalizedText {
  let text = '';
  const origin: number[] = [];
  const originEnd: number[] = [];
  let i = 0;
  for (const cp of input) {
    const at = i;
    i += cp.length;
    if (FORMAT.test(cp)) continue;
    const look = LOOKALIKES[cp];
    const piece = (look ?? cp.normalize('NFKC')).normalize('NFD').replace(MARK, '').toLowerCase();
    for (const ch of piece) {
      const mapped = LOOKALIKES[ch] ?? ch;
      text += mapped;
      for (let k = 0; k < mapped.length; k++) {
        origin.push(at);
        originEnd.push(i);
      }
    }
  }
  return { text, origin, originEnd, originalLength: input.length };
}

/** The original range a normalised range covers (whole code points). */
export function originalRange(n: NormalizedText, start: number, end: number): { readonly start: number; readonly end: number } {
  if (end <= start) return { start: n.origin[start] ?? n.originalLength, end: n.origin[start] ?? n.originalLength };
  return { start: n.origin[start]!, end: n.originEnd[end - 1]! };
}

export interface Token {
  readonly text: string;
  /** Range in the NORMALISED text. */
  readonly start: number;
  readonly end: number;
}

/**
 * Words of a normalised text: runs of letters or digits. A boundary also falls where a lower-case letter is followed by an upper-case
 * one in the ORIGINAL (`RaviKumar` → `ravi`, `kumar`), so names glued together in file names are still words.
 */
export function tokens(n: NormalizedText, original: string): Token[] {
  const out: Token[] = [];
  const re = /[\p{L}\p{N}]+/gu;
  for (const m of n.text.matchAll(re)) {
    let start = m.index;
    const end = m.index + m[0].length;
    for (let k = start + 1; k < end; k++) {
      const prev = original[n.origin[k - 1]!] ?? '';
      const cur = original[n.origin[k]!] ?? '';
      const camel = /\p{Ll}/u.test(prev) && /\p{Lu}/u.test(cur);
      const letterDigit = /\p{L}/u.test(n.text[k - 1]!) !== /\p{L}/u.test(n.text[k]!);
      if (camel || letterDigit) {
        out.push({ text: n.text.slice(start, k), start, end: k });
        start = k;
      }
    }
    out.push({ text: n.text.slice(start, end), start, end });
  }
  return out;
}

/** Letters and digits only (`ABCDE-1234 F` → `abcde1234f`), with the normalised index of each kept character. */
export function compact(n: NormalizedText): { readonly text: string; readonly at: readonly number[] } {
  let text = '';
  const at: number[] = [];
  for (let i = 0; i < n.text.length; i++) {
    const ch = n.text[i]!;
    if (/[\p{L}\p{N}]/u.test(ch)) {
      text += ch;
      at.push(i);
    }
  }
  return { text, at };
}

/** Damerau–Levenshtein distance, stopping early above `max`. */
export function editDistanceAtMost(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i < rows; i++) {
    let rowMin = Infinity;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return false;
  }
  return d[a.length]![b.length]! <= max;
}

/**
 * A spelling key for Indian names written in the Latin script, where one name has several common romanisations: Lakshmi and Laxmi,
 * Shrivastava and Srivastav, Chaudhary and Choudhari, Vijay and Wijay. Applied to whole words of 4+ letters (normalised text) and
 * compared exactly, alongside the one-edit match. It merges spellings, so it is used only for names and organisations, never ids.
 */
export function phoneticKey(word: string): string {
  let w = word;
  w = w.replace(/ksh|x/g, 'ks');
  w = w.replace(/([bcdgjkpt])h/g, '$1'); // aspirates: bh → b, dh → d, th → t, ch → c
  w = w.replace(/sh/g, 's');
  w = w.replace(/ph/g, 'f');
  w = w.replace(/w/g, 'v');
  w = w.replace(/z/g, 'j');
  w = w.replace(/q/g, 'k');
  w = w.replace(/ee|ii|y$/g, 'i');
  w = w.replace(/oo|uu/g, 'u');
  w = w.replace(/ou|au/g, 'o');
  w = w.replace(/(.)\1+/g, '$1'); // doubled letters
  w = w.replace(/(?<=.)[aeiou]+$/, ''); // a final vowel (Srivastava / Srivastav)
  w = w.replace(/(?<=.)[aeiou]+(?=.)/g, (v) => v[0]!); // a vowel run inside: first vowel only
  return w;
}
