// Which changes should run the Studio visual check, derived from the repository itself instead of remembered by hand.
//
// Studio is HTTP-only: it imports no workspace package. But the screenshots are taken against a REAL @xo/api, so what
// the API is built from affects what Studio renders. The trigger surface is therefore:
//   apps/studio  +  apps/api  +  every workspace package @xo/api needs to build or run (transitively)
//   +  the files that decide which dependencies and tool versions get installed
//   +  this suite and its workflow.
// Documentation, tests of other things and desktop-only code are excluded so unrelated changes stay quiet.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const WORKFLOW_FILE = '.github/workflows/studio-visual.yml';
const ROOT_PACKAGE = 'apps/api';

const ALWAYS = [
  WORKFLOW_FILE,
  '.npmrc',
  '.nvmrc',
  'package-lock.json',
  'package.json',
  'tsconfig.base.json',
  'tsconfig.json',
  'examples/vertical-test/Aastha.pdf', // the document the synthetic data is built from
];

const EXCLUDED = [
  '!**/*.md',
  '!**/test/**',
  '!**/*.test.ts',
  '!**/*.test.tsx',
  '!apps/studio/src-tauri/**',
  '!apps/studio/desktop/**',
  '!apps/studio/vite.desktop.config.ts',
  '!apps/studio/scripts/**',
  '!apps/studio/deploy/**',
];

// Re-included AFTER the exclusions: the suite's own tests, docs-in-folder and reference images are all "infrastructure".
const REINCLUDED = ['apps/studio/visual/**'];

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readTsconfig(file) {
  // tsconfig allows comments and trailing commas; strip them conservatively.
  const text = readFileSync(file, 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(text);
}

/** name -> { dir, deps: [names] } for every workspace package under packages/ and apps/. */
export function workspacePackages(root) {
  const byName = new Map();
  const byDir = new Map();
  for (const parent of ['packages', 'apps']) {
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      const dir = `${parent}/${entry.name}`;
      const manifest = join(root, dir, 'package.json');
      if (!entry.isDirectory() || !existsSync(manifest)) continue;
      const pkg = readJson(manifest);
      const deps = new Set(Object.keys(pkg.dependencies ?? {}));
      const tsconfig = join(root, dir, 'tsconfig.json');
      if (existsSync(tsconfig)) {
        for (const ref of readTsconfig(tsconfig).references ?? []) {
          const target = resolve(root, dir, ref.path);
          deps.add(`dir:${target}`);
        }
      }
      byName.set(pkg.name, { dir, deps });
      byDir.set(resolve(root, dir), pkg.name);
    }
  }
  return { byName, byDir };
}

/** Directories of every workspace package the API needs, including the API itself, sorted. */
export function apiClosure(root) {
  const { byName, byDir } = workspacePackages(root);
  const start = [...byName].find(([, v]) => v.dir === ROOT_PACKAGE)?.[0];
  if (start === undefined) throw new Error(`${ROOT_PACKAGE} not found`);
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name) || !byName.has(name)) return;
    seen.add(name);
    for (const dep of byName.get(name).deps) visit(dep.startsWith('dir:') ? byDir.get(dep.slice(4)) : dep);
  };
  visit(start);
  return [...seen].map((n) => byName.get(n).dir).sort();
}

/** The exact, ordered `paths:` list the workflow must contain. */
export function expectedPaths(root) {
  const closure = apiClosure(root).filter((d) => d !== ROOT_PACKAGE);
  return [...ALWAYS, 'apps/studio/**', `${ROOT_PACKAGE}/**`, ...closure.map((d) => `${d}/**`), ...EXCLUDED, ...REINCLUDED];
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * GitHub's `paths:` semantics: for each changed file, patterns are applied in order and the last one that matches wins
 * (a `!` pattern excludes, a plain one includes). The run starts if ANY changed file ends up included.
 */
export function triggersRun(files, patterns) {
  const compiled = patterns.map((p) => ({ negate: p.startsWith('!'), re: globToRegExp(p.startsWith('!') ? p.slice(1) : p) }));
  return files.some((file) => {
    let included = false;
    for (const { negate, re } of compiled) if (re.test(file)) included = !negate;
    return included;
  });
}

/** Reads the `paths:` lists under `push:` and `pull_request:` without a YAML dependency (the format is fixed and checked). */
export function readWorkflowPaths(yamlText) {
  const out = {};
  let event;
  let inPaths = false;
  for (const line of yamlText.split(/\r?\n/)) {
    const ev = /^ {2}([a-z_]+):\s*$/.exec(line);
    if (ev !== null) {
      event = ev[1];
      inPaths = false;
      continue;
    }
    if (/^\S/.test(line)) {
      event = undefined;
      inPaths = false;
      continue;
    }
    if (event === undefined) continue;
    if (/^ {4}paths:\s*$/.test(line)) {
      inPaths = true;
      out[event] = [];
      continue;
    }
    const item = /^ {6}- '(.*)'\s*$/.exec(line);
    if (inPaths && item !== null) out[event].push(item[1]);
    else if (/^ {4}\S/.test(line)) inPaths = false;
  }
  return out;
}

/** Static safety rules for the workflow file itself. Returns a list of problems (empty = fine). */
export function workflowSafetyProblems(yamlText) {
  const problems = [];
  if (/\bpull_request_target\b/.test(yamlText)) problems.push('uses pull_request_target, which runs with secrets on fork code');
  if (/\$\{\{\s*secrets\./.test(yamlText)) problems.push('references secrets.*; the visual check must use no secrets at all');
  const perms = /^permissions:\s*\n((?: {2}\S.*\n)+)/m.exec(yamlText);
  if (perms === null) problems.push('has no top-level permissions block');
  else if (perms[1].trim() !== 'contents: read')
    problems.push(`permissions must be exactly "contents: read" (found: ${perms[1].trim().replace(/\n\s*/g, '; ')})`);
  if (/\bgit (commit|push)\b/.test(yamlText)) problems.push('contains git commit/push; the workflow must never write to the repository');
  if (!/persist-credentials:\s*false/.test(yamlText)) problems.push('checkout does not set persist-credentials: false');
  return problems;
}
