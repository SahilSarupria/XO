import { LocalFsBlobStore } from '@xo/storage';
import { RegistryClient } from '@xo/registry';
import type { CommandResult } from '../../command-result.js';
import { failWith, ok } from '../../command-result.js';

export interface RegistryInspectOptions {
  readonly id: string;
  readonly registryDir: string;
}

/**
 * `xo registry inspect <id> --registry <dir>`
 *
 * Prints a published package's record plus every benchmark run recorded
 * against it — the "falsifiable trust" summary a person deciding whether
 * to trust/install/license a package would actually want: not just "it
 * published successfully" but "here is what's been claimed about it and
 * whether those claims are still re-runnable/challengeable"
 * (`challengeable` on each `BenchmarkRun`, straight from the repository —
 * this command computes nothing).
 */
export async function registryInspectCommand(options: RegistryInspectOptions): Promise<CommandResult> {
  const store = new LocalFsBlobStore(options.registryDir);
  const client = new RegistryClient(store);

  const record = await client.get(options.id);
  if (!record.ok) return failWith(`[${record.error.code}] ${record.error.message}`);

  const runs = await client.listBenchmarksForPackage(options.id);

  const lines = [
    `${record.value.manifest.name}@${record.value.manifest.version}`,
    `  id:            ${record.value.id}`,
    `  creatorDid:    ${record.value.manifest.creatorDid}`,
    `  publishedAt:   ${record.value.publishedAt}`,
    `  formatVersion: ${record.value.manifest.formatVersion}`,
  ];

  if (record.value.manifest.capabilities && record.value.manifest.capabilities.length > 0) {
    lines.push('', 'Capabilities:', ...record.value.manifest.capabilities.map((c) => `  - ${c.id}: ${c.name}`));
  }

  if (runs.length === 0) {
    lines.push('', 'No benchmark runs recorded for this package.');
  } else {
    lines.push('', `Benchmark runs (${runs.length}):`, ...runs.map((r) => `  [${r.challengeable ? 'challengeable' : 'settled'}] ${r.category}: ${r.score}  (run ${r.id}, ${r.runAt})`));
  }

  return ok(lines);
}
