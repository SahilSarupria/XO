// Long-running fuzz campaign for the PDF reader (nightly-style). Usage:
//   node --import tsx scripts/fuzz-pdf.ts [startSeed=1] [seeds=10] [iterationsPerSeed=2000]
// Exits non-zero and prints every failing (seed, iteration, corpus, problem) so a failure is reproducible with
// fuzzLoader(seed, iteration + 1).
import { fuzzLoader, fuzzParsers } from '../packages/compiler/test/fuzz/pdf-fuzz.js';

const start = Number(process.argv[2] ?? 1);
const seeds = Number(process.argv[3] ?? 10);
const iterations = Number(process.argv[4] ?? 2000);
let total = 0;
const t0 = Date.now();
for (let s = start; s < start + seeds; s++) {
  const failures = [...fuzzLoader(s, iterations), ...fuzzParsers(s, iterations)];
  total += failures.length;
  for (const f of failures) console.error(JSON.stringify(f));
  console.log(`seed ${s}: ${failures.length} failures (${iterations} loader + ${iterations} parser inputs)`);
}
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${total} failures`);
process.exit(total === 0 ? 0 : 1);
