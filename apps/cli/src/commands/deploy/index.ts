/**
 * UW-17 (ADR 0054) — `xo deploy render` and `xo deploy check`: from one config file (`xo-instance/1`), the files that bring up one XO
 * instance behind TLS on a virtual machine (cloud-init) or on Kubernetes. No secret value is ever read or written.
 */
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseDeployConfig, renderKubernetes, renderVm, stillNeeded, type InstanceDeployConfig } from '@xo/instance';
import type { CommandRegistry } from '../../command-registry.js';
import type { ParsedArgs } from '../../arg-parser.js';

const out = (s: string): void => void process.stdout.write(`${s}\n`);
const fail = (s: string): number => (process.stderr.write(`error: ${s}\n`), 1);
const str = (f: ParsedArgs['flags'], k: string): string | undefined => (typeof f[k] === 'string' ? (f[k] as string) : undefined);

async function load(args: ParsedArgs): Promise<InstanceDeployConfig | number> {
  const file = str(args.flags, 'config');
  if (file === undefined)
    return fail('usage: xo deploy <render|check> --config <instance.yaml> [--target vm|kubernetes] [--out <dir>] [--force]');
  const parsed = parseDeployConfig(await readFile(resolve(file), 'utf8'));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.problems.length} problem(s) in ${file}:\n${parsed.problems.map((p) => `  - ${p}`).join('\n')}\n`);
    return 1;
  }
  return parsed.config;
}

async function render(args: ParsedArgs): Promise<number> {
  const config = await load(args);
  if (typeof config === 'number') return config;
  const target = str(args.flags, 'target');
  if (target !== 'vm' && target !== 'kubernetes') return fail('--target must be vm or kubernetes');
  const dir = str(args.flags, 'out');
  if (dir === undefined) return fail('--out <dir> is required');
  const outDir = resolve(dir);
  let existing: string[] = [];
  try {
    existing = await readdir(outDir);
  } catch {
    // The folder does not exist yet.
  }
  if (existing.length > 0 && args.flags['force'] !== true && args.flags['force'] !== 'true')
    return fail(`${outDir} is not empty; choose another folder or pass --force`);
  const files = target === 'vm' ? renderVm(config) : renderKubernetes(config);
  for (const [rel, text] of files) {
    const path = join(outDir, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, { mode: 0o600 });
    await chmod(path, 0o600);
  }
  out(`wrote ${files.size} files to ${outDir} (${target}); nothing in them is a secret`);
  out('still needed:');
  for (const line of stillNeeded(config, target)) out(`  - ${line}`);
  return 0;
}

async function check(args: ParsedArgs): Promise<number> {
  const config = await load(args);
  if (typeof config === 'number') return config;
  const target = str(args.flags, 'target') === 'kubernetes' ? 'kubernetes' : 'vm';
  out(`${config.name}: the config is valid`);
  out('still needed after rendering:');
  for (const line of stillNeeded(config, target)) out(`  - ${line}`);
  return 0;
}

export function registerCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'deploy',
    subsystem: 'deploy',
    usage:
      'xo deploy render --config <instance.yaml> --target vm|kubernetes --out <dir> [--force]   Write the files for one instance behind TLS (no secret in them)\n' +
      'xo deploy check --config <instance.yaml> [--target vm|kubernetes]                         Validate the config and list what must still be provided',
    run: async (args) => {
      try {
        const [sub] = args.positionals;
        if (sub === 'render') return await render(args);
        if (sub === 'check') return await check(args);
        return fail('usage: xo deploy <render|check> --config <instance.yaml> ...');
      } catch (cause) {
        return fail(cause instanceof Error ? cause.message : String(cause));
      }
    },
  });
}
