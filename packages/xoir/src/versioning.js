/**
 * XOIR's own schema version — the shape of `XoirNode`/`XoirEdge`/the
 * serialized graph envelope. Bump this (and add a migration note in
 * `MIGRATIONS` below) whenever a structural change would break an old
 * deserializer, per SPECIFICATION.md §11's append-only versioning
 * philosophy applied at the IR level rather than the XO-package level.
 */
export const XOIR_SCHEMA_VERSION = 1;
/** Every schema version this build can still deserialize (forward AND backward compatibility, per the module's Core Principles). */
export const XOIR_SUPPORTED_SCHEMA_VERSIONS = [1];
/** Append-only log of schema changes. Empty today — schema version 1 is the first. */
export const MIGRATIONS = [];
export function isSchemaVersionSupported(version) {
    return XOIR_SUPPORTED_SCHEMA_VERSIONS.includes(version);
}
export function isCompatible(meta, schemaVersion) {
    return schemaVersion >= meta.minSchemaVersion && schemaVersion <= meta.maxSchemaVersion;
}
//# sourceMappingURL=versioning.js.map