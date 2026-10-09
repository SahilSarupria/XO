/**
 * The current schema version every `RuntimeStore` implementation writes.
 * Bump this and register a migration (below) when a persisted record's
 * shape needs to change in a future runtime version — never by silently
 * reinterpreting old records as the new shape.
 */
export declare const CURRENT_RUNTIME_STORE_VERSION = 1;
export type Migration<T> = (raw: unknown) => T;
/**
 * "Stored version -> migration -> current representation" — deliberately
 * this small. `register(1, migrateV1ToV2)` means "here's how to turn a
 * version-1 record into a version-2 one"; `migrate` walks a record
 * forward one registered step at a time until it reaches
 * `CURRENT_RUNTIME_STORE_VERSION`, or throws a clear error if some step
 * in between was never registered (a genuinely unsupported old version,
 * not a silent data-loss risk).
 */
export declare class MigrationRegistry<T> {
    private readonly migrations;
    /** Registers how to turn a `fromVersion` record into a `fromVersion + 1` one. */
    register(fromVersion: number, migrate: Migration<T>): void;
    migrate(storedVersion: number, raw: unknown): T;
}
//# sourceMappingURL=versioning.d.ts.map