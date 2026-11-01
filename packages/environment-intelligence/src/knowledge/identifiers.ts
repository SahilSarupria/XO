import type { EntityKind, EntityRef, Identifier } from './types.js';
import { ENTITY_KINDS } from './types.js';
import { stableDigest } from '../ids.js';

/**
 * Identifier strength decides what entity resolution may do with an identifier (C5.1).
 *  - STRONG schemes identify one thing: two records that carry the same strong identifier value MAY be merged.
 *  - UNIQUE schemes additionally allow at most ONE value per entity: two different values of a unique scheme can never describe
 *    the same entity, so a merge that would join them is refused and reported as an identity conflict.
 *  - Everything else (names, usernames, aliases) is WEAK: a weak match alone NEVER merges. It is only reported as a merge candidate.
 */
export const STRONG_SCHEMES: ReadonlySet<string> = new Set([
  'email',
  'employee_id',
  'project_key',
  'team_key',
  'org_key',
  'customer_id',
  'asset_tag',
]);
export const UNIQUE_SCHEMES: ReadonlySet<string> = new Set([
  'employee_id',
  'project_key',
  'team_key',
  'org_key',
  'customer_id',
  'asset_tag',
]);

export const MAX_IDENTIFIERS_PER_REF = 8;
export const MAX_IDENTIFIER_VALUE = 256;
const SCHEME = /^[a-z][a-z0-9_]{0,31}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export const isStrongScheme = (scheme: string): boolean => STRONG_SCHEMES.has(scheme);

export function normalizeValue(scheme: string, value: string): string {
  const v = value.trim().normalize('NFKC');
  return scheme === 'email' || scheme === 'username' || scheme === 'name' || scheme === 'alias' ? v.toLowerCase().replace(/\s+/g, ' ') : v;
}

export function validIdentifier(i: unknown): i is Identifier {
  if (i === null || typeof i !== 'object') return false;
  const { scheme, value } = i as { scheme?: unknown; value?: unknown };
  return (
    typeof scheme === 'string' &&
    SCHEME.test(scheme) &&
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_IDENTIFIER_VALUE &&
    !CONTROL.test(value)
  );
}

/** The canonical key of an identifier within a kind: `kind|scheme:value`. Kind-scoped so a person key can never equal a team key. */
export const identifierKey = (kind: EntityKind, i: Identifier): string => `${kind}|${i.scheme}:${normalizeValue(i.scheme, i.value)}`;

export function validRef(ref: unknown): ref is EntityRef {
  if (ref === null || typeof ref !== 'object') return false;
  const { kind, identifiers } = ref as { kind?: unknown; identifiers?: unknown };
  return (
    typeof kind === 'string' &&
    (ENTITY_KINDS as readonly string[]).includes(kind) &&
    Array.isArray(identifiers) &&
    identifiers.length >= 1 &&
    identifiers.length <= MAX_IDENTIFIERS_PER_REF &&
    identifiers.every(validIdentifier)
  );
}

export const keysOfRef = (ref: EntityRef): readonly string[] => [...new Set(ref.identifiers.map((i) => identifierKey(ref.kind, i)))].sort();

/** Opaque, stable id of the entity that a single identifier key would form on its own. Used as the alias an entity answers to after merges. */
export const entityIdOfKey = (key: string): string => `ent_${stableDigest(['ei-entity-v1', key]).slice(0, 24)}`;

export const schemeOfKey = (key: string): string => key.slice(key.indexOf('|') + 1, key.indexOf(':', key.indexOf('|')));
export const kindOfKey = (key: string): EntityKind => key.slice(0, key.indexOf('|')) as EntityKind;
