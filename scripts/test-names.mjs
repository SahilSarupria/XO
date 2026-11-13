#!/usr/bin/env node
// By-name test baseline (UW-0, docs/baseline/UW0_BASELINE.md §4).
//
//   node scripts/test-names.mjs extract <npm-test.log> [vitest.json]   prints workspace<TAB>status<TAB>full name, one per result
//   node scripts/test-names.mjs compare <baseline.tsv> <current.tsv>   lists baseline passes that are missing or no longer pass
//
// `extract` reads the TAP that `npm test` prints for node:test workspaces (nested names joined with " > ") and, optionally, a
// Vitest JSON report (`vitest run --reporter=json --outputFile=...`) for @xo/studio. `compare` exits 1 when any baseline pass is
// missing or not passing; new tests are reported but never fail the comparison. Lines starting with '#' are ignored.
import { readFileSync } from 'node:fs';

function extractTap(text) {
  const rows = [];
  const parts = text.split(/\n> (@xo\/[\w-]+|xo-[\w-]+)@[\d.]+ test\n/);
  for (let i = 1; i < parts.length; i += 2) {
    const workspace = parts[i];
    let stack = [];
    for (const line of parts[i + 1].split('\n')) {
      const sub = /^(\s*)# Subtest: (.*)$/.exec(line);
      if (sub) {
        const indent = sub[1].length;
        stack = stack.filter((s) => s.indent < indent);
        stack.push({ indent, name: sub[2] });
        continue;
      }
      const res = /^(\s*)(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/.exec(line);
      if (!res) continue;
      const indent = res[1].length;
      const parents = stack.filter((s) => s.indent < indent).map((s) => s.name);
      const status = res[4] === 'SKIP' ? 'skip' : res[4] === 'TODO' ? 'todo' : res[2] === 'ok' ? 'pass' : 'fail';
      rows.push([workspace, status, [...parents, res[3]].join(' > ').replaceAll('\t', ' ')]);
      stack = stack.filter((s) => s.indent < indent);
    }
  }
  return rows;
}

function extractVitest(json, workspace = '@xo/studio') {
  const map = { passed: 'pass', failed: 'fail', skipped: 'skip', pending: 'skip', todo: 'todo' };
  const rows = [];
  for (const file of json.testResults) {
    const name = file.name.split('apps/studio/').pop();
    for (const a of file.assertionResults) {
      rows.push([workspace, map[a.status] ?? a.status, [name, ...a.ancestorTitles, a.title].join(' > ').replaceAll('\t', ' ')]);
    }
  }
  return rows;
}

function readTsv(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map((l) => l.split('\t'));
}

const [command, a, b] = process.argv.slice(2);
if (command === 'extract' && a !== undefined) {
  const rows = extractTap(readFileSync(a, 'utf8'));
  if (b !== undefined) rows.push(...extractVitest(JSON.parse(readFileSync(b, 'utf8'))));
  process.stdout.write(rows.map((r) => r.join('\t')).join('\n') + '\n');
} else if (command === 'compare' && a !== undefined && b !== undefined) {
  const key = (r) => `${r[0]}\t${r[2]}`;
  const count = (rows) => rows.reduce((m, r) => m.set(key(r), [...(m.get(key(r)) ?? []), r[1]]), new Map());
  const base = count(readTsv(a));
  const cur = count(readTsv(b));
  const broken = [];
  for (const [k, statuses] of base) {
    const passesBefore = statuses.filter((s) => s === 'pass').length;
    const passesNow = (cur.get(k) ?? []).filter((s) => s === 'pass').length;
    if (passesNow < passesBefore) broken.push(`${k}\t(pass ${passesBefore} -> ${passesNow})`);
  }
  const added = [...cur.keys()].filter((k) => !base.has(k)).length;
  for (const line of broken) console.log(`MISSING-OR-NOT-PASSING\t${line}`);
  console.log(
    `baseline entries ${[...base.values()].flat().length}; current ${[...cur.values()].flat().length}; new names ${added}; regressions ${broken.length}`,
  );
  process.exit(broken.length === 0 ? 0 : 1);
} else {
  console.error('usage: test-names.mjs extract <npm-test.log> [vitest.json] | compare <baseline.tsv> <current.tsv>');
  process.exit(2);
}
