import { err, ok, type Result } from '@xo/types';
import { ErrorCode, SerializationError } from '@xo/errors';
import type { Codec } from './codec.interface.js';

export interface JsonCodecOptions<T> {
  /** Optional runtime shape check, run after JSON.parse succeeds. Return true if `value` is a valid T. */
  readonly validate?: (value: unknown) => value is T;
  readonly pretty?: boolean;
}

/**
 * A JSON-backed {@link Codec}. `JSON.parse` alone only proves "this is
 * valid JSON", not "this is a valid T" — callers that need the latter
 * should pass `validate`. Without it, decode only guarantees parseability.
 */
export function jsonCodec<T>(options: JsonCodecOptions<T> = {}): Codec<T> {
  return {
    encode(value: T): string {
      return JSON.stringify(value, null, options.pretty ? 2 : undefined);
    },
    decode(raw: string): Result<T, SerializationError> {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (cause) {
        return err(new SerializationError(ErrorCode.SERIALIZATION_PARSE_FAILED, 'Failed to parse JSON', { cause }));
      }
      if (options.validate && !options.validate(parsed)) {
        return err(new SerializationError(ErrorCode.SERIALIZATION_SCHEMA_MISMATCH, 'Parsed JSON did not match the expected shape'));
      }
      return ok(parsed as T);
    },
  };
}
