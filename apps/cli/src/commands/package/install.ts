import { readFile } from 'node:fs/promises';
import { createLockfile, PackageInstaller, resolveDependencies, serializeLockfile, unpackArchive } from '@xo/package-sdk';
import { LocalFsBlobStore } from '@xo/storage';
import type { CommandResult } from '../../command-result.js';
import { failWith, ok } from '../../command-result.js';
import { buildLocalStoreLookup, lockfileKey } from './dependency-lookup.js';

export interface InstallOptions {
  readonly archivePath: string;
  readonly storeDir: string;
  readonly force?: boolean;
  /** Installs only the one archive, with no dependency resolution or lockfile write at all — for the case where someone is deliberately installing a dependency itself before its dependents (which would otherwise be an unresolvable "not found in store" failure on its own dependents' next install/lock). */
  readonly skipResolution?: boolean;
}

/**
 * `xo install <archive.xo> --store <dir> [--force] [--skip-resolution]`
 *
 * A manifest with no `dependencies` field (or an empty one) behaves
 * exactly as before this command was extended — a single-archive install,
 * no resolution, no `xo.lock` write, unchanged output. That path is the
 * first branch below and nothing about it changed.
 *
 * A manifest that declares dependencies goes through resolution first —
 * `resolveDependencies()` from `@xo/package-sdk`'s `resolver/`, given a
 * `ManifestLookup` built from whatever is already in `--store`
 * (`buildLocalStoreLookup` — see its doc comment for why "already in the
 * store" is the only source this can use today). Resolution happens
 * *before* the root package is ever installed, and a failure there
 * (`PACKAGE_DEPENDENCY_UNRESOLVED`/`_CONFLICT`/`_CYCLE`) fails the whole
 * command without installing anything — this is the all-or-nothing
 * requirement: a failed resolve must never leave a root package
 * installed with unresolved or conflicting dependencies sitting under
 * it. Only once resolution succeeds does the root get installed
 * (existing `PackageInstaller.install()` behavior, untouched) and an
 * `xo.lock` get written alongside its manifest (see
 * `dependency-lookup.ts`'s `lockfileKey` for exactly where).
 */

export async function installCommand(options: InstallOptions): Promise<CommandResult> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(options.archivePath));
  } catch (cause) {
    return failWith(`could not read "${options.archivePath}": ${(cause as Error).message}`);
  }

  const readResult = await unpackArchive(bytes);
  if (!readResult.ok) return failWith(`[${readResult.error.code}] ${readResult.error.message}`);

  const store = new LocalFsBlobStore(options.storeDir);
  const installer = new PackageInstaller(store);
  const installOptions = options.force !== undefined ? { force: options.force } : {};

  const dependencies = readResult.value.manifest.dependencies ?? [];
  if (options.skipResolution || dependencies.length === 0) {
    const installResult = await installer.install(readResult.value, installOptions);
    // Surface the real InstallError/PackageError code (e.g.
    // PACKAGE_ALREADY_INSTALLED, PACKAGE_VALIDATION_FAILED,
    // PACKAGE_NOT_INSTALLED) alongside the message rather than a generic
    // "error: ..." — the code is what a caller scripting against this CLI
    // (or a person who has seen it before) actually branches on.
    if (!installResult.ok) return failWith(`[${installResult.error.code}] ${installResult.error.message}`);
    return ok([
      `Installed "${installResult.value.name}@${installResult.value.version}"`,
      `  installedAt:   ${installResult.value.installedAt}`,
      `  manifestHash:  ${installResult.value.manifestHash}`,
      `  ${installResult.value.componentPaths.length} component file(s) written under ${options.storeDir}`,
      ...(options.skipResolution && dependencies.length > 0 ? [`  (--skip-resolution: ${dependencies.length} declared dependencies were not resolved or locked)`] : []),
    ]);
  }

  const lookup = await buildLocalStoreLookup(installer);
  const resolveResult = await resolveDependencies(readResult.value.manifest, lookup);
  if (!resolveResult.ok) {
    return failWith(`[${resolveResult.error.code}] ${resolveResult.error.message} — nothing was installed (resolve happens before install so a failed resolve never leaves a partially-dependent package on disk)`);
  }

  const installResult = await installer.install(readResult.value, installOptions);

  if (!installResult.ok) return failWith(`[${installResult.error.code}] ${installResult.error.message}`);


  const lockfile = createLockfile(resolveResult.value);
  const lockKey = lockfileKey(installResult.value.name, installResult.value.version);
  const lockPut = await store.put(lockKey, serializeLockfile(lockfile), { contentType: 'application/json' });
  if (!lockPut.ok) {
    return failWith(`"${installResult.value.name}@${installResult.value.version}" was installed, but writing its xo.lock failed: ${lockPut.error.message}`);
  }

  const skipped = resolveResult.value.skippedOptional;

  return ok([
    `Installed "${installResult.value.name}@${installResult.value.version}"`,
    `  installedAt:   ${installResult.value.installedAt}`,
    `  manifestHash:  ${installResult.value.manifestHash}`,
    `  ${installResult.value.componentPaths.length} component file(s) written under ${options.storeDir}`,
  '',
    `Resolved and locked ${resolveResult.value.resolved.length} dependenc${resolveResult.value.resolved.length === 1 ? 'y' : 'ies'}:`,
    ...resolveResult.value.resolved.map((d) => `  - ${d.name}@${d.version}`),
    ...(skipped.length > 0 ? [`Skipped ${skipped.length} unresolvable optional dependenc${skipped.length === 1 ? 'y' : 'ies'}:`, ...skipped.map((s) => `  - ${s.name} (wanted by "${s.requestedBy}" at "${s.versionRange}"): ${s.reason}`)] : []),
    `Lockfile written to ${options.storeDir}/${lockKey}`,
  ]);
}
