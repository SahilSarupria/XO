/**
 * The current schema version every `RuntimeStore` implementation writes.
 * Bump this and register a migration (below) when a persisted record's
 * shape needs to change in a future runtime version — never by silently
 * reinterpreting old records as the new shape.
 */
export const CURRENT_RUNTIME_STORE_VERSION = 1;
/**
 * "Stored version -> migration -> current representation" — deliberately
 * this small. `register(1, migrateV1ToV2)` means "here's how to turn a
 * version-1 record into a version-2 one"; `migrate` walks a record
 * forward one registered step at a time until it reaches
 * `CURRENT_RUNTIME_STORE_VERSION`, or throws a clear error if some step
 * in between was never registered (a genuinely unsupported old version,
 * not a silent data-loss risk).
 */
export class MigrationRegistry {
    migrations = new Map();
    /** Registers how to turn a `fromVersion` record into a `fromVersion + 1` one. */
    register(fromVersion, migrate) {
        this.migrations.set(fromVersion, migrate);
    }
    migrate(storedVersion, raw) {
        let version = storedVersion;
        let value = raw;
        while (version < CURRENT_RUNTIME_STORE_VERSION) {
            const step = this.migrations.get(version);
            if (!step) {
                throw new Error(`No migration registered to advance a persisted record from version ${version} (target: ${CURRENT_RUNTIME_STORE_VERSION})`);
            }
            value = step(value);
            version += 1;
        }
        return value;
    }
}
//# sourceMappingURL=versioning.js.map