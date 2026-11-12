#!/usr/bin/env node
// Keeps the workflow's `paths:` filters honest.
//   node check-trigger-paths.mjs            fail if the workflow's filters differ from what the repository's dependency graph implies
//   node check-trigger-paths.mjs --print    print the filter list, ready to paste under `paths:` (6-space indent)
//   node check-trigger-paths.mjs --would-trigger <file> [<file> ...]   say whether a change to these files starts the workflow
// Run from anywhere; it locates the repository root itself.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedPaths, readWorkflowPaths, triggersRun, WORKFLOW_FILE, workflowSafetyProblems } from './lib/paths.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const expected = expectedPaths(root);
const args = process.argv.slice(2);

if (args[0] === '--print') {
  for (const p of expected) console.log(`      - '${p}'`);
  process.exit(0);
}

if (args[0] === '--would-trigger') {
  const files = args.slice(1);
  if (files.length === 0) {
    console.error('Usage: --would-trigger <changed file> [...]');
    process.exit(2);
  }
  for (const f of files) console.log(`${triggersRun([f], expected) ? 'runs  ' : 'skips '} ${f}`);
  console.log(
    `\nA push or pull request changing these files together ${triggersRun(files, expected) ? 'STARTS' : 'does NOT start'} the workflow.`,
  );
  process.exit(0);
}

const file = join(root, WORKFLOW_FILE);
if (!existsSync(file)) {
  console.error(`Missing ${WORKFLOW_FILE}`);
  process.exit(1);
}
const text = readFileSync(file, 'utf8');
const actual = readWorkflowPaths(text);
const problems = [];
for (const event of ['push', 'pull_request']) {
  const got = actual[event];
  if (got === undefined) {
    problems.push(`${event}: no \`paths:\` list found`);
    continue;
  }
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    const missing = expected.filter((p) => !got.includes(p));
    const extra = got.filter((p) => !expected.includes(p));
    problems.push(
      `${event}: paths are out of date. ${missing.length > 0 ? `Missing: ${missing.join(', ')}. ` : ''}${extra.length > 0 ? `Unexpected: ${extra.join(', ')}. ` : ''}${missing.length + extra.length === 0 ? 'Same entries, different order (order matters for "!" exclusions). ' : ''}Regenerate with: node apps/studio/visual/check-trigger-paths.mjs --print`,
    );
  }
}
for (const p of workflowSafetyProblems(text)) problems.push(`safety: ${p}`);

if (problems.length > 0) {
  console.error(`Studio visual workflow check FAILED:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`Studio visual workflow check passed (${expected.length} path filters for push and pull_request; safety rules satisfied).`);
