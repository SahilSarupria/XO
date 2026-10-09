import { createLockfile, PackageInstaller, resolveDependencies, serializeLockfile } from '@xo/package-sdk';
import { LocalFsBlobStore } from '@xo/storage';
import type { CommandResult } from '../../command-result.js';
import { failWith, ok } from '../../command-result.js';
import { buildLocalStoreLookup, lockfileKey, splitNameAtVersion } from './dependency-lookup.js';

export interface LockOptions {
  /** `"<name>@<version>"` of an already-installed package. */
  readonly nameAtVersion: string;
  readonly storeDir: string;
}

/**
 * `xo lock <name>@<version> --store <dir>`
 *
 * Re-resolves an already-installed package's dependencies against the
 * store's *current* contents and (over)writes its `xo.lock` — for
 * refreshing a lockfile without a full reinstall, e.g. after separately
 * installing a new version of one of its dependencies. Does not touch
 * the package's own installed files (manifest, components) at all, only
 * the lockfile alongside them.
 */
export async function lockCommand(options: LockOptions): Promise<CommandResult> {
  const parsed = splitNameAtVersion(options.nameAtVersion);
  if (!parsed) return failWith(`expected "<name>@<version>", got "${options.nameAtVersion}"`);
  const { name, version } = parsed;

  const store = new LocalFsBlobStore(options.storeDir);
  const installer = new PackageInstaller(store);

  const manifestResult = await installer.getManifest(name, version);
  if (!manifestResult.ok) return failWith(`[${manifestResult.error.code}] ${manifestResult.error.message}`);

  const lookup = await buildLocalStoreLookup(installer);
  const resolveResult = await resolveDependencies(manifestResult.value, lookup);
  if (!resolveResult.ok) return failWith(`[${resolveResult.error.code}] ${resolveResult.error.message}`);

  const lockfile = createLockfile(resolveResult.value);
  const lockKey = lockfileKey(name, version);
  const lockPut = await store.put(lockKey, serializeLockfile(lockfile), { contentType: 'application/json' });
  if (!lockPut.ok) return failWith(`could not write xo.lock for "${name}@${version}": ${lockPut.error.message}`);

  return ok([
    `Wrote xo.lock for "${name}@${version}" (${resolveResult.value.resolved.length} dependenc${resolveResult.value.resolved.length === 1 ? 'y' : 'ies'}) to ${options.storeDir}/${lockKey}`,
    ...resolveResult.value.resolved.map((d) => `  - ${d.name}@${d.version}`),
  ]);
}
