import { Lexer } from './lexer.js';
import { decodeStream } from './filters.js';
import { isArray, isDictionary, isName, isPdfString, isStream, type PdfDictionary, type PdfValue } from './types.js';

/**
 * Resolves the actual bytes-shown-on-a-page → Unicode mapping for one font,
 * and decodes a text run's raw string bytes through it. This is the piece
 * `text-runs-to-plain-text.ts` was missing entirely (see this package's
 * README, "Known limitations"): that module used to decode every run as
 * raw Latin-1 regardless of the containing font, which is only correct for
 * a simple, non-embedded font using a standard byte-per-character
 * encoding. It is silently wrong — not an error, just wrong characters —
 * for the two extremely common real-world cases this module exists to
 * handle:
 *
 *   1. A simple font with a custom `/Differences` array remapping some
 *      byte codes away from its base encoding (common wherever a document
 *      needs a handful of extra glyphs — bullets, accented letters, a
 *      Euro sign — that its base encoding doesn't cover).
 *   2. A composite (`/Type0`) font — the overwhelming majority of
 *      embedded/subsetted fonts produced by modern PDF writers (Word,
 *      InDesign, headless browser "print to PDF", most web-form-to-PDF
 *      converters) — where each 2-byte code is a raw glyph index (CID)
 *      with *no* inherent relationship to any character encoding at all.
 *      The only way to recover text is the font's `/ToUnicode` CMap, a
 *      stream mapping codes to Unicode specifically for text-extraction
 *      purposes (ISO 32000-1 §9.10.3) — without it, decoding these bytes
 *      as if they were single-byte Latin-1 produces exactly the kind of
 *      "garbled control characters" / coincidental fixed-offset-cipher
 *      output real-world testing against this package's fixtures surfaced.
 */
export interface FontEncoding {
  /** Number of raw bytes making up one character code for this font — 1 for a simple font, 2 for the composite fonts this module handles (Identity-H/V and, as a documented approximation, every other predefined CMap encoding, since 2-byte codespaces are overwhelmingly the common case for embedded Western/subset fonts). */
  readonly codeByteWidth: 1 | 2;
  /** Decodes one run's raw string bytes to a best-effort Unicode string, consuming `codeByteWidth` bytes per character code. */
  decode(bytes: Uint8Array): string;
}

/** The pre-fix behavior, kept as the fallback for a font resource that can't be resolved at all (missing `Tf`, unknown resource name, malformed `/Resources`) — better to degrade to the old approximation than to throw and drop the page's text entirely. */
const FALLBACK_ENCODING: FontEncoding = {
  codeByteWidth: 1,
  decode: (bytes) => Buffer.from(bytes).toString('latin1'),
};

const REPLACEMENT_CHAR = '\ufffd';

export type ResolveFn = (value: PdfValue) => PdfValue;

/**
 * Builds a `(fontName) => FontEncoding` resolver scoped to one page's
 * `/Resources`, caching each font's built `FontEncoding` by its resolved
 * dictionary identity (cheap: a page's font set is small and stable, and
 * `Tf` reselects the same handful of fonts constantly within one page).
 */
export function buildFontEncodingResolver(resources: PdfDictionary | undefined, resolve: ResolveFn): (fontName: string | undefined) => FontEncoding {
  const cache = new Map<string, FontEncoding>();

  return (fontName: string | undefined): FontEncoding => {
    if (fontName === undefined || !resources) return FALLBACK_ENCODING;
    const cached = cache.get(fontName);
    if (cached) return cached;

    const fontDictValue = resources.entries.get('Font');
    const fontDict = fontDictValue !== undefined ? resolve(fontDictValue) : undefined;
    if (!fontDict || !isDictionary(fontDict)) return FALLBACK_ENCODING;

    const fontValue = fontDict.entries.get(fontName);
    const font = fontValue !== undefined ? resolve(fontValue) : undefined;
    if (!font || !isDictionary(font)) return FALLBACK_ENCODING;

    const built = buildFontEncoding(font, resolve);
    cache.set(fontName, built);
    return built;
  };
}

function buildFontEncoding(font: PdfDictionary, resolve: ResolveFn): FontEncoding {
  const subtypeValue = font.entries.get('Subtype');
  const subtype = subtypeValue !== undefined && isName(subtypeValue) ? subtypeValue.name : undefined;
  const toUnicode = parseToUnicodeCMap(font, resolve);

  if (subtype === 'Type0') {
    // Identity-H/V and (as a documented approximation) every other predefined
    // encoding CMap use 2-byte codes — see the interface doc comment above.
    if (toUnicode) {
      return { codeByteWidth: 2, decode: (bytes) => decodeWithMap(bytes, 2, toUnicode) };
    }
    // No ToUnicode on a composite font means the codes are raw glyph indices
    // with no recoverable meaning — emit a visible, honest placeholder per
    // code rather than 2x as many wrong Latin-1 characters (this is the
    // "not silent" requirement this package's README already commits to for
    // every other unsupported case).
    return { codeByteWidth: 2, decode: (bytes) => REPLACEMENT_CHAR.repeat(Math.ceil(bytes.length / 2)) };
  }

  // Simple font: prefer ToUnicode where present (it's the spec's own
  // text-extraction-purpose mapping and is authoritative when it exists,
  // for either a standard or a custom-Differences encoding); otherwise fall
  // back to base-encoding + /Differences.
  if (toUnicode) {
    return { codeByteWidth: 1, decode: (bytes) => decodeWithMap(bytes, 1, toUnicode) };
  }
  const table = buildSimpleFontTable(font, resolve);
  return { codeByteWidth: 1, decode: (bytes) => decodeWithTable(bytes, table) };
}

