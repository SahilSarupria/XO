/**
 * UW-1 — operator management of the instance's persisted access policy (`<WORKSPACE_DATA_DIR>/_instance/policy.json`). Grants and
 * suspensions here cover what workspace roles do not: procedures, external effects, audit access, capabilities. Workspace operations
 * themselves come from roles (ADR 0010); this file can only DENY them (to suspend someone). A running server picks changes up within
 * its reload interval (default 10 s).
 *
 *   node --import tsx scripts/manage-policy.ts list                                   [--file <path>]
 *   node --import tsx scripts/manage-policy.ts allow <principalId> <permission>       [--file <path>]
 *   node --import tsx scripts/manage-policy.ts deny  <principalId> <permission|domain> [--file <path>]
 *   node --import tsx scripts/manage-policy.ts remove <ruleId>                         [--file <path>]
 *
 * `--file` defaults to `$WORKSPACE_DATA_DIR/_instance/policy.json` (WORKSPACE_DATA_DIR defaults to `.xo-data/workspace-data`, as in
 * config.ts). Every write is atomic and refuses to overwrite a concurrent change (revision check).
 */
import { join } from 'node:path';
import { PERMISSION_DOMAINS, type PolicyRule } from '@xo/permissions';
import { readInstancePolicy, writeInstancePolicy } from '../src/auth/instance-policy.js';

function parse(args: readonly string[]): { positionals: string[]; file: string } {
  const positionals: string[] = [];
  let file = join(process.env['WORKSPACE_DATA_DIR'] ?? '.xo-data/workspace-data', '_instance', 'policy.json');
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--file') {
      const v = args[i + 1];
      if (v === undefined) throw new Error('--file requires a value');
      file = v;
      i++;
    } else positionals.push(a);
  }
  return { positionals, file };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .slice(0, 40);

async function change(file: string, edit: (rules: PolicyRule[]) => PolicyRule[] | string): Promise<void> {
  const current = await readInstancePolicy(file);
  if (!current.ok) {
    console.error(current.error.message);
    process.exitCode = 1;
    return;
  }
  const edited = edit([...current.value.rules]);
  if (typeof edited === 'string') {
    console.error(edited);
    process.exitCode = 1;
    return;
  }
  const written = await writeInstancePolicy(file, edited, current.value.revision);
  if (!written.ok) {
    console.error(written.error.message);
    process.exitCode = 1;
    return;
  }
  console.log(`instance policy revision ${written.value.revision} written to ${file} (${written.value.rules.length} rule(s))`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positionals, file } = parse(rest);
  const [a, b] = positionals;
  if (command === 'list') {
    const current = await readInstancePolicy(file);
    if (!current.ok) {
      console.error(current.error.message);
      process.exitCode = 1;
      return;
    }
    console.log(`revision ${current.value.revision}`);
    for (const r of current.value.rules) console.log(`${r.id}\t${r.effect}\t${JSON.stringify(r.match)}`);
    return;
  }
  if ((command === 'allow' || command === 'deny') && a !== undefined && b !== undefined) {
    const isDomain = (PERMISSION_DOMAINS as readonly string[]).includes(b);
    const effect = command === 'allow' ? 'ALLOW' : 'DENY';
    const id = `${command}.${slug(a)}.${slug(b)}`;
    await change(file, (rules) =>
      rules.some((r) => r.id === id)
        ? `rule "${id}" already exists`
        : [...rules, { id, effect, match: isDomain ? { principalId: a, domain: b } : { principalId: a, permission: b } } as PolicyRule],
    );
    return;
  }
  if (command === 'remove' && a !== undefined) {
    await change(file, (rules) => (rules.some((r) => r.id === a) ? rules.filter((r) => r.id !== a) : `no rule "${a}"`));
    return;
  }
  console.error(
    'Usage: manage-policy.ts list | allow <principalId> <permission> | deny <principalId> <permission|domain> | remove <ruleId> [--file <path>]',
  );
  process.exitCode = 1;
}

await main();
