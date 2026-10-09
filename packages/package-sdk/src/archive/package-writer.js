import { canonicalJson } from '../hashing/fingerprint.js';
import { tarEntriesToBuffer, tarEntriesToStream } from './tar-codec.js';
import { zstdCompress, zstdCompressStream } from './zstd-codec.js';
const MANIFEST_PATH = 'manifest.json';
const METADATA_PATH = 'metadata.json';
const CHANGELOG_PATH = 'CHANGELOG.md';
const SIGNATURES_PATH = 'signatures/signatures.json';
/** Builds the ordered, layout-conformant tar entry list for a bundle (SPECIFICATION.md §1.1) — the one place archive layout is decided, shared by the buffer and streaming writers so they can never drift apart. */
export function bundleToTarEntries(bundle) {
    const entries = [
        { path: MANIFEST_PATH, data: new TextEncoder().encode(canonicalJson(bundle.manifest)) },
        { path: METADATA_PATH, data: bundle.ancillary.metadataJson },
    ];
    if (bundle.ancillary.changelogMd)
        entries.push({ path: CHANGELOG_PATH, data: bundle.ancillary.changelogMd });
    for (const component of bundle.components) {
        entries.push({ path: component.path, data: component.data });
    }
    if (bundle.manifest.signatures && bundle.manifest.signatures.length > 0) {
        entries.push({ path: SIGNATURES_PATH, data: new TextEncoder().encode(canonicalJson(bundle.manifest.signatures)) });
    }
    return entries;
}
/** Packs a bundle into complete `.xo` archive bytes. Materializes the whole archive in memory — use {@link packBundleStream} for large packages (e.g. one carrying `weights/finetune`). */
export async function packBundle(bundle) {
    const tarBytes = await tarEntriesToBuffer(bundleToTarEntries(bundle));
    return zstdCompress(tarBytes);
}
/** Streams a bundle to `.xo` bytes: tar entries are written and zstd-compressed incrementally, so a large `weights/` component is never fully buffered by this function. */
export function packBundleStream(bundle) {
    return zstdCompressStream(tarEntriesToStream(bundleToTarEntries(bundle)));
}
//# sourceMappingURL=package-writer.js.map