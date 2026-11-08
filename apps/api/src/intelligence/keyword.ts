/**
 * Keyword normalization shared by the interim (development) knowledge sources. This is plain word overlap, NOT semantic
 * search: a question only finds text that shares words with it (after lowercasing, dropping filler words and trimming a
 * trailing plural "s"). The sources that use it declare `method: 'lexical'` so the chat tells the user.
 */
const FILLER = new Set([
  'the',
  'and',
  'for',
  'are',
  'was',
  'what',
  'who',
  'how',
  'when',
  'where',
  'why',
  'does',
  'did',
  'our',
  'with',
  'that',
  'this',
  'from',
  'have',
  'has',
  'will',
  'can',
  'any',
  'all',
  'there',
  'their',
  'about',
  'which',
  'should',
  'would',
  'could',
  'into',
  'than',
  'then',
  'been',
  'being',
  'you',
  'your',
  'use',
  'using',
  'kind',
  'explain',
  'tell',
  'show',
  'give',
  'search',
  'find',
  'look',
  'please',
  'uploaded',
  'upload',
]);

export function keywords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
    .filter((t) => !FILLER.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));
}

/** Fraction of the question's keywords found in the text (0 when the question has none). */
export function overlap(wanted: ReadonlySet<string>, text: string): number {
  if (wanted.size === 0) return 0;
  const hay = new Set(keywords(text));
  let hits = 0;
  for (const w of wanted) if (hay.has(w)) hits += 1;
  return hits / wanted.size;
}
