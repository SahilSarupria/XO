import type { TextRun } from './content-stream.js';
import type { FontEncoding } from './font-encoding.js';

/** Looks up the `FontEncoding` for a text run's `fontName` (the page's current `Tf`-selected font resource) — see `font-encoding.ts` for what actually builds one of these. */
export type FontEncodingResolver = (fontName: string | undefined) => FontEncoding;

/** Fallback used only when no resolver is supplied (e.g. a caller that hasn't been updated, or a synthetic run with no font context) — preserves the old raw-Latin-1 behavior rather than throwing, since that's still correct for the common simple-font case and this package's README documents it as an approximation, not silently wrong-and-unflagged. */
const RAW_LATIN1_ENCODING: FontEncoding = {
  codeByteWidth: 1,
  decode: (bytes) => Buffer.from(bytes).toString('latin1'),
};

/** Decodes one text run's raw string bytes through its font's actual encoding — `font-encoding.ts`'s `/ToUnicode` CMap / base-encoding-plus-`/Differences` resolution — rather than assuming every run is single-byte Latin-1. This is what fixes the "garbled control characters" / coincidental fixed-offset-cipher output real-world PDFs with embedded `/Type0` `/Identity-H` fonts used to produce (see this package's README, "Known limitations," and the regression fixtures this fix was built against). */
export function decodeRunText(run: TextRun, resolveFontEncoding?: FontEncodingResolver): string {
  const encoding = resolveFontEncoding?.(run.fontName) ?? RAW_LATIN1_ENCODING;
  return encoding.decode(run.bytes);
}

/**
 * Joins text runs (already in content-stream / reading order) into plain
 * text, inserting a newline whenever a run's baseline `y` drops relative
 * to the previous run (a new line in single-column text). Deliberately
 * does NOT infer a space between runs that stay on the same line: a `TJ`
 * array routinely splits a single word into several runs purely for
 * kerning adjustment (e.g. `[(Hel) -20 (lo)]` for "Hello"), and without
 * font-metric-based advance widths there is no reliable way to tell that
 * case apart from two genuinely separate words — real PDF writers already
 * put an actual space character inside the string content whenever a
 * space is intended, so trusting the bytes as-is is more correct than
 * guessing. This is a page's "Plain text" per the compiler pipeline's
 * first arrow (PDF -> Plain text) — Stage 2 (document-parser.ts) works
 * from the richer positioned `TextRun[]` for structural decisions
 * (headings/lists/tables), not from this flattened string.
 *
 * `resolveFontEncoding` is optional (backward compatible with any existing
 * caller not yet passing page/font context) but should always be supplied
 * by `pdf-loader.ts` in practice — see `font-encoding.ts`'s
 * `buildFontEncodingResolver`, built from the page's `/Resources`.
 */
export function textRunsToPlainText(runs: readonly TextRun[], resolveFontEncoding?: FontEncodingResolver): string {
  let out = '';
  let lastY: number | undefined;
  for (const run of runs) {
    const text = decodeRunText(run, resolveFontEncoding);
    if (text.length === 0) continue;
    if (lastY !== undefined && Math.abs(run.y - lastY) > 0.01) {
      out += '\n';
    }
    out += text;
    lastY = run.y;
  }
  return out;
}
