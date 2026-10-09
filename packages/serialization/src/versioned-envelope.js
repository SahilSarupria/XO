import { err, ok } from '@xo/types';
import { ErrorCode, SerializationError } from '@xo/errors';
export function wrapEnvelope(payload, schemaVersion) {
    return { schemaVersion, payload };
}
export function unwrapEnvelope(raw, expectedVersion, isPayload) {
    if (typeof raw !== 'object' || raw === null || !('schemaVersion' in raw) || !('payload' in raw)) {
        return err(new SerializationError(ErrorCode.SERIALIZATION_SCHEMA_MISMATCH, 'Value is not a versioned envelope'));
    }
    const envelope = raw;
    if (envelope.schemaVersion !== expectedVersion) {
        return err(new SerializationError(ErrorCode.SERIALIZATION_SCHEMA_MISMATCH, `Envelope schemaVersion ${envelope.schemaVersion} does not match expected ${expectedVersion}`));
    }
    if (!isPayload(envelope.payload)) {
        return err(new SerializationError(ErrorCode.SERIALIZATION_SCHEMA_MISMATCH, 'Envelope payload did not match the expected shape'));
    }
    return ok(envelope.payload);
}
//# sourceMappingURL=versioned-envelope.js.map