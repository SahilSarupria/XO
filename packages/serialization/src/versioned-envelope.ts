import { err, ok, type Result } from '@xo/types';
import { ErrorCode, SerializationError } from '@xo/errors';

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

export function wrapEnvelope<T>(payload: T, schemaVersion: number): VersionedEnvelope<T> {
  return { schemaVersion, payload };
}

export function unwrapEnvelope<T>(
  raw: unknown,
  expectedVersion: number,
  isPayload: (value: unknown) => value is T,
): Result<T, SerializationError> {
  if (typeof raw !== 'object' || raw === null || !('schemaVersion' in raw) || !('payload' in raw)) {
    return err(new SerializationError(ErrorCode.SERIALIZATION_SCHEMA_MISMATCH, 'Value is not a versioned envelope'));
  }
  const envelope = raw as VersionedEnvelope<unknown>;
  if (envelope.schemaVersion !== expectedVersion) {
    return err(
      new SerializationError(
        ErrorCode.SERIALIZATION_SCHEMA_MISMATCH,
        `Envelope schemaVersion ${envelope.schemaVersion} does not match expected ${expectedVersion}`,
      ),
    );
  }
  if (!isPayload(envelope.payload)) {
    return err(new SerializationError(ErrorCode.SERIALIZATION_SCHEMA_MISMATCH, 'Envelope payload did not match the expected shape'));
  }
  return ok(envelope.payload);
}
