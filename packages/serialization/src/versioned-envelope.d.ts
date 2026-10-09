import { type Result } from '@xo/types';
import { SerializationError } from '@xo/errors';
/**
 * Every persisted artifact (manifest, benchmark result, license record) is
 * wrapped in a versioned envelope so a future schema change can branch on
 * `schemaVersion` instead of guessing from shape. This mirrors
 * SPECIFICATION.md §11's append-only versioning requirement at the storage
 * layer, not just the package layer.
 */
export interface VersionedEnvelope<T> {
    readonly schemaVersion: number;
    readonly payload: T;
}
export declare function wrapEnvelope<T>(payload: T, schemaVersion: number): VersionedEnvelope<T>;
export declare function unwrapEnvelope<T>(raw: unknown, expectedVersion: number, isPayload: (value: unknown) => value is T): Result<T, SerializationError>;
//# sourceMappingURL=versioned-envelope.d.ts.map