import { err, ok } from '@xo/types';
import { ErrorCode, SerializationError } from '@xo/errors';
/**
 * A JSON-backed {@link Codec}. `JSON.parse` alone only proves "this is
 * valid JSON", not "this is a valid T" — callers that need the latter
 * should pass `validate`. Without it, decode only guarantees parseability.
 */
export function jsonCodec(options = {}) {
    return {
        encode(value) {
            return JSON.stringify(value, null, options.pretty ? 2 : undefined);
        },
        decode(raw) {
            let parsed;
            try {
                parsed = JSON.parse(raw);
            }
            catch (cause) {
                return err(new SerializationError(ErrorCode.SERIALIZATION_PARSE_FAILED, 'Failed to parse JSON', { cause }));
            }
            if (options.validate && !options.validate(parsed)) {
                return err(new SerializationError(ErrorCode.SERIALIZATION_SCHEMA_MISMATCH, 'Parsed JSON did not match the expected shape'));
            }
            return ok(parsed);
        },
    };
}
//# sourceMappingURL=json-codec.js.map