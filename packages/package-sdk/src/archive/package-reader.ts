import type { Readable } from 'node:stream';
import type { ComponentKind, XoManifest } from '@xo/types';
import { err, ok, type Result } from '@xo/types';
import { ErrorCode, PackageError } from '@xo/errors';
import { isXoManifest, isXoMetadata } from '../validation/schema.js';
import { componentCollisionProblem, componentPathProblem } from '../validation/safe-path.js';
import type { ComponentInput, PackageBundle } from '../types.js';
import { tarBufferToEntries, tarStreamToEntries, type TarEntry } from './tar-codec.js';
import { zstdDecompress, zstdDecompressStream } from './zstd-codec.js';

function entriesToBundle(entries: readonly TarEntry[]): Result<PackageBundle, PackageError> {
  // Every archive entry name must be a safe, confined relative path, and no two may collide (case-folding / separator tricks) — checked before any entry is interpreted.
  for (const e of entries) {
    // The two installer-owned root files are legitimate archive entries (exact, lowercase names only); any other spelling falls through to the reserved-name check below.
    const problem = e.path === 'manifest.json' || e.path === 'metadata.json' ? undefined : componentPathProblem(e.path);
    if (problem !== undefined) {
      return err(new PackageError(ErrorCode.PACKAGE_CORRUPT, `Archive contains an unsafe entry name: ${problem}`));
    }
  }
  const collision = componentCollisionProblem(entries.map((e) => e.path));
  if (collision !== undefined) {
    return err(new PackageError(ErrorCode.PACKAGE_CORRUPT, `Archive entries collide: ${collision}`));
  }
  const byPath = new Map(entries.map((e) => [e.path, e.data]));

  const manifestBytes = byPath.get('manifest.json');
  if (!manifestBytes) {
    return err(new PackageError(ErrorCode.PACKAGE_MANIFEST_INVALID, 'Archive is missing required manifest.json'));
  }
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch (cause) {
    return err(new PackageError(ErrorCode.PACKAGE_CORRUPT, 'manifest.json is not valid JSON', { cause }));
  }
  if (!isXoManifest(manifestJson)) {
    return err(new PackageError(ErrorCode.PACKAGE_MANIFEST_INVALID, 'manifest.json does not match the XoManifest schema'));
  }
  const manifest: XoManifest = manifestJson;

  const metadataBytes = byPath.get('metadata.json');
  if (!metadataBytes) {
    return err(new PackageError(ErrorCode.PACKAGE_MANIFEST_INVALID, 'Archive is missing required metadata.json'));
  }
  let metadataJsonParsed: unknown;
  try {
    metadataJsonParsed = JSON.parse(new TextDecoder().decode(metadataBytes));
  } catch (cause) {
    return err(new PackageError(ErrorCode.PACKAGE_CORRUPT, 'metadata.json is not valid JSON', { cause }));
  }
  if (!isXoMetadata(metadataJsonParsed)) {
    return err(new PackageError(ErrorCode.PACKAGE_MANIFEST_INVALID, 'metadata.json does not match the XoMetadata schema'));
  }

  const components: ComponentInput[] = [];
  for (const [kind, entry] of Object.entries(manifest.components)) {
    const data = byPath.get(entry.path);
    if (!data) {
      if (entry.required) {
        return err(
          new PackageError(
            ErrorCode.PACKAGE_COMPONENT_MISSING,
            `Required component "${kind}" declared at "${entry.path}" is missing from the archive`,
          ),
        );
      }
      continue;
    }
    components.push({ kind: kind as ComponentKind, path: entry.path, data, required: entry.required });
  }

  return ok({
    manifest,
    components: Object.freeze(components),
    ancillary: Object.freeze({
      metadataJson: metadataBytes,
      ...(byPath.has('CHANGELOG.md') ? { changelogMd: byPath.get('CHANGELOG.md')! } : {}),
    }),
  });
}

/** Unpacks complete `.xo` archive bytes into a {@link PackageBundle}. Prefer {@link unpackArchiveStream} for large archives. */
export async function unpackArchive(
  archiveBytes: Uint8Array,
  options: { readonly maxDecompressedBytes?: number } = {},
): Promise<Result<PackageBundle, PackageError>> {
  const decompressed = zstdDecompress(archiveBytes, options.maxDecompressedBytes);
  if (!decompressed.ok) return decompressed;
  const entriesResult = await tarBufferToEntries(decompressed.value);
  if (!entriesResult.ok) return entriesResult;
  return entriesToBundle(entriesResult.value);
}

/** Streams `.xo` archive bytes (zstd decompression, then tar extraction) into a {@link PackageBundle} without buffering the raw compressed input up front — the "Streaming Package Read" feature. Component data itself is still assembled into the returned bundle in memory; a caller that needs to process a single huge component without ever holding it in memory should read `tarStreamToEntries` directly rather than going through this convenience wrapper. */
export async function unpackArchiveStream(input: Readable): Promise<Result<PackageBundle, PackageError>> {
  const entriesResult = await tarStreamToEntries(zstdDecompressStream(input));
  if (!entriesResult.ok) return entriesResult;
  return entriesToBundle(entriesResult.value);
}
