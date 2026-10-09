import { Readable } from 'node:stream';
import { type Result } from '@xo/types';
import { PackageError } from '@xo/errors';
/**
 * zstd compression matching SPECIFICATION.md §1.1's "zstd-compressed
 * tarball". Uses Node's built-in `node:zlib` zstd support (available from
 * Node 22.15+; this repo requires Node >=20.11 per `package.json`
 * `engines`, so a host on an older 20.x/22.x runtime without zstd in
 * `zlib` is a real gap — see this package's README "Known limitations").
 * No external zstd dependency (native-binding packages like
 * `@mongodb-js/zstd` need prebuilt binaries per platform, which this SDK
 * has no way to guarantee in every consumer's environment) is pulled in
 * as a result.
 */
export declare function zstdCompress(data: Uint8Array): Uint8Array;
export declare function zstdDecompress(data: Uint8Array): Result<Uint8Array, PackageError>;
export declare function zstdCompressStream(input: Readable): Readable;
export declare function zstdDecompressStream(input: Readable): Readable;
//# sourceMappingURL=zstd-codec.d.ts.map