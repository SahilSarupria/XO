/**
 * RX-1h (ADR 0048): the mandatory scenario index (docs/runtime/MANDATORY_SCENARIOS.md) names, for each of the twenty scenarios, the
 * tests that prove it. This keeps it honest: every scenario is present once, every Done scenario names evidence, and every evidence
 * line names a test file that exists and a test title that is in it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const INDEX = join(ROOT, 'docs', 'runtime', 'MANDATORY_SCENARIOS.md');

interface Scenario {
  readonly n: number;
  readonly title: string;
  readonly status: string;
  readonly evidence: { readonly file: string; readonly title: string }[];
}

function parse(text: string): Scenario[] {
  const out: Scenario[] = [];
  for (const line of text.split('\n')) {
    const h = /^## (\d+)\. (.+) — (Done|Not applicable|Planned)$/.exec(line);
    if (h !== null) {
      out.push({ n: Number(h[1]), title: h[2]!, status: h[3]!, evidence: [] });
      continue;
    }
    const e = /^- `([^`]+)` › (.+)$/.exec(line);
    if (e !== null) {
      assert.ok(out.length > 0, `evidence before any scenario: ${line}`);
      out.at(-1)!.evidence.push({ file: e[1]!, title: e[2]!.trim() });
    }
  }
  return out;
}

test('the index lists the twenty mandatory scenarios, once each, in order', () => {
  const s = parse(readFileSync(INDEX, 'utf8'));
  assert.deepEqual(
    s.map((x) => x.n),
    Array.from({ length: 20 }, (_, i) => i + 1),
  );
});

test('every Done scenario names evidence, and only Done scenarios do', () => {
  for (const s of parse(readFileSync(INDEX, 'utf8'))) {
    if (s.status === 'Done') assert.ok(s.evidence.length > 0, `scenario ${s.n} is Done but names no test`);
    else assert.equal(s.evidence.length, 0, `scenario ${s.n} is ${s.status} but names tests`);
  }
});

test('every evidence line names a test file that exists and a test title that is in it', () => {
  const missing: string[] = [];
  for (const s of parse(readFileSync(INDEX, 'utf8')))
    for (const e of s.evidence) {
      const path = join(ROOT, e.file);
      if (!existsSync(path)) {
        missing.push(`${s.n}: ${e.file} does not exist`);
        continue;
      }
      // A test title is the first argument of test(...) or it(...): its text must start with what the index quotes.
      const src = readFileSync(path, 'utf8');
      const titles = [...src.matchAll(/\b(?:test|it)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]!.replace(/\\(['"`\\])/g, '$1'));
      if (!titles.some((t) => t.startsWith(e.title))) missing.push(`${s.n}: no test in ${e.file} starts with "${e.title}"`);
    }
  assert.deepEqual(missing, []);
});