function decodeWithMap(bytes: Uint8Array, codeByteWidth: 1 | 2, map: ReadonlyMap<number, string>): string {
  let out = '';
  for (let i = 0; i + codeByteWidth <= bytes.length; i += codeByteWidth) {
    let code = 0;
    for (let j = 0; j < codeByteWidth; j += 1) code = code * 256 + bytes[i + j]!;
    out += map.get(code) ?? REPLACEMENT_CHAR;
  }
  return out;
}

function decodeWithTable(bytes: Uint8Array, table: readonly string[]): string {
  let out = '';
  for (const b of bytes) out += table[b] ?? String.fromCharCode(b);
  return out;
}

// ---------------------------------------------------------------------------
// Simple-font base encoding + /Differences
// ---------------------------------------------------------------------------

/** WinAnsiEncoding (ISO 32000-1 Annex D.2) — by far the most common base encoding real-world PDF writers declare (or implicitly assume) for non-symbolic Latin-text fonts; it's ASCII-identical for 0x20–0x7E and, critically, diverges from plain Latin-1 exactly in the 0x80–0x9F range (smart quotes, dashes, ellipsis, etc. instead of C1 control codes) — the range where the old raw-Latin-1 fallback was already silently wrong even for otherwise-simple fonts. */
const WIN_ANSI_TABLE: readonly string[] = buildWinAnsiTable();

function buildWinAnsiTable(): string[] {
  const table = new Array<string>(256);
  for (let i = 0x20; i <= 0x7e; i += 1) table[i] = String.fromCharCode(i);
  for (let i = 0; i < 0x20; i += 1) table[i] = '';
  table[0x7f] = '';
  const upper: Record<number, number> = {
    0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
    0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d,
    0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
    0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
  };
  for (let i = 0x80; i <= 0x9f; i += 1) {
    const cp = upper[i];
    table[i] = cp !== undefined ? String.fromCodePoint(cp) : '';
  }
  for (let i = 0xa0; i <= 0xff; i += 1) table[i] = String.fromCharCode(i); // WinAnsi matches Latin-1 from 0xA0 up
  return table;
}

