import { Readable } from 'node:stream';
import { type Result } from '@xo/types';
import { PackageError } from '@xo/errors';
export interface TarEntry {
    readonly path: string;
    readonly data: Uint8Array;
}
/**
 * Builds a tar {@link Readable} from an ordered list of entries — the
 * uncompressed half of SPECIFICATION.md §1.1's "content-addressed tarball
 * (zstd-compressed)". The whole archive is built up front rather than
 * incrementally (see the sandbox note above); the stream API is
 * preserved so callers piping this into zstd compression don't need to
 * change if a fully streaming tar writer is dropped in later.
 */
export declare function tarEntriesToStream(entries: readonly TarEntry[]): Readable;
export declare function tarEntriesToBuffer(entries: readonly TarEntry[]): Promise<Uint8Array>;
/**
 * Extracts every entry from a tar stream/buffer. Returns a `Result`
 * because a corrupt or truncated tar (SPECIFICATION.md §1's archive
 * itself, not one of its JSON components) is exactly the "corruption
 * detection" case this SDK's validation layer is required to surface,
 * not a thing worth throwing for.
 */
export declare function tarStreamToEntries(input: Readable): Promise<Result<readonly TarEntry[], PackageError>>;
export declare function tarBufferToEntries(buffer: Uint8Array): Promise<Result<readonly TarEntry[], PackageError>>;
//# sourceMappingURL=tar-codec.d.ts.map