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
