#!/usr/bin/env node
// UW-13 — the evaluation harness.
//
//   npm run eval                          every suite; prints the report
//   npm run eval -- --fast                skip slow suites (they spawn processes)
//   npm run eval -- --suite a,b           only these suites
//   npm run eval -- --write               also write evaluation/report.json and evaluation/REPORT.md
//   npm run eval -- --check               exit 1 if a RATIFIED threshold fails or the thresholds/register are invalid
//   npm run eval -- --commit <sha>        record the commit in the report
//
// Thresholds (evaluation/thresholds.json) are proposals until the owner ratifies them; the register (evaluation/register.json) is
// R1 to R18 with owners and status. Both are owner-controlled data, not code.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildEvaluationReport, renderReportMarkdown, validateThresholds, type RegisterItem, type Threshold } from '../src/index.js';
import { SUITES } from './index.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const { values } = parseArgs({
  options: {
    suite: { type: 'string' },
    fast: { type: 'boolean', default: false },
    write: { type: 'boolean', default: false },
    check: { type: 'boolean', default: false },
    commit: { type: 'string' },
  },
});

const thresholds = (JSON.parse(readFileSync(`${ROOT}evaluation/thresholds.json`, 'utf8')) as { thresholds: Threshold[] }).thresholds;
const register = (JSON.parse(readFileSync(`${ROOT}evaluation/register.json`, 'utf8')) as { items: RegisterItem[] }).items;
const wanted = values.suite?.split(',').map((s) => s.trim());
const unknown = (wanted ?? []).filter((w) => !SUITES.some((s) => s.id === w));
if (unknown.length > 0) {
  process.stderr.write(`unknown suite(s): ${unknown.join(', ')}; available: ${SUITES.map((s) => s.id).join(', ')}\n`);
  process.exit(2);
}
const chosen = SUITES.filter((s) => (wanted === undefined || wanted.includes(s.id)) && !(values.fast && s.slow === true));
const results = [];
for (const s of chosen) {
  process.stderr.write(`running ${s.id}…\n`);
  results.push(await s.run());
}
const report = buildEvaluationReport({
  results,
  thresholds,
  thresholdProblems: validateThresholds(thresholds),
  register,
  run: { ...(values.commit !== undefined ? { commit: values.commit } : {}) },
});
const markdown = renderReportMarkdown(report);
if (values.write) {
  mkdirSync(`${ROOT}evaluation`, { recursive: true });
  writeFileSync(`${ROOT}evaluation/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${ROOT}evaluation/REPORT.md`, markdown);
  process.stderr.write('wrote evaluation/report.json and evaluation/REPORT.md\n');
}
process.stdout.write(markdown);
if (values.check && (report.verdict.failedRatified.length > 0 || report.verdict.problems.length > 0)) process.exit(1);
