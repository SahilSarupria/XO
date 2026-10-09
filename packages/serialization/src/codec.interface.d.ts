import type { Result } from '@xo/types';
import type { SerializationError } from '@xo/errors';
/**
 * A `Codec<T>` is the single boundary through which a type crosses from
 * "structured data we trust" to "bytes on disk / on the wire" and back.
 * Decoding always returns a `Result` — untrusted input (a manifest read
 * off disk, an HTTP body) must never be assumed valid.
 */
export interface Codec<T> {
    encode(value: T): string;
    decode(raw: string): Result<T, SerializationError>;
}
//# sourceMappingURL=codec.interface.d.ts.map