/**
 * Unlabelled "wild run": compile every PDF in a folder and report where the compiler succeeds, degrades or fails.
 *
 *   node --import tsx examples/real-documents/wild-run.mts [dir=examples/real-documents/downloads] [--out report/]
 *
 * It needs no labels, so it works on any real document the moment it exists. It reports per document:
 * page accounting (blocked / partial pages), how many rules and capabilities came out and at what confidence,
 * how many decision-bearing sentences were left on the review list, and which of those carry a threshold or deadline
 * (the shapes most likely to be a missed rule). It also writes a CSV labelling sheet of the review list so a person
 * can mark real rules and turn a few documents into a labelled set (which is what makes accuracy measurable).
 * Counts here are NOT accuracy: only labelled documents give that.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSources } from '../../packages/compiler/src/pipeline/compile-sources.js';
import { parseStructuredCondition } from '../../packages/capability-contract/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--out');
const dir = resolve(positional[0] ?? join(here, 'downloads'));
const outIdx = process.argv.indexOf('--out');
const outDir = resolve(outIdx === -1 ? join(here, 'report') : process.argv[outIdx + 1]!);
if (!existsSync(dir)) {
  console.error(
    `No such folder: ${dir}\nRun \`sh examples/real-documents/fetch.sh\` first (needs open internet), or pass a folder of PDFs.`,
  );
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const files = readdirSync(dir)
  .filter((f) => f.toLowerCase().endsWith('.pdf'))
  .sort();
const csvCell = (s: string): string => `"${s.replace(/"/g, '""')}"`;
const sheet: string[] = ['document,review_sentence,cues,is_rule(y/n),condition,outcome'];
const rows: Record<string, unknown>[] = [];

for (const file of files) {
  const t0 = Date.now();
  const bytes = new Uint8Array(readFileSync(join(dir, file)));
  const row: Record<string, unknown> = { document: file };
  try {
    const result = await compileSources([{ kind: 'pdf', bytes, sourcePath: file }]);
    if (!result.ok) {
      row['compile'] = `FAILED ${result.error.code}: ${result.error.message.slice(0, 120)}`;
      rows.push(row);
      continue;
    }
    const v = result.value;
    const src = v.sources[0];
    const nodes = v.graph.allNodes();
    const rules = nodes.filter((n) => n.kind === 'heuristic' || n.kind === 'decision_node');
    const checkable = rules.filter((n) => {
      const p = n.properties as Record<string, unknown>;
      const c = String(p['condition'] ?? p['question'] ?? '');
      return c.length > 0 && parseStructuredCondition(c) !== undefined;
    });
    const caps = nodes.filter((n) => n.kind === 'capability');
    const band = (lo: number, hi: number) => caps.filter((n) => n.metadata.confidence >= lo && n.metadata.confidence < hi).length;
    const review = v.unclassified;
    const risky = review.filter((u) => u.cues.includes('threshold') || u.cues.includes('deadline') || u.cues.includes('limit'));
    Object.assign(row, {
      compile: 'ok',
      seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
      quality: src?.qualityState ?? 'n/a',
      pages: src?.coverage
        ? `${src.coverage.extractedPages + src.coverage.ocrPages}/${src.coverage.totalPages} read, ${src.coverage.unaccountedPages} unaccounted, ${src.coverage.excludedPages} excluded`
        : 'n/a',
      rules: rules.length,
      rulesWithCheckableCondition: checkable.length,
      capabilities: caps.length,
      capConfidence: { '<0.5': band(0, 0.5), '0.5-0.7': band(0.5, 0.7), '>=0.7': band(0.7, 1.01) },
      constraints: nodes.filter((n) => n.kind === 'constraint').length,
      reviewList: review.length,
      reviewWithThresholdDeadlineOrLimit: risky.length,
    });
    for (const u of review) sheet.push([csvCell(file), csvCell(u.text), csvCell(u.cues.join('|')), '', '', ''].join(','));
  } catch (e) {
    row['compile'] = `THREW ${(e as Error).message.slice(0, 120)}`;
  }
  rows.push(row);
}

writeFileSync(join(outDir, 'wild-run.json'), JSON.stringify(rows, null, 2) + '\n');
writeFileSync(join(outDir, 'review-labelling-sheet.csv'), sheet.join('\n') + '\n');
console.log(JSON.stringify(rows, null, 2));
const ok = rows.filter((r) => r['compile'] === 'ok').length;
console.log(`\n${ok}/${rows.length} documents compiled. Report: ${outDir}`);
