/**
 * Measures the current compiler against the SYNTHETIC development corpus (labels.json).
 * Not independent evidence (CRD-06): a regression/gap-finding tool, never a quality claim.
 *
 *   node --import tsx examples/insurance-dev-corpus/measure.mts [--json out.json]
 *
 * Per labelled rule, the strongest level reached:
 *   modeled   a rule-bearing graph node (decision/constraint/capability/heuristic) contains every key fact
 *   surfaced  not modeled, but the review list (`unclassified`) carries a sentence containing every key fact
 *   present   facts appear somewhere in the graph/review list but not as a rule or review item (e.g. only a concept)
 *   missed    the facts are nowhere in the compiler output
 * "surfaced" is honest visibility, not extraction: a human still has to model it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSources } from '../../packages/compiler/src/pipeline/compile-sources.js';

interface Rule {
  family: string;
  text: string;
  facts: string[];
  form: 'prose' | 'table';
}
interface Doc {
  id: string;
  file: string;
  layout: string;
  rules: Rule[];
}
type Level = 'modeled' | 'surfaced' | 'present' | 'missed';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'labels.json'), 'utf8')) as { documents: Doc[] };
const RULE_KINDS = new Set(['decision_node', 'constraint', 'capability', 'heuristic']);
const has = (haystack: string, facts: readonly string[]): boolean => facts.every((f) => haystack.toLowerCase().includes(f.toLowerCase()));

const rows: { doc: string; family: string; form: string; layout: string; level: Level; text: string }[] = [];
for (const doc of manifest.documents) {
  const bytes = new Uint8Array(readFileSync(join(here, doc.file)));
  const result = await compileSources([{ kind: 'pdf', bytes, sourcePath: doc.file }]);
  if (!result.ok) throw new Error(`${doc.id}: compile failed ${JSON.stringify(result.error)}`);
  const nodes = result.value.graph.allNodes();
  const ruleBlobs = nodes.filter((n) => RULE_KINDS.has(n.kind)).map((n) => JSON.stringify(n.properties));
  const anyBlob = nodes.map((n) => JSON.stringify(n.properties)).join('\n');
  const reviewBlobs = result.value.unclassified.map((u) => u.text);
  for (const rule of doc.rules) {
    const level: Level = ruleBlobs.some((b) => has(b, rule.facts))
      ? 'modeled'
      : reviewBlobs.some((b) => has(b, rule.facts))
        ? 'surfaced'
        : has(anyBlob + '\n' + reviewBlobs.join('\n'), rule.facts)
          ? 'present'
          : 'missed';
    rows.push({ doc: doc.id, family: rule.family, form: rule.form, layout: doc.layout, level, text: rule.text });
  }
}

const levels: Level[] = ['modeled', 'surfaced', 'present', 'missed'];
const tally = (pick: (r: (typeof rows)[number]) => string): void => {
  const groups = new Map<string, Record<Level, number>>();
  for (const r of rows) {
    const g = groups.get(pick(r)) ?? { modeled: 0, surfaced: 0, present: 0, missed: 0 };
    g[r.level]++;
    groups.set(pick(r), g);
  }
  for (const [k, g] of [...groups].sort()) {
    const n = levels.reduce((s, l) => s + g[l], 0);
    console.log(
      `  ${k.padEnd(28)} n=${String(n).padStart(2)}  modeled ${g.modeled}  surfaced ${g.surfaced}  present ${g.present}  missed ${g.missed}`,
    );
  }
};
console.log(`SYNTHETIC dev corpus — ${rows.length} labelled rules (not independent evidence)`);
console.log('by family:');
tally((r) => r.family);
console.log('by form:');
tally((r) => r.form);
console.log('by layout:');
tally((r) => r.layout);
const count = (l: Level): number => rows.filter((r) => r.level === l).length;
console.log(
  `TOTAL modeled ${count('modeled')}  surfaced ${count('surfaced')}  present ${count('present')}  missed ${count('missed')}  of ${rows.length}`,
);
const out = process.argv.indexOf('--json');
if (out > 0) writeFileSync(process.argv[out + 1]!, JSON.stringify(rows, null, 2) + '\n');
if (process.argv.includes('--list-gaps'))
  for (const r of rows.filter((x) => x.level !== 'modeled')) console.log(`[${r.level}] ${r.doc}: ${r.text}`);
