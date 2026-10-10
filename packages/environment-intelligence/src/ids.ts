import { createHash } from 'node:crypto';
import { brand, type Brand } from '@xo/types';

/**
 * Identifier space of this package. Branded (per docs/CODING_STANDARDS.md)
 * so a `SourceId` can never be passed where an `EvidenceId` is expected.
 * None of these ids is a package, capability, XOIR-node or registry id —
 * they identify things *discovered in an environment*, never platform
 * artifacts.
 */
export type SourceId = Brand<string, 'EiSourceId'>;
export type EvidenceId = Brand<string, 'EiEvidenceId'>;
export type ConnectorId = Brand<string, 'EiConnectorId'>;
export type RelationshipId = Brand<string, 'EiRelationshipId'>;
export type ProcessId = Brand<string, 'EiProcessId'>;

export const SourceId = (value: string): SourceId => brand(value);
export const EvidenceId = (value: string): EvidenceId => brand(value);
export const ConnectorId = (value: string): ConnectorId => brand(value);
export const RelationshipId = (value: string): RelationshipId => brand(value);
export const ProcessId = (value: string): ProcessId => brand(value);

/**
 * Deterministic, content-derived id: the same inputs always produce the
 * same id, which is what makes repeat discovery idempotent (a second scan
 * of an unchanged environment yields identical ids, not duplicates).
 * Parts are length-prefixed so `["ab","c"]` and `["a","bc"]` cannot collide.
 */
export function stableDigest(parts: readonly string[]): string {
  const h = createHash('sha256');
  for (const part of parts) {
    h.update(String(part.length));
    h.update(':');
    h.update(part);
    h.update('\n');
  }
  return h.digest('hex');
}

export function stableId(prefix: string, parts: readonly string[]): string {
  return `${prefix}_${stableDigest(parts).slice(0, 24)}`;
}
