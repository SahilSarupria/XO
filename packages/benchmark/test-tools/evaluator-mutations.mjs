#!/usr/bin/env node
// P0.9C Step 8 — EVALUATOR-INTERNAL mutation run. TEST-ONLY tooling: never imported by the library or by the product.
//
// For each mutation: apply one textual change to a benchmark source file, run the benchmark test suite, record whether it FAILED (mutation killed =
// the suite caught a lying evaluator) or PASSED (survived = a gap), and ALWAYS restore the file byte-for-byte (verified by sha256, even on error).
//
//   node test-tools/evaluator-mutations.mjs            # run all
//   node test-tools/evaluator-mutations.mjs --list     # list only
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const PKG = fileURLToPath(new URL('../', import.meta.url));
const sha = (s) => createHash('sha256').update(s).digest('hex');

export const MUTATIONS = [
  { id: 'E01', file: 'src/metrics.ts', from: 'if (pass) this.numerator += 1;', to: 'if (pass) this.numerator += 2;', what: 'numerator + 1 (a passing assertion counts twice)' },
  { id: 'E02', file: 'src/metrics.ts', from: 'this.denominator += 1;\n    if (pass)', to: 'this.denominator += 0;\n    if (pass)', what: 'denominator - 1 (an assertion never enters the denominator)' },
  { id: 'E03', file: 'src/metrics.ts', from: 'if (pass) this.numerator += 1;', to: 'if (!pass) this.numerator += 1;', what: 'pass/fail inverted' },
  { id: 'E04', file: 'src/metrics.ts', from: 'if (denominator === 0) return null;', to: 'if (denominator === 0) return 1;', what: '0/0 reported as 100%' },
  { id: 'E05', file: 'src/metrics.ts', from: 'measured: this.denominator > 0,', to: 'measured: this.denominator >= 0,', what: 'an empty metric reported as measured' },
  { id: 'E06', file: 'src/metrics.ts', from: 'Math.round((numerator / denominator) * 1e6) / 1e6', to: 'Math.round((numerator / (denominator + 1)) * 1e6) / 1e6', what: 'ratio computed over denominator + 1' },
  { id: 'E07', file: 'src/metrics.ts', from: 'builder.add(metric.numerator, metric.denominator);', to: 'builder.add(metric.numerator / Math.max(metric.denominator, 1), 1);', what: 'micro-average replaced by a macro-average of per-case ratios' },
  { id: 'E08', file: 'src/report.ts', from: "new Set<MetricId>(['observedSourceRefCoverage', 'producerAttributionCoverage', 'provenanceChainCoverage', 'executionProvenanceAgreement', 'crossPathConsistency'])", to: "new Set<MetricId>([])", what: 'descriptive metrics counted toward `measured`' },
  { id: 'E09', file: 'src/compare.ts', from: "if (presence !== 'both') verdict = 'unchanged';", to: "if (false as boolean) verdict = 'unchanged';", what: 'a metric with no counterpart diffed against nothing' },
  { id: 'E10', file: 'src/baseline.ts', from: "if (versionChanged) add({ id: 'evaluation_version'", to: "if (false as boolean) add({ id: 'evaluation_version'", what: 'evaluation-version difference silently dropped' },
  { id: 'E11', file: 'src/baseline.ts', from: ": diffs.every((d) => d.class === 'expected_metric_addition' || d.class === 'representation_only') ? 'compatible'", to: ": diffs.every((d) => d.class !== 'semantic_regression') ? 'compatible'", what: 'any explained difference declared "compatible" (no review obligation)' },
  { id: 'E12', file: 'src/cross-path.ts', from: "if (live.graphIdentity !== other.graphIdentity) out.push", to: "if (false as boolean) out.push", what: 'graph hash compared across a lowered and an unlowered graph' },
];

if (process.argv.includes('--list')) { for (const m of MUTATIONS) console.log(`${m.id}  ${m.file}  ${m.what}`); process.exit(0); }

const results = [];
for (const m of MUTATIONS) {
  const path = join(PKG, m.file);
  const original = readFileSync(path, 'utf8');
  if (!original.includes(m.from)) { results.push({ ...m, outcome: 'NOT_APPLIED (pattern missing)' }); continue; }
  try {
    writeFileSync(path, original.replace(m.from, m.to));
    const r = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'test/*.test.ts'], { cwd: PKG, encoding: 'utf8', shell: false, env: process.env, maxBuffer: 1 << 28 });
    const out = r.stdout + r.stderr;
    const fail = /^# fail (\d+)/m.exec(out);
    const failed = fail ? Number(fail[1]) : -1;
    results.push({ ...m, failed, outcome: failed > 0 || r.status !== 0 ? 'KILLED' : 'SURVIVED' });
  } finally {
    writeFileSync(path, original);
    if (sha(readFileSync(path, 'utf8')) !== sha(original)) { console.error(`RESTORE FAILED for ${m.file}`); process.exit(2); }
  }
}
for (const r of results) console.log(`${r.id}  ${String(r.outcome).padEnd(9)} failing tests ${String(r.failed ?? '-').padStart(3)}  ${r.file}  ${r.what}`);
const killed = results.filter((r) => r.outcome === 'KILLED').length;
console.log(`\nevaluator-internal mutations: ${killed}/${results.length} killed; survivors: ${results.filter((r) => r.outcome !== 'KILLED').map((r) => r.id).join(', ') || 'none'}`);
