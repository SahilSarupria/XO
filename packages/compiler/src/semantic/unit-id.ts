import { Sha256Hasher } from '@xo/crypto';
import { brand } from '@xo/types';
import type { ExperienceUnitId } from './types.js';

const hasher = new Sha256Hasher();

/**
 * Every Experience Unit's id is a content hash over exactly what
 * identifies it structurally — document path, section heading path, its
 * position within that section, and its own content — never a random
 * value or an incrementing counter. Running the chunker twice on
 * identical bytes therefore produces byte-for-byte identical ids, which
 * is what this stage's determinism guarantee actually rests on (see
 * `semantic-chunker.test.ts`'s determinism tests).
 */
export function computeExperienceUnitId(documentPath: string, sectionPath: readonly string[], blockIndexRange: readonly [number, number], content: string): ExperienceUnitId {
  const canonical = JSON.stringify({ documentPath, sectionPath, blockIndexRange, content });
  return brand(`eu_${hasher.hash(canonical).replace('sha256:', '').slice(0, 32)}`);
}

export function computeRelationshipId(type: string, fromUnitId: string, toUnitId: string): string {
  return `rel_${hasher.hash(JSON.stringify({ type, fromUnitId, toUnitId })).replace('sha256:', '').slice(0, 32)}`;
}
