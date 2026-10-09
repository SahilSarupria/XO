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
export declare function jsonCodec<T>(options?: JsonCodecOptions<T>): Codec<T>;
//# sourceMappingURL=json-codec.d.ts.map