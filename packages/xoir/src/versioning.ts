/**
 * XOIR's own schema version — the shape of `XoirNode`/`XoirEdge`/the
 * serialized graph envelope. Bump this (and add a migration note in
 * `MIGRATIONS` below) whenever a structural change would break an old
 * deserializer, per SPECIFICATION.md §11's append-only versioning
 * philosophy applied at the IR level rather than the XO-package level.
 */
export const XOIR_SCHEMA_VERSION = 1;

/** Every schema version this build can still deserialize (forward AND backward compatibility, per the module's Core Principles). */
export const XOIR_SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1];

export interface SchemaMigrationNote {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly summary: string;
}

/** Append-only log of schema changes. Empty today — schema version 1 is the first. */
export const MIGRATIONS: readonly SchemaMigrationNote[] = [];

export function isSchemaVersionSupported(version: number): boolean {
  return XOIR_SUPPORTED_SCHEMA_VERSIONS.includes(version);
}

/**
 * A monotonically increasing per-node revision counter — distinct from
 * `XOIR_SCHEMA_VERSION` (the shape of the IR itself). Bumped by whichever
 * pass/compiler-frontend rewrites a node's properties, so two nodes that
 * share an id can still be ordered ("which is newer") without relying on
 * wall-clock timestamps.
 */
export type NodeVersion = number;

export interface CompatibilityMetadata {
  readonly minSchemaVersion: number;
  readonly maxSchemaVersion: number;
}

export function isCompatible(meta: CompatibilityMetadata, schemaVersion: number): boolean {
  return schemaVersion >= meta.minSchemaVersion && schemaVersion <= meta.maxSchemaVersion;
}