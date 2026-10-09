import { readFile } from 'node:fs/promises';
import { unpackArchive } from '@xo/package-sdk';
import { LocalFsBlobStore } from '@xo/storage';
import { RegistryClient } from '@xo/registry';
import type { CommandResult } from '../../command-result.js';
import { failWith, ok } from '../../command-result.js';

export interface PublishOptions {
  readonly archivePath: string;
  readonly registryDir: string;
}

/**
 * `xo publish <archive.xo> --registry <dir>`
 *
 * Reads and unpacks the archive (same `unpackArchive` every other
 * archive-reading command uses, e.g. `xo install`/`xo verify`), then
 * hands the full, in-memory `PackageBundle` to `RegistryClient.publish()`
 * — which is what actually runs `PackageValidator.validateAll()` and
 * rejects an unverified/tampered package before writing anything. This
 * command does no verification of its own; it only decides how to report
 * what `RegistryClient` found.
 */
export async function publishCommand(options: PublishOptions): Promise<CommandResult> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(options.archivePath));
  } catch (cause) {
    return failWith(`could not read "${options.archivePath}": ${(cause as Error).message}`);
  }

  const readResult = await unpackArchive(bytes);
  if (!readResult.ok) return failWith(`[${readResult.error.code}] ${readResult.error.message}`);

  const store = new LocalFsBlobStore(options.registryDir);
  const client = new RegistryClient(store);

  const published = await client.publish(readResult.value);
  if (!published.ok) return failWith(`[${published.error.code}] ${published.error.message}`);

  return ok([
    `Published "${published.value.manifest.name}@${published.value.manifest.version}"`,
    `  id:            ${published.value.id}`,
    `  publishedAt:   ${published.value.publishedAt}`,
    `  ledgerEntry:   ${published.value.ledgerEntryHash}`,
    `  registry:      ${options.registryDir}`,
  ]);
}
