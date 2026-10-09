export interface CommandSnippet {
  readonly text: string; // e.g. "sendEmail(to, subject, body)"
  readonly startOffset: number;
  readonly endOffset: number;
}

function isIdentifierChar(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_' || ch === '.';
}
function isIdentifierStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

/**
 * Detects a "command-like" or "code-snippet-like" span: an identifier
 * immediately followed by `(`, through to its matching `)` — e.g.
 * `sendEmail(to, subject)` or `xo.compile(path)`. A real, if narrow,
 * structural signal for API/tool descriptions and command examples
 * (the compiler spec's own phrasing) — manual character scanning, no
 * regex, matching this package's established style. Nested parentheses
 * are matched correctly (depth-tracked); an unterminated `(` with no
 * matching `)` before the end of the text is not reported (better to
 * miss it than report a snippet with no real end).
 */
export function detectCommandSnippets(text: string): readonly CommandSnippet[] {
  const snippets: CommandSnippet[] = [];
  let i = 0;
  while (i < text.length) {
    if (isIdentifierStart(text[i]!)) {
      const identStart = i;
      let j = i + 1;
      while (j < text.length && isIdentifierChar(text[j]!)) j += 1;
      if (text[j] === '(' && j - identStart >= 2) {
        let depth = 1;
        let k = j + 1;
        while (k < text.length && depth > 0) {
          if (text[k] === '(') depth += 1;
          else if (text[k] === ')') depth -= 1;
          k += 1;
        }
        if (depth === 0) {
          snippets.push({ text: text.slice(identStart, k), startOffset: identStart, endOffset: k });
          i = k;
          continue;
        }
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return snippets;
}
