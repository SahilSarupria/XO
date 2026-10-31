#!/usr/bin/env node
// Retrieval accuracy as the knowledge base grows: recall@9 of the gold facts a task needs,
// on held-out task seeds, with N filler handbook nodes. Model-free, deterministic.
import { buildGoldXo, generateEvalTasks, scorePackage } from '../packages/ab-eval/dist/index.js';

const sizes = (process.argv[2] ?? '120,500,1000,2000').split(',').map(Number);
const seeds = [31337, 7];
const rows = [];
for (const n of sizes) {
  const bundle = buildGoldXo({ handbook: n });
  const per = seeds.map((s) => scorePackage(bundle, generateEvalTasks(s, 'variant'), 9));
  rows.push({
    handbook: n,
    nodes: per[0].nodes,
    recallAt9: per.map((p) => +p.recallAtK.toFixed(3)),
    coverage: per[0].coverage,
  });
}
console.log(JSON.stringify(rows, null, 1));
