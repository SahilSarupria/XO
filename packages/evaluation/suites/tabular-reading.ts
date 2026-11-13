import { tabularFromCsv, tabularFromXlsx } from '@xo/compiler';
import { contentHash, type Measure, type Suite, type SuiteResult } from '../src/index.js';
import { labelledCorpus } from '../../compiler/test/tabular/labelled-corpus.js';

/** UW-3's labelled table corpus, measured through the harness (the compiler's own test pins the same numbers). */
export const tabularReadingSuite: Suite = {
  id: 'tabular-reading',
  title: 'Reading workbooks and CSV files',
  async run(): Promise<SuiteResult> {
    const cases = labelledCorpus();
    let headerRight = 0;
    let recordsRight = 0;
    let columns = 0;
    let typeRight = 0;
    let designed = 0;
    let designedRight = 0;
    const misses: string[] = [];
    for (const c of cases) {
      const t = c.format === 'csv' ? tabularFromCsv(c.bytesOrText as string) : tabularFromXlsx(c.bytesOrText as Uint8Array);
      if (!t.ok) {
        misses.push(`${c.id}: not read (${t.error.code})`);
        columns += c.types.length;
        continue;
      }
      const set = t.value.recordSets[0]!;
      const header = (set.headerRow ?? null) === c.headerRow;
      const types = set.columns.map((col) => col.declaredType);
      const right = c.types.filter((ty, i) => types[i] === ty).length;
      headerRight += header ? 1 : 0;
      recordsRight += set.records.length === c.records ? 1 : 0;
      columns += c.types.length;
      typeRight += header ? right : 0; // a wrong header shifts every column: its types do not count as right
      if (c.category !== 'known-hard') {
        designed++;
        designedRight += header && right === c.types.length ? 1 : 0;
      }
      if (!header || right !== c.types.length || set.records.length !== c.records) misses.push(`${c.id} (${c.category})`);
    }
    const ratio = (id: string, title: string, n: number, d: number): Measure => ({
      id: `tabular-reading/${id}`,
      title,
      unit: 'ratio',
      better: 'higher',
      value: d === 0 ? null : n / d,
      numerator: n,
      denominator: d,
    });
    return {
      suite: 'tabular-reading',
      title: 'Reading workbooks and CSV files',
      uac: ['UAC-19'],
      mode: 'deterministic',
      sets: [
        {
          id: 'tabular-labelled-corpus',
          version: '1',
          provenance: 'synthetic',
          cases: cases.length,
          contentHash: contentHash(cases.map((c) => [c.id, c.format, c.bytesOrText, c.headerRow, c.types, c.records])),
          description:
            'Seeded synthetic tables (packages/compiler/test/tabular/labelled-corpus.ts): clean, titled, typed edge cases, headerless and known-hard.',
        },
      ],
      measures: [
        ratio('header-accuracy', 'Header row found', headerRight, cases.length),
        ratio('column-type-accuracy', 'Column type right', typeRight, columns),
        ratio('record-count-accuracy', 'Record count right', recordsRight, cases.length),
        ratio('designed-cases-exact', 'Tables read exactly, excluding the known-hard category', designedRight, designed),
      ],
      notes: misses.length > 0 ? [`Missed: ${misses.join(', ')}.`] : [],
      limits: [
        'Synthetic tables generated from templates. Real customer workbooks (UW-13 real sets) are not measured yet.',
        'Headerless lists of plain text are taken as having a header; no reader can tell "Asha, Pune" from "Name, City" without knowing names.',
      ],
    };
  },
};
