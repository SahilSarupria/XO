#!/usr/bin/env node
// Portable test runner. Node 20's `node --test` does not understand glob
// patterns (added in Node 21) and `sh` does not expand `**`, so package test
// scripts cannot rely on `test/**/*.test.ts`. This finds *.test.ts files
// recursively and hands explicit paths to `node --test`, identically on
// Node 20 and 22.
//
// Usage: node ../../scripts/run-tests.mjs [--coverage] [dir ...]   (default dir: test)
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const coverage = args.includes('--coverage');
const dirs = args.filter((a) => !a.startsWith('--'));
if (dirs.length === 0) dirs.push('test');

function collect(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collect(p, out);
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const files = [];
for (const d of dirs) if (existsSync(d)) collect(d, files);
files.sort();
if (files.length === 0) {
  console.error(`run-tests: no *.test.ts files found under: ${dirs.join(', ')}`);
  process.exit(1);
}

const nodeArgs = ['--import', 'tsx', ...(coverage ? ['--experimental-test-coverage'] : []), '--test', ...files];
const result = spawnSync(process.execPath, nodeArgs, { stdio: 'inherit' });
process.exit(result.status ?? 1);