/** Standard glyph-name → Unicode mappings needed to apply a `/Differences` array, restricted to the names that actually occur in real-world Differences arrays (accented Latin letters, punctuation, a handful of symbols) rather than the full multi-hundred-entry Adobe Glyph List — sufficient for the common case, and a name outside this map falls back to leaving the base-encoding byte in place rather than guessing. */
const GLYPH_NAME_TO_UNICODE: Readonly<Record<string, string>> = {
  bullet: '\u2022', endash: '\u2013', emdash: '\u2014', quoteleft: '\u2018', quoteright: '\u2019',
  quotedblleft: '\u201c', quotedblright: '\u201d', ellipsis: '\u2026', trademark: '\u2122',
  Euro: '\u20ac', dagger: '\u2020', daggerdbl: '\u2021', fi: '\ufb01', fl: '\ufb02',
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&',
  quotesingle: "'", parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-',
  period: '.', slash: '/', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?',
  at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', underscore: '_', grave: '`',
  braceleft: '{', bar: '|', braceright: '}', asciitilde: '~',
  Aacute: '\u00c1', aacute: '\u00e1', Eacute: '\u00c9', eacute: '\u00e9', Iacute: '\u00cd', iacute: '\u00ed',
  Oacute: '\u00d3', oacute: '\u00f3', Uacute: '\u00da', uacute: '\u00fa', Ntilde: '\u00d1', ntilde: '\u00f1',
  Ccedilla: '\u00c7', ccedilla: '\u00e7', Adieresis: '\u00c4', adieresis: '\u00e4', Odieresis: '\u00d6',
  odieresis: '\u00f6', Udieresis: '\u00dc', udieresis: '\u00fc', ssharp: '\u00df',
};

function buildSimpleFontTable(font: PdfDictionary, resolve: ResolveFn): readonly string[] {
  const table = WIN_ANSI_TABLE.slice();

  const encodingValue = font.entries.get('Encoding');
  const encoding = encodingValue !== undefined ? resolve(encodingValue) : undefined;
  if (!encoding) return table;

  // `/Encoding` can be a bare name (base encoding, no Differences) or a
  // dictionary with an optional /BaseEncoding + /Differences.
  let differences: PdfValue | undefined;
  if (isDictionary(encoding)) {
    const diffValue = encoding.entries.get('Differences');
    differences = diffValue !== undefined ? resolve(diffValue) : undefined;
    // /BaseEncoding (MacRomanEncoding, StandardEncoding, WinAnsiEncoding) is
    // not separately tabulated here — WinAnsi is used as the base regardless,
    // a documented approximation (all three agree across printable ASCII,
    // which covers the large majority of codes actually remapped in
    // real-world Differences arrays).
  } else if (isName(encoding)) {
    differences = undefined;
  }

  if (differences && isArray(differences)) {
    let code = 0;
    for (const item of differences.items) {
      if (typeof item === 'number') {
        code = item;
      } else if (isName(item)) {
        const mapped = GLYPH_NAME_TO_UNICODE[item.name];
        if (mapped !== undefined && code >= 0 && code < 256) table[code] = mapped;
        code += 1;
      }
    }
  }

  return table;
}

// ---------------------------------------------------------------------------
// /ToUnicode CMap parsing (bfchar / bfrange)
// ---------------------------------------------------------------------------

/**
 * Parses a `/ToUnicode` CMap stream (ISO 32000-1 §9.10.3) into a flat
 * `code -> string` map, reading only the `beginbfchar`/`endbfchar` and
 * `beginbfrange`/`endbfrange` blocks and ignoring the surrounding CMap
 * program boilerplate (`/CIDSystemInfo`, `usecmap`, codespace ranges,
 * etc.) — those don't affect the char→Unicode result this loader needs.
 * Reuses the general PDF token `Lexer` since a CMap's `bfchar`/`bfrange`
 * operands are ordinary PDF hex strings, arrays, and numbers.
 */
function parseToUnicodeCMap(font: PdfDictionary, resolve: ResolveFn): Map<number, string> | undefined {
  const toUnicodeValue = font.entries.get('ToUnicode');
  const toUnicode = toUnicodeValue !== undefined ? resolve(toUnicodeValue) : undefined;
  if (!toUnicode || !isStream(toUnicode)) return undefined;

  let data: Uint8Array;
  try {
    data = decodeStream(toUnicode);
  } catch {
    return undefined;
  }

  const map = new Map<number, string>();
  const lexer = new Lexer(data, 0);

  for (;;) {
    const token = lexer.next();
    if (token.kind === 'eof') break;
    if (token.kind !== 'keyword') continue;

    if (token.text === 'beginbfchar') {
      for (;;) {
        const srcTok = lexer.next();
        if (srcTok.kind === 'keyword' && srcTok.text === 'endbfchar') break;
        if (srcTok.kind === 'eof') break;
        const dstTok = lexer.next();
        if (srcTok.kind !== 'hexstring' || dstTok.kind !== 'hexstring') continue;
        const code = bytesToInt(srcTok.bytes!);
        map.set(code, utf16BEBytesToString(dstTok.bytes!));
      }
    } else if (token.text === 'beginbfrange') {
      for (;;) {
        const loTok = lexer.next();
        if (loTok.kind === 'keyword' && loTok.text === 'endbfrange') break;
        if (loTok.kind === 'eof') break;
        const hiTok = lexer.next();
        const dstTok = lexer.next();
        if (loTok.kind !== 'hexstring' || hiTok.kind !== 'hexstring') continue;
        const lo = bytesToInt(loTok.bytes!);
        const hi = bytesToInt(hiTok.bytes!);

        if (dstTok.kind === 'hexstring') {
          const base = bytesToInt(dstTok.bytes!);
          for (let code = lo; code <= hi; code += 1) {
            map.set(code, codePointToUtf16String(base + (code - lo)));
          }
        } else if (dstTok.kind === 'array_start') {
          let code = lo;
          for (;;) {
            const item = lexer.next();
            if (item.kind === 'array_end' || item.kind === 'eof') break;
            if (item.kind === 'hexstring') {
              map.set(code, utf16BEBytesToString(item.bytes!));
              code += 1;
            }
          }
        }
      }
    }
  }

  return map.size > 0 ? map : undefined;
}

function bytesToInt(bytes: Uint8Array): number {
  let value = 0;
  for (const b of bytes) value = value * 256 + b;
  return value;
}

function utf16BEBytesToString(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
  }
  if (bytes.length % 2 === 1) out += String.fromCharCode(bytes[bytes.length - 1]!);
  return out;
}

function codePointToUtf16String(codePoint: number): string {
  // bfrange numeric increments stay within the BMP for every real-world
  // ToUnicode CMap this loader is likely to see (subsetted Latin/Indic-script
  // text fonts, not supplementary-plane emoji/rare-CJK fonts) — a documented
  // approximation, not a silent one: values outside the BMP still produce a
  // deterministic (if not code-point-correct) UTF-16 code unit rather than throwing.
  return String.fromCharCode(codePoint & 0xffff);
}
