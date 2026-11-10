import { PackageInstaller } from '@xo/package-sdk';
import { LocalFsBlobStore } from '@xo/storage';
import type { CommandResult } from '../../command-result.js';
import { describeTrust } from '../../package-trust.js';

/**
 * `xo list --store <dir>`: what is installed and HOW each package was admitted. Read-only. It reports the verdict recorded at install time; it does not
 * re-verify (use `xo verify` on the archive for that), and a package admitted in development mode is shown as `unverified`, never as trusted.
 * Exit 1 when any installed package was not admitted as trusted under an enforcing policy, so a script can gate on it.
 */
export async function listCommand(options: { readonly storeDir: string; readonly json?: boolean }): Promise<CommandResult> {
  const records = await new PackageInstaller(new LocalFsBlobStore(options.storeDir)).listAllInstalledRecords();
  const rows = records
    .map((r) => ({
      name: r.name,
      version: r.version,
      installedAt: r.installedAt,
      trust: r.trust ?? null,
      admittedAsTrusted: r.trust?.status === 'trusted' && r.trust.mode === 'enforce',
    }))
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  const flagged = rows.filter((r) => !r.admittedAsTrusted).length;
  const lines =
    options.json === true
      ? [JSON.stringify({ packages: rows, notAdmittedAsTrusted: flagged }, null, 2)]
      : [
          `${rows.length} package(s) installed in ${options.storeDir}; ${flagged} not admitted as trusted under an enforcing policy`,
          ...rows.map(
            (r) =>
              `  ${r.name}@${r.version}  ${r.trust === null ? 'no trust record (installed before trust recording)' : describeTrust(r.trust)}${r.admittedAsTrusted ? '' : '  <-- NOT trusted'}`,
          ),
        ];
  return { exitCode: flagged > 0 ? 1 : 0, lines };
}
