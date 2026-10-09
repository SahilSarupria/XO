import { PackageInstaller } from '@xo/package-sdk';
import { LocalFsBlobStore } from '@xo/storage';
import type { CommandResult } from '../../command-result.js';
import { failWith, ok } from '../../command-result.js';

export interface UninstallOptions {
  /** `"<name>@<version>"` */
  readonly nameAtVersion: string;
  readonly storeDir: string;
}

export async function uninstallCommand(options: UninstallOptions): Promise<CommandResult> {
  const at = options.nameAtVersion.lastIndexOf('@');
  if (at <= 0) return failWith(`expected "<name>@<version>", got "${options.nameAtVersion}"`);
  const name = options.nameAtVersion.slice(0, at);
  const version = options.nameAtVersion.slice(at + 1);

  const installer = new PackageInstaller(new LocalFsBlobStore(options.storeDir));
  const result = await installer.uninstall(name, version);
  if (!result.ok) return failWith(result.error.message);

  return ok([`Uninstalled "${name}@${version}" from ${options.storeDir}`]);
}
