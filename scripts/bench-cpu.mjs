#!/usr/bin/env node
/**
 * CPU-only benchmark of the detachable layer. No network, no model, no API key.
 *
 *   npm run build && node scripts/bench-cpu.mjs [--tasks 2000] [--handbook 120] [--json out.json]
 *
 * Measures, on the machine that runs it: bundle verification + layer load, retrieval (BM25 + RRF + graph expansion),
 * executable decision-tree calls (the "local solve" path, i.e. zero model calls), and safety-gate checks, over the
 * Halvorsen scenario at the default knowledge-base size and at several larger sizes. Numbers are wall-clock on THIS
 * hardware and are printed together with the CPU model, core count and Node version; compare machines, not claims.
 */
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { writeFileSync } from 'node:fs';
import { buildGoldXo, generateEvalTasks } from '../packages/ab-eval/dist/index.js';
import { createCapabilityLayer } from '../packages/capability-layer/dist/index.js';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const N = Number(arg('tasks', '2000'));
const sizes = String(arg('sizes', `${arg('handbook', '120')},500,1000,2000`))
  .split(',')
  .map(Number);
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const ms = (x) => Math.round(x * 1000) / 1000;
const host = { family: 'claude', capabilities: ['chat', 'tool_use'] };

const tasks = generateEvalTasks(20260101).slice(0, 50);
const queries = Array.from({ length: N }, (_, i) => tasks[i % tasks.length].narrative);
const factsets = Array.from({ length: N }, (_, i) => tasks[i % tasks.length].statedFacts);

const rows = [];
for (const handbook of sizes) {
  const bundle = buildGoldXo({ handbook });
  const t0 = performance.now();
  const layer = createCapabilityLayer(bundle, { host });
  const loadMs = performance.now() - t0;
  const nodes = JSON.parse(new TextDecoder().decode(bundle.components.find((c) => c.kind === 'knowledge_graph').data)).nodes.length;

  const lat = (fn) => {
    const xs = [];
    for (let i = 0; i < N; i++) {
      const a = performance.now();
      fn(i);
      xs.push(performance.now() - a);
    }
    return xs;
  };
  for (let i = 0; i < 50; i++) layer.retrieve(queries[i], 9); // warm-up (JIT), excluded
  const ret = lat((i) => layer.retrieve(queries[i], 9));
  // guard: the measured call must be a real solve, not an error path
  const probe = layer.executeTool('evaluate_decision_tree', { facts: factsets[0] });
  if (probe.isError) throw new Error(`benchmark input does not solve: ${probe.content.slice(0, 200)}`);
  const tree = lat((i) => layer.executeTool('evaluate_decision_tree', { facts: factsets[i] }));
  const gate = lat((i) => layer.safetyGate({ input: queries[i], output: { decision: 'approve', payout_usd: 100 } }));
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  rows.push({
    knowledgeNodes: nodes,
    loadMs: ms(loadMs),
    retrieve: { p50: ms(pct(ret, 0.5)), p95: ms(pct(ret, 0.95)), p99: ms(pct(ret, 0.99)), perSec: Math.round(N / (sum(ret) / 1000)) },
    decisionTree: { p50: ms(pct(tree, 0.5)), p95: ms(pct(tree, 0.95)), perSec: Math.round(N / (sum(tree) / 1000)) },
    safetyGate: { p50: ms(pct(gate, 0.5)), p95: ms(pct(gate, 0.95)), perSec: Math.round(N / (sum(gate) / 1000)) },
  });
}
const env = {
  cpu: os.cpus()[0]?.model,
  cores: os.cpus().length,
  node: process.version,
  platform: `${os.platform()} ${os.arch()}`,
  memTotalMB: Math.round(os.totalmem() / 1048576),
  rssMB: Math.round(process.memoryUsage().rss / 1048576),
  iterationsPerMeasure: N,
  modelCalls: 0,
  networkCalls: 0,
};
const out = { env, results: rows };
if (arg('json')) writeFileSync(arg('json'), JSON.stringify(out, null, 2));
console.log(
  `CPU-only benchmark — ${env.cpu} × ${env.cores}, ${env.platform}, Node ${env.node}, ${N} iterations per measure, 0 model calls, 0 network calls\n`,
);
console.log('| KB nodes | load ms | retrieve p50 / p95 ms (per s) | tree p50 / p95 ms (per s) | safety gate p50 / p95 ms (per s) |');
console.log('|---|---|---|---|---|');
for (const r of rows)
  console.log(
    `| ${r.knowledgeNodes} | ${r.loadMs} | ${r.retrieve.p50} / ${r.retrieve.p95} (${r.retrieve.perSec}) | ${r.decisionTree.p50} / ${r.decisionTree.p95} (${r.decisionTree.perSec}) | ${r.safetyGate.p50} / ${r.safetyGate.p95} (${r.safetyGate.perSec}) |`,
  );
console.log(`\nprocess RSS at end: ${env.rssMB} MB of ${env.memTotalMB} MB`);
