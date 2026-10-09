import { createZstdCompress, createZstdDecompress, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { err, ok } from '@xo/types';
import { ErrorCode, PackageError } from '@xo/errors';
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
export function zstdCompress(data) {
    return new Uint8Array(zstdCompressSync(data));
}
export function zstdDecompress(data) {
    try {
        return ok(new Uint8Array(zstdDecompressSync(data)));
    }
    catch (cause) {
        return err(new PackageError(ErrorCode.PACKAGE_CORRUPT, 'Failed to decompress package: not valid zstd data', { cause }));
    }
}
export function zstdCompressStream(input) {
    const transform = createZstdCompress();
    // `.pipe()` does NOT forward source-stream errors to its destination
    // (a well-known Node stream gotcha) — without this, an error on
    // `input` would surface only as an unhandled 'error' event on `input`
    // itself, crashing the process instead of propagating downstream to
    // whatever is consuming the returned stream.
    input.on('error', (cause) => transform.destroy(cause));
    return input.pipe(transform);
}
export function zstdDecompressStream(input) {
    const transform = createZstdDecompress();
    input.on('error', (cause) => transform.destroy(cause));
    return input.pipe(transform);
}
//# sourceMappingURL=zstd-codec.js.map