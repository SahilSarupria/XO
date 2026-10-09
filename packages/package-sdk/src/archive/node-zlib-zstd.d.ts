/**
 * The pinned `@types/node` (`^20.14.0` at the repo root) predates Node's
 * built-in zstd support in `node:zlib`, even though the functions
 * themselves are genuinely present at runtime on Node >=22.15 (verified:
 * `typeof zlib.zstdCompressSync === 'function'` on this repo's Node 22.22
 * runtime). This augments the module's types to match reality instead of
 * reaching for `any` at every call site. Delete this file once
 * `@types/node` catches up.
 */
import type { Transform } from 'node:stream';

declare module 'node:zlib' {
  interface ZstdOptions {
    readonly params?: Readonly<Record<number, number>>;
  }

  function zstdCompressSync(buffer: Buffer | ArrayBufferView | string, options?: ZstdOptions): Buffer;
  function zstdDecompressSync(buffer: Buffer | ArrayBufferView | string, options?: ZstdOptions): Buffer;
  function createZstdCompress(options?: ZstdOptions): Transform;
  function createZstdDecompress(options?: ZstdOptions): Transform;
}
