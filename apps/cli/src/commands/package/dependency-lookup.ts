import type { XoManifest } from '@xo/types';
import { PackageInstaller, type ManifestLookup } from '@xo/package-sdk';

/**
 * Adapts `PackageInstaller`'s existing `listAllInstalledRecords()` +
 * `getManifest()` into the `ManifestLookup` shape `resolveDependencies()`
 * needs — this is the whole answer to "where does a dependency's
 * manifest come from" today: `packages/registry-core` is interfaces
 * only (confirmed by reading `packages/registry-core/src/` — every file
 * there is a `.interface.ts` with no implementing class, and the
 * `PackageRepository` doc comment says as much: "No implementation lives
 * here"), so there is no registry client anywhere in this repo to fetch
 * a dependency *from*. The only place a dependency's manifest can
 * legitimately come from right now is a version already sitting in the
 * same local store `xo install`/`xo lock` are pointed at — resolution
 * that needs anything else correctly fails with
 * `PACKAGE_DEPENDENCY_UNRESOLVED`, not a network call this repo can't
 * back yet.
 *
 * The installed-record snapshot is read once (`listAllInstalledRecords()`
 * up front) rather than per lookup call, so a single `resolveDependencies()`
 * run sees a consistent view of the store even if something else were to
 * change it mid-resolve — the same reason a database transaction reads
 * its working set once. This is a CLI-only adapter, not a new
 * capability: every call it makes is straight through `PackageInstaller`'s
 * existing public methods, nothing reimplemented from `resolver/` or
 * `install/` here.
 */
export async function buildLocalStoreLookup(installer: PackageInstaller): Promise<ManifestLookup> {
  const records = await installer.listAllInstalledRecords();
  const versionsByName = new Map<string, string[]>();
  for (const record of records) {
    const versions = versionsByName.get(record.name);
    if (versions) versions.push(record.version);
    else versionsByName.set(record.name, [record.version]);
  }

  return async (name: string): Promise<readonly XoManifest[]> => {
    const versions = versionsByName.get(name) ?? [];
    const manifests: XoManifest[] = [];
    for (const version of versions) {
      const result = await installer.getManifest(name, version);
      if (result.ok) manifests.push(result.value);
      // A record with a manifest that no longer reads back cleanly (deleted
      // out from under the store, corrupted) is silently excluded from the
      // candidate pool rather than failing the whole lookup — the resolver
      // already treats "no candidate satisfies this range" as a normal,
      // reportable outcome (PACKAGE_DEPENDENCY_UNRESOLVED/_CONFLICT), so a
      // multi-version-corrupt situation naturally still ends there.
    }
    return manifests;
  };
}

/** The store path a lockfile for `name@version` is written to and read from — alongside the manifest under that version's own installed directory, the same layout `manifest.json`/`metadata.json` already use (`PackageInstaller`'s own `packagePrefix(name, version)` convention, mirrored here since that helper isn't exported). Centralized so `install.ts`, `lock.ts`, and `inspect.ts` never disagree on where a lockfile lives. */
export function lockfileKey(name: string, version: string): string {
  return `${name}/${version}/xo.lock`;
}

/** Splits a `"<name>@<version>"` CLI argument the same way `uninstall.ts` already does — centralized here so `install.ts`'s `--skip-resolution` help text, `lock.ts`, and `inspect.ts`'s store mode all parse it identically. */
export function splitNameAtVersion(nameAtVersion: string): { readonly name: string; readonly version: string } | undefined {
  const at = nameAtVersion.lastIndexOf('@');
  if (at <= 0) return undefined;
  return { name: nameAtVersion.slice(0, at), version: nameAtVersion.slice(at + 1) };
}
