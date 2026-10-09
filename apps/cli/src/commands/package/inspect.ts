import { readFile } from 'node:fs/promises';
import { inspectBundle, isLockfileStale, PackageInstaller, parseLockfile, unpackArchive } from '@xo/package-sdk';
import { LocalFsBlobStore } from '@xo/storage';
import type { CommandResult } from '../../command-result.js';
import { failWith, ok } from '../../command-result.js';
import { lockfileKey, splitNameAtVersion } from './dependency-lookup.js';

export async function inspectCommand(archivePath: string): Promise<CommandResult> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(archivePath));
  } catch (cause) {
    return failWith(`could not read "${archivePath}": ${(cause as Error).message}`);
  }

  const readResult = await unpackArchive(bytes);
  if (!readResult.ok) return failWith(readResult.error.message);

  const summary = inspectBundle(readResult.value);
  const lines: string[] = [
    `Name:              ${summary.name}`,
    `Version:           ${summary.version}`,
    `Creator DID:       ${summary.creatorDid}`,
    `Fingerprint:       ${summary.fingerprint}`,
    `Merkle root:       ${summary.merkleRoot ?? '(none)'}`,
    `Signatures:        ${summary.signatureCount}`,
    `Declared families: ${summary.declaredFamilies.join(', ')}`,
    `Total bytes:       ${summary.totalComponentBytes}`,
    'Components:',
  ];
  for (const component of summary.components) {
    lines.push(
      `  - ${component.kind.padEnd(24)} ${component.path.padEnd(36)} ${String(component.size).padStart(7)} bytes  required=${component.required}  ${component.hash}`,
    );
  }
  return ok(lines);
}

export interface InspectInstalledOptions {
  /** `"<name>@<version>"` of an already-installed package. */
  readonly nameAtVersion: string;
  readonly storeDir: string;
}

/**
 * `xo inspect <name>@<version> --store <dir>` — the store-backed sibling
 * of `inspectCommand` above, for a question that only makes sense about
 * an *installed* package, not an archive file: are this package's
 * dependencies still satisfied by what its `xo.lock` recorded, or has
 * something changed since the lock was written (a newly-edited manifest,
 * a dependency reinstalled at an incompatible version)?
 *
 * Chose to extend `inspect` rather than `verify` for this: `verify`'s
 * whole contract is byte-level validity of one archive file (schema,
 * hashes, Merkle root, signatures) with a deliberately binary exit code
 * meant for CI gating ("VALID"/"INVALID") — a lockfile staleness check
 * isn't about whether an archive is well-formed, it's a read-only report
 * about installed *state*, which is exactly the kind of read-only
 * summary `inspect` already exists to print. Folding a state check into
 * `verify` would blur that command's single well-defined pass/fail
 * meaning; adding a store-backed mode to `inspect` doesn't change
 * `inspect`'s nature at all, it just gives it a second source to inspect.
 * This intentionally does NOT call `resolveDependencies()` again — per
 * the brief, this is a read-only report using `isLockfileStale()`'s
 * cheap local check, not a re-resolve (that's what `xo lock` is for).
 */
export async function inspectInstalledCommand(options: InspectInstalledOptions): Promise<CommandResult> {
  const parsed = splitNameAtVersion(options.nameAtVersion);
  if (!parsed) return failWith(`expected "<name>@<version>", got "${options.nameAtVersion}"`);
  const { name, version } = parsed;

  const store = new LocalFsBlobStore(options.storeDir);
  const installer = new PackageInstaller(store);

  const manifestResult = await installer.getManifest(name, version);
  if (!manifestResult.ok) return failWith(`[${manifestResult.error.code}] ${manifestResult.error.message}`);
  const manifest = manifestResult.value;
  const dependencies = manifest.dependencies ?? [];

  const lines: string[] = [
    `Name:              ${manifest.name}`,
    `Version:           ${manifest.version}`,
    `Dependencies:      ${dependencies.length}`,
   ...dependencies.map((d) => `  - ${d.name} ${d.versionRange} (${d.kind})`),
  ];

  if (dependencies.length === 0) {
    lines.push('Lockfile:          n/a (no declared dependencies)');
    return ok(lines);
  }

  const lockKey = lockfileKey(name, version);
  const lockRaw = await store.get(lockKey);
  if (!lockRaw.ok) {
    lines.push(`Lockfile:          none found at ${options.storeDir}/${lockKey} — run "xo lock ${name}@${version} --store ${options.storeDir}"`);
    return ok(lines);
  }

  const lockfileResult = parseLockfile(new TextDecoder().decode(lockRaw.value));
  if (!lockfileResult.ok) {
    lines.push(`Lockfile:          [${lockfileResult.error.code}] ${lockfileResult.error.message}`);
    return { exitCode: 1, lines };
  }

  const staleResult = isLockfileStale(manifest, lockfileResult.value);
  if (!staleResult.ok) {
    lines.push(`Lockfile:          could not evaluate — [${staleResult.error.code}] ${staleResult.error.message}`);
    return { exitCode: 1, lines };
  }

 lines.push(
    staleResult.value
      ? `Lockfile:          STALE — declared dependencies have changed since xo.lock was written; run "xo lock ${name}@${version} --store ${options.storeDir}" to refresh`
      : 'Lockfile:          fresh',
  );
  return ok(lines);
}