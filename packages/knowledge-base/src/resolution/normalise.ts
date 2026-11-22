/**
 * UW-5 (ADR 0040): identifier normalisation. Deterministic, idempotent, and deliberately conservative: it removes only
 * differences that are never meaningful for the scheme (case, spacing, separators), so it cannot merge two different identifiers.
 */
export type IdentifierRule = 'email' | 'alnum' | 'exact';

export function normaliseIdentifier(rule: IdentifierRule, value: string): string {
  const v = value.normalize('NFKC').trim();
  switch (rule) {
    case 'email':
      return v.toLowerCase();
    case 'alnum':
      return v.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    case 'exact':
      return v;
  }
}
