import { LocalFsBlobStore } from '@xo/storage';
import { RegistryClient } from '@xo/registry';
import type { CommandResult } from '../../command-result.js';
import { failWith, ok } from '../../command-result.js';

export interface SearchOptions {
  readonly query: string;
  readonly registryDir: string;
}

/** `xo search <query> --registry <dir>` — see `RegistryClient.search()`'s doc comment for what "matches" means. */
export async function searchCommand(options: SearchOptions): Promise<CommandResult> {
  if (options.query.trim().length === 0) {
    return failWith('search query must not be blank');
  }

  const store = new LocalFsBlobStore(options.registryDir);
  const client = new RegistryClient(store);

  const results = await client.search(options.query);
  if (results.length === 0) {
    return ok([`No packages in ${options.registryDir} match "${options.query}"`]);
  }

  return ok([
    `${results.length} package(s) in ${options.registryDir} match "${options.query}":`,
    '',
    ...results.map((record) => `  ${record.manifest.name}@${record.manifest.version}  (${record.manifest.creatorDid})  ${record.id}`),
  ]);
}
