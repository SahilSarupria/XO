#!/usr/bin/env node
// S1-3 (handoff 3.8): Studio's bundle budgets, checked against a production build (`npm run build -w @xo/studio` first).
//   first-screen JS (the entry and what index.html preloads) <= 250 KB gzipped
//   first-screen CSS                                        <=  60 KB gzipped
//   any one JS chunk                                        <= 120 KB gzipped
//   each place is its own chunk (the screens listed below are not in the entry)
// Prints a table and exits 1 when a budget is exceeded.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const KB = 1024;
const BUDGET = { firstJs: 250 * KB, firstCss: 60 * KB, chunk: 120 * KB };
const LAZY = ['ActivitySection', 'TasksSection', 'WorkSection', 'WorkflowScreen', 'SettingsScreen', 'ConnectSection', 'KnowledgeSection'];

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (!existsSync(join(dist, 'index.html'))) {
  console.error('studio-budget: no dist/index.html; build Studio first (npm run build -w @xo/studio)');
  process.exit(2);
}
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const gz = (file) => gzipSync(readFileSync(join(dist, file))).length;
const refs = (re) => [...html.matchAll(re)].map((m) => m[1].replace(/^\//, ''));
const firstJs = [
  ...new Set([...refs(/<script[^>]+type="module"[^>]+src="([^"]+)"/g), ...refs(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)]),
];
const firstCss = refs(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g);
const chunks = readdirSync(join(dist, 'assets')).filter((f) => f.endsWith('.js'));

const fail = [];
const sum = (files) => files.reduce((n, f) => n + gz(f), 0);
const fmt = (n) => `${(n / KB).toFixed(1)} KB`;
const firstJsSize = sum(firstJs);
const firstCssSize = sum(firstCss);
console.log(`first-screen JS  ${fmt(firstJsSize).padStart(10)}  (budget ${fmt(BUDGET.firstJs)})  ${firstJs.join(', ')}`);
console.log(`first-screen CSS ${fmt(firstCssSize).padStart(10)}  (budget ${fmt(BUDGET.firstCss)})`);
if (firstJsSize > BUDGET.firstJs) fail.push(`first-screen JS is ${fmt(firstJsSize)}`);
if (firstCssSize > BUDGET.firstCss) fail.push(`first-screen CSS is ${fmt(firstCssSize)}`);
for (const c of chunks) {
  const n = gz(join('assets', c));
  if (n > BUDGET.chunk) fail.push(`chunk ${c} is ${fmt(n)} (budget ${fmt(BUDGET.chunk)})`);
}
const largest = chunks.map((c) => [c, gz(join('assets', c))]).sort((a, b) => b[1] - a[1])[0];
if (largest !== undefined) console.log(`largest chunk    ${fmt(largest[1]).padStart(10)}  (budget ${fmt(BUDGET.chunk)})  ${largest[0]}`);
for (const name of LAZY) if (!chunks.some((c) => c.startsWith(`${name}-`))) fail.push(`${name} is not its own chunk`);
console.log(`chunks           ${String(chunks.length).padStart(10)}`);
if (fail.length > 0) {
  console.error(`\nstudio-budget: over budget:\n  - ${fail.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nstudio-budget: within budget');
