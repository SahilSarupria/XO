import { readFile } from 'node:fs/promises';
import { unpackArchive, type PackageTrustPolicy } from '@xo/package-sdk';
import { resolveTrustValidator } from '../../package-trust.js';
import { LocalFsBlobStore } from '@xo/storage';
import { RegistryClient } from '@xo/registry';
import type { CommandResult } from '../../command-result.js';
import { failWith, ok } from '../../command-result.js';

export interface PublishOptions {
  readonly archivePath: string;
  readonly registryDir: string;
  /** P1.0 M5 — injected trust policy (tests). Defaults to the operator's `XO_PACKAGE_TRUST_POLICY`. */
  readonly trustPolicy?: PackageTrustPolicy;
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
  const trust = resolveTrustValidator(options.trustPolicy);
  if (!trust.ok) return failWith(trust.message);
  const client = new RegistryClient(store, { validator: trust.validator });

  const published = await client.publish(readResult.value);
  if (!published.ok) return failWith(`[${published.error.code}] ${published.error.message}`);

  const verdict = trust.validator.evaluateTrust(readResult.value.manifest);
  return ok([
    ...trust.warnings,
    `Published "${published.value.manifest.name}@${published.value.manifest.version}"`,
    `  trust:         ${verdict.status} [mode=${verdict.mode}]`,
    `  id:            ${published.value.id}`,
    `  publishedAt:   ${published.value.publishedAt}`,
    `  ledgerEntry:   ${published.value.ledgerEntryHash}`,
    `  registry:      ${options.registryDir}`,
  ]);
}
