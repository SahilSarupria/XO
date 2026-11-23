#!/usr/bin/env node
// UW-13 (ADR 0053), Revision 4 G-1: the generic-code-diff gate.
//   node scripts/generic-diff-gate.mjs --base <ref> --head <ref> [--strict] [--allowlist <file>]
// Prints, as JSON, the files changed between two refs that are outside the allowlist (evaluation/generic-allowlist.json). Exits 1 only
// with --strict and when there is any. Informational until a vertical run makes it strict.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = flag('base');
const head = flag('head');
if (base === undefined || head === undefined) {
  console.error('usage: generic-diff-gate.mjs --base <ref> --head <ref> [--strict] [--allowlist <file>]');
  process.exit(2);
}
const allowPath = flag('allowlist') ?? fileURLToPath(new URL('../evaluation/generic-allowlist.json', import.meta.url));
const globs = JSON.parse(readFileSync(allowPath, 'utf8')).globs;

/** `*` matches within one path segment, `**` across segments. */
function toRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const allowed = globs.map(toRegExp);
const changed = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f !== '');
const outside = changed.filter((f) => !allowed.some((re) => re.test(f)));
console.log(JSON.stringify({ base, head, changed: changed.length, outsideAllowlist: outside }, null, 2));
process.exit(args.includes('--strict') && outside.length > 0 ? 1 : 0);
