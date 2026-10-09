import { Readable } from 'node:stream';
import type { PackageBundle } from '../types.js';
import { type TarEntry } from './tar-codec.js';
/** Builds the ordered, layout-conformant tar entry list for a bundle (SPECIFICATION.md §1.1) — the one place archive layout is decided, shared by the buffer and streaming writers so they can never drift apart. */
export declare function bundleToTarEntries(bundle: PackageBundle): readonly TarEntry[];
/** Packs a bundle into complete `.xo` archive bytes. Materializes the whole archive in memory — use {@link packBundleStream} for large packages (e.g. one carrying `weights/finetune`). */
export declare function packBundle(bundle: PackageBundle): Promise<Uint8Array>;
/** Streams a bundle to `.xo` bytes: tar entries are written and zstd-compressed incrementally, so a large `weights/` component is never fully buffered by this function. */
export declare function packBundleStream(bundle: PackageBundle): Readable;
//# sourceMappingURL=package-writer.d.ts.map