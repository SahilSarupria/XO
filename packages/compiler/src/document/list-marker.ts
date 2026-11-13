export interface DetectedListMarker {
  readonly marker: string;
  readonly remainder: string;
  /**
   * `'unordered'` for a bullet-glyph marker (no author-claimed sequence
   * between sibling items — enumeration, alternatives, or parallel
   * items); `'ordered'` for a digit or lettered marker (`"1."`, `"a)"`),
   * which the author positioned in an explicit, claimed sequence.
   * P0.9A area E (Specification Recovery) — added so `custom:sequence`
   * edges (`capabilities/relationship-builder.ts`) can stop being
   * asserted between consecutive *bulleted* siblings, where the source
   * never claimed an order in the first place (see that file's own doc
   * comment for the real Aastha.pdf case this was found against: a
   * bullet list of parallel system descriptions, not sequential steps).
   */
  readonly listKind: 'ordered' | 'unordered';
  /** UW-3b: present only for a checkbox marker (`[ ]`, `[x]`, `☐`, `☑`). The item is a checklist entry; its state is the author's. */
  readonly checkbox?: 'unchecked' | 'checked';
}

/** Checkbox glyphs and their bracket spellings. A checkbox is a list marker whose meaning is "a condition to tick off", not a sequence. */
const UNCHECKED_BOXES = ['[ ]', '[]', '☐', '□'];
const CHECKED_BOXES = ['[x]', '[X]', '[✓]', '[✔]', '☑', '☒'];

/** A leading checkbox (`[ ] Branch created`, `☑ Reviewed`), followed by whitespace or the end of the text. */
export function detectCheckbox(
  text: string,
): { readonly token: string; readonly state: 'unchecked' | 'checked'; readonly remainder: string } | undefined {
  const trimmed = text.trimStart();
  for (const [tokens, state] of [
    [UNCHECKED_BOXES, 'unchecked'],
    [CHECKED_BOXES, 'checked'],
  ] as const) {
    for (const token of tokens) {
      if (!trimmed.startsWith(token)) continue;
      const next = trimmed[token.length];
      if (next === undefined || next === ' ' || next === '\t') return { token, state, remainder: trimmed.slice(token.length).trimStart() };
    }
  }
  return undefined;
}

const ROMAN_ORDINALS: Readonly<Record<string, number>> = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
  xi: 11,
  xii: 12,
};

/**
 * UW-3b: a marker printed in a column of its own — `1`, `2.`, `a)`, `iv.`, `•`, `[ ]` — with the item text in the next
 * column. A bare number is only a marker with that layout evidence (and a sequence of them, see block-classifier.ts):
 * "123 Main Street" as one run of text stays prose.
 */
export function detectStandaloneMarker(token: string):
  | {
      readonly marker: string;
      readonly listKind: 'ordered' | 'unordered';
      readonly ordinal?: number;
      readonly checkbox?: 'unchecked' | 'checked';
    }
  | undefined {
  const t = token.trim();
  if (t.length === 0 || t.length > 6) return undefined;
  const box = detectCheckbox(t);
  if (box !== undefined && box.remainder.length === 0) return { marker: box.token, listKind: 'unordered', checkbox: box.state };
  if (t.length === 1 && BULLET_CHARS.includes(t)) return { marker: t, listKind: 'unordered' };
  // A bare number needs no punctuation ("1  One task"); a letter or roman numeral does ("a)", "iv."), because a lone
  // letter in a run of its own is just as often a glyph a generator positioned separately.
  const m = /^(?:\d{1,3}[.)]?|[a-zA-Z][.)]|[ivxIVX]{1,4}[.)])$/.exec(t);
  if (m === null) return undefined;
  const ordinal = markerOrdinal(t);
  if (ordinal === undefined) return undefined;
  return { marker: t, listKind: 'ordered', ordinal };
}

