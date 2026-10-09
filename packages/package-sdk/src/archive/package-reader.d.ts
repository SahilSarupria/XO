import { Readable } from 'node:stream';
import { type Result } from '@xo/types';
import { PackageError } from '@xo/errors';
import type { PackageBundle } from '../types.js';
/** Unpacks complete `.xo` archive bytes into a {@link PackageBundle}. Prefer {@link unpackArchiveStream} for large archives. */
export declare function unpackArchive(archiveBytes: Uint8Array): Promise<Result<PackageBundle, PackageError>>;
/** Streams `.xo` archive bytes (zstd decompression, then tar extraction) into a {@link PackageBundle} without buffering the raw compressed input up front — the "Streaming Package Read" feature. Component data itself is still assembled into the returned bundle in memory; a caller that needs to process a single huge component without ever holding it in memory should read `tarStreamToEntries` directly rather than going through this convenience wrapper. */
export declare function unpackArchiveStream(input: Readable): Promise<Result<PackageBundle, PackageError>>;
//# sourceMappingURL=package-reader.d.ts.map