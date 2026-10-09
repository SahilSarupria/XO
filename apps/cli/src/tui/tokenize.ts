export interface TokenizeResult {
  readonly tokens: readonly string[];
  /** Set when the line ends inside a quoted string; tokens then holds what was parsed so far. */
  readonly unterminatedQuote?: "'" | '"';
}

/**
 * Splits a command line the way a shell would for the cases this CLI
 * needs: whitespace separates tokens, '…' is literal, "…" honors \" and
 * \\, and outside quotes a backslash escapes a following space, quote,
 * or backslash. Any other backslash is kept literally so Windows paths
 * (C:\Users\me\policy.pdf) survive untouched.
 */
export function tokenize(line: string): TokenizeResult {
  const tokens: string[] = [];
  let current = '';
  let has = false;
  let quote: "'" | '"' | undefined;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = undefined;
      else if (ch === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) {
        current += line[i + 1]!;
        i += 1;
      } else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === '\\' && (line[i + 1] === ' ' || line[i + 1] === '"' || line[i + 1] === "'" || line[i + 1] === '\\')) {
      current += line[i + 1]!;
      has = true;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || current !== '') tokens.push(current);
      current = '';
      has = false;
      continue;
    }
    current += ch;
    has = true;
  }
  if (has || current !== '') tokens.push(current);
  return quote !== undefined ? { tokens, unterminatedQuote: quote } : { tokens };
}

/** A leading `@` marks a file reference (`@policy.pdf`); everything downstream wants the bare path. */
export function stripAtPrefix(token: string): string {
  return token.startsWith('@') && token.length > 1 ? token.slice(1) : token;
}
