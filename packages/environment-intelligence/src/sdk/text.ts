import type { ClaimValue, EntityItem, KnowledgeItem } from '../knowledge/types.js';
import type { EvidenceReference } from './contracts.js';

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Values come from organizational sources and are UNTRUSTED. This makes one safe to embed as DATA: no control characters or line breaks, bounded, citation brackets neutralized. */
export function sanitize(value: unknown, max = 160): string {
  const raw = typeof value === 'string' ? value : String(value);
  const flat = raw
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/[<>]/g, '')
    // The context's section delimiters can never be forged from inside a value.
    .replace(/\b(BEGIN|END)\s+DATA\b/gi, '$1_DATA');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A JSON-quoted, sanitized scalar: quotes make "this is a value" unmistakable and escape anything that could close it. */
export const quoted = (value: unknown, max = 160): string => JSON.stringify(sanitize(value, max));

const KEY = /^([a-z]+)\|([a-z_0-9]+):(.*)$/s;

export function labelOf(entity: EntityItem | undefined, fallback: string): string {
  if (entity === undefined) return fallback;
  const parsed = entity.identifiers.map((k) => KEY.exec(k)).filter((m): m is RegExpExecArray => m !== null);
  const pick = (scheme: string): string | undefined => parsed.find((m) => m[2] === scheme)?.[3];
  return sanitize(
    pick('name') ??
      pick('email') ??
      pick('project_key') ??
      pick('team_key') ??
      pick('org_key') ??
      pick('employee_id') ??
      parsed[0]?.[3] ??
      fallback,
    80,
  );
}

export const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);

const STOP = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'or',
  'to',
  'in',
  'on',
  'for',
  'is',
  'are',
  'was',
  'were',
  'be',
  'by',
  'who',
  'what',
  'which',
  'whom',
  'how',
  'this',
  'that',
  'these',
  'those',
  'does',
  'do',
  'did',
  'has',
  'have',
  'with',
  'about',
  'me',
  'my',
  'our',
  'we',
  'it',
  'its',
  'at',
  'as',
  'from',
  'please',
  'tell',
  'assess',
  'show',
]);
export const meaningful = (s: string): string[] => [...new Set(tokenize(s).filter((t) => !STOP.has(t)))];

/** Words that point at a relationship type. Lexical only: a small, fixed, documented list. */
export const RELATION_WORDS: Readonly<Record<string, string>> = Object.freeze({
  own: 'owns',
  owns: 'owns',
  owner: 'owns',
  owned: 'owns',
  ownership: 'owns',
  manage: 'manages',
  manages: 'manages',
  manager: 'manages',
  managed: 'manages',
  reports: 'manages',
  depend: 'depends_on',
  depends: 'depends_on',
  dependency: 'depends_on',
  dependencies: 'depends_on',
  govern: 'governs',
  governs: 'governs',
  governed: 'governs',
  policy: 'governs',
  belong: 'belongs_to',
  belongs: 'belongs_to',
  member: 'belongs_to',
  team: 'belongs_to',
  associated: 'associated_with',
  involved: 'associated_with',
  works: 'associated_with',
});

export const evidenceOf = (support: ClaimValue['provenance']['support']): readonly EvidenceReference[] =>
  support.map((s) => ({
    evidenceId: s.evidenceId,
    sourceId: s.sourceId,
    contentHash: s.contentHash,
    observedAt: s.observedAt,
    anchoring: s.anchoring,
  }));

/** Tokens a retrieval can match an item on. */
export function itemTokens(item: KnowledgeItem, labels: ReadonlyMap<string, string>): string[] {
  switch (item.type) {
    case 'entity':
      return tokenize(item.identifiers.map((k) => KEY.exec(k)?.[3] ?? '').join(' '));
    case 'claim':
      return [...tokenize(item.predicate), ...tokenize(String(item.current?.value ?? '')), ...tokenize(labels.get(item.subject) ?? '')];
    case 'relationship':
      return [
        ...tokenize(item.relation.replace(/_/g, ' ')),
        ...tokenize(labels.get(item.from) ?? ''),
        ...tokenize(labels.get(item.to) ?? ''),
      ];
    case 'conflict':
      return [...tokenize(item.predicate), ...tokenize(labels.get(item.subject) ?? '')];
    case 'document':
      return [];
  }
}
