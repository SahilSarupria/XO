const MAX_TITLE_WORDS = 8;

function splitWords(text: string): readonly string[] {
  const words: string[] = [];
  let current = '';
  for (const ch of text) {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (current.length > 0) {
        words.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) words.push(current);
  return words;
}

/**
 * A leading bold run-in heading — `**Title.** body` or `__Title.__ body` — is the author's own title for the
 * paragraph. Returns it without the emphasis markers or trailing punctuation, or `undefined` when the content does
 * not start with one (an empty or unterminated marker is not a heading).
 */
export function leadingRunInHeading(content: string): string | undefined {
  const text = content.trimStart();
  const marker = text.startsWith('**') ? '**' : text.startsWith('__') ? '__' : undefined;
  if (marker === undefined) return undefined;
  const close = text.indexOf(marker, marker.length);
  if (close <= marker.length) return undefined;
  const inner = text
    .slice(marker.length, close)
    .trim()
    .replace(/[.:;,\s]+$/u, '');
  return inner.length > 0 && inner.length <= 120 ? inner : undefined;
}

/** Synthesizes a short, deterministic title from a unit's own content when it has no owning heading to borrow one from (every unit but the first in a section, and every unit at the document root). */
export function synthesizeTitle(content: string): string {
  const runIn = leadingRunInHeading(content);
  if (runIn !== undefined) return runIn;
  const words = splitWords(content.trim());
  if (words.length === 0) return '(untitled)';
  const truncated = words.slice(0, MAX_TITLE_WORDS).join(' ');
  return words.length > MAX_TITLE_WORDS ? `${truncated}…` : truncated;
}
