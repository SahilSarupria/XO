import { Sha256Hasher } from '@xo/crypto';

const hasher = new Sha256Hasher();

/**
 * Every `CanonicalSource.sourceId` is a content hash over the source's
 * own bytes/text plus its declared `sourceType` and `sourcePath` — never
 * `Date.now()`, `Math.random()`, or a random UUID (Stage 8 §13).
 * Including `sourceType`/`sourcePath` in the hash (not just content)
 * means the same bytes ingested as two different declared types, or
 * under two different caller-supplied paths, get distinct ids — which
 * matters because `sourceId` doubles as `chunkDocument`'s `documentPath`
 * argument (`compile-sources.ts`), and `computeExperienceUnitId`
 * (`../semantic/unit-id.ts`) hashes `documentPath` into every unit id it
 * produces.
 */
export function computeSourceId(sourceType: string, sourcePath: string, content: Uint8Array | string): string {
  const digest = hasher.hash(content);
  const combined = hasher.hash(`${sourceType}\u0000${sourcePath}\u0000${digest}`);
  return `src_${combined.replace('sha256:', '').slice(0, 32)}`;
}