/** The position a marker claims: `3.` → 3, `c)` → 3, `iv.` → 4. Undefined for bullets, checkboxes and anything else. */
export function markerOrdinal(marker: string): number | undefined {
  const core = marker.trim().replace(/[.)]$/, '');
  if (/^\d{1,3}$/.test(core)) return Number(core);
  const lower = core.toLowerCase();
  if (ROMAN_ORDINALS[lower] !== undefined && lower.length > 1) return ROMAN_ORDINALS[lower];
  if (/^[a-z]$/.test(lower)) return lower.charCodeAt(0) - 96;
  return undefined;
}

/**
 * UW-3b: an item written as a short title followed by its explanation ("Never commit secrets. API keys stay in
 * environment variables."). Returns the split when the first sentence is short (at most `maxTitleWords` words) and
 * something follows it; otherwise undefined. Text only — layout evidence (a bold title run) is used by the PDF path
 * before falling back to this.
 */
export function splitTitleBody(text: string, maxTitleWords = 6): { readonly title: string; readonly body: string } | undefined {
  const trimmed = text.trim();
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if ((ch === '.' || ch === ':' || ch === '!' || ch === '?') && (trimmed[i + 1] === ' ' || trimmed[i + 1] === undefined)) {
      const title = trimmed.slice(0, i).trim();
      const body = trimmed.slice(i + 1).trim();
      const words = title.split(/\s+/).filter((w) => w.length > 0);
      if (words.length === 0 || words.length > maxTitleWords || body.length === 0) return undefined;
      return { title: ch === '?' || ch === '!' ? `${title}${ch}` : title, body };
    }
  }
  return undefined;
}

const BULLET_CHARS = ['•', '◦', '‣', '·', '-', '*', '○'];

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}
function isAsciiLetter(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

/**
 * Detects a leading list marker via plain character inspection — no
 * regex, per this compiler's extraction-technique constraint (this is
 * structural layout parsing, the same category as font-size heading
 * detection, not semantic content extraction, but written without regex
 * anyway to keep every module in this package unambiguous on that
 * point). Recognizes a bullet character, a run of digits, or a single
 * letter, each followed by `.` or `)` and then whitespace. Roman-numeral
 * markers ("i.", "iv)") are not recognized — see this package's README.
 * `○` (U+25CB WHITE CIRCLE) is included alongside `◦` (U+25E6 WHITE
 * BULLET) — a real production fixture (the Aastha operations document)
 * uses the former for its procedural sub-step bullets; without it, every
 * bulleted sub-step in a multi-step list merged into one paragraph block
 * instead of remaining a separate list_item per step (Semantic Richness
 * Investigation, Finding B). Still a fixed allowlist, not a Unicode-
 * category heuristic — see this package's README for why that stays a
 * deliberate choice for now.
 */
export function detectListMarker(text: string): DetectedListMarker | undefined {
  const trimmed = text.trimStart();
  if (trimmed.length === 0) return undefined;

  const box = detectCheckbox(trimmed);
  if (box !== undefined) return { marker: box.token, remainder: box.remainder, listKind: 'unordered', checkbox: box.state };

  const first = trimmed[0]!;
  if (BULLET_CHARS.includes(first) && (trimmed[1] === ' ' || trimmed[1] === undefined)) {
    return { marker: first, remainder: trimmed.slice(1).trimStart(), listKind: 'unordered' };
  }

  let i = 0;
  if (isDigit(trimmed[i]!)) {
    while (i < trimmed.length && isDigit(trimmed[i]!)) i += 1;
  } else if (isAsciiLetter(trimmed[i]!) && (trimmed[i + 1] === '.' || trimmed[i + 1] === ')')) {
    i += 1;
  } else {
    return undefined;
  }

  if (trimmed[i] === '.' || trimmed[i] === ')') {
    const afterPunct = trimmed.slice(0, i + 1);
    if (trimmed[i + 1] === ' ' || trimmed[i + 1] === undefined) {
      return { marker: afterPunct, remainder: trimmed.slice(i + 1).trimStart(), listKind: 'ordered' };
    }
  }
  return undefined;
}
