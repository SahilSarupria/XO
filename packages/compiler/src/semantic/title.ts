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

/** Synthesizes a short, deterministic title from a unit's own content when it has no owning heading to borrow one from (every unit but the first in a section, and every unit at the document root). */
export function synthesizeTitle(content: string): string {
  const words = splitWords(content.trim());
  if (words.length === 0) return '(untitled)';
  const truncated = words.slice(0, MAX_TITLE_WORDS).join(' ');
  return words.length > MAX_TITLE_WORDS ? `${truncated}…` : truncated;
}
