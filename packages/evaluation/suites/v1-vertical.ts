import { buildSourceItems, type SourceDocument } from '@xo/connect';
import { tabularFromCsv, tabularFromXlsx } from '@xo/compiler';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  contentHash,
  loadV1Set,
  type LabelledSetInfo,
  type Measure,
  type Suite,
  type SuiteContext,
  type SuiteResult,
  type V1SetLabels,
} from '../src/index.js';

/** UW-13 (ADR 0053) — the V1 path XO actually runs: read the list, one item per row, pair each row with its document by name. */
interface Input {
  readonly labels: V1SetLabels;
  readonly format: 'csv' | 'xlsx';
  readonly csv?: string;
  readonly bytes?: Uint8Array;
  readonly documentNames: readonly string[];
  readonly digest: (name: string) => string;
}

function measureSet(input: Input): { measures: Measure[]; notes: string[] } {
  const { labels } = input;
  const t = input.format === 'csv' ? tabularFromCsv(input.csv ?? '') : tabularFromXlsx(input.bytes ?? new Uint8Array());
  const rs = t.ok ? t.value.recordSets[0] : undefined;
  const headers = rs?.columns.map((c) => c.header) ?? [];
  const rows = rs?.records.map((r) => rs.columns.map((c) => r.cells[c.column]?.raw ?? '')) ?? [];
  // The reader drops fully blank lines, so a record's position is not its row in the file: labels use the file's row (1 = under the header).
  const fileRow = (recordIndex: number): number => (rs?.records[recordIndex]?.row ?? 0) - (rs?.headerRow ?? 1);
  const recordOfFileRow = new Map(rows.map((_, i) => [fileRow(i), i]));
  const nameCol = headers.indexOf(labels.nameColumn);
  const emailCol = headers.indexOf(labels.emailColumn);

  // List reading: the labelled name and email cells, read exactly.
  let readRight = 0;
  for (const r of labels.rows) {
    const cells = rows[recordOfFileRow.get(r.row) ?? -1];
    if (cells === undefined) {
      // A row with no cells at all is dropped by the reader: right only when the labels say it is blank.
      if (r.name === '' && r.email === '') readRight++;
      continue;
    }
    if ((cells[nameCol] ?? '').trim() === r.name && (cells[emailCol] ?? '').trim() === r.email) readRight++;
  }

  const documents: SourceDocument[] = input.documentNames.map((name) => ({
    key: name,
    name,
    digestSha256: input.digest(name),
    contentType: 'application/pdf',
  }));
  const built = buildSourceItems({ headers, rows, pairing: { nameColumn: labels.nameColumn, documents } });
  const rowTruth = new Map(labels.rows.map((r) => [r.row, r.expected]));
  const docTruth = new Map(labels.documentsExpected.map((d) => [d.name, d.expected]));

  let paired = 0;
  let pairedRight = 0;
  let wrong = 0;
  const itemRows = built.rows.map((n) => fileRow(n - 1));
  built.items.forEach((item, i) => {
    paired++;
    const row = itemRows[i]!;
    const truth = rowTruth.get(row);
    const got = item['document_name'];
    if (truth !== undefined && 'document' in truth && truth.document === got) pairedRight++;
    else {
      const owner = got === undefined ? undefined : docTruth.get(got);
      if (owner !== undefined && 'row' in owner && owner.row !== row) wrong++;
    }
  });
  const withDoc = labels.rows.filter((r) => 'document' in r.expected);
  const recallRight = withDoc.filter((r) => {
    const at = itemRows.indexOf(r.row);
    if (at < 0) return false;
    const item = built.items[at]!;
    return 'document' in r.expected && item['document_name'] === r.expected.document;
  }).length;

  const excludedRowTruth = labels.rows.filter((r) => 'excluded' in r.expected);
  const rowReasons = new Map(built.excludedRows.map((e) => [fileRow(e.row - 1), e.reason]));
  const rowRight = excludedRowTruth.filter(
    (r) =>
      'excluded' in r.expected &&
      (rowReasons.get(r.row) === r.expected.excluded || (r.expected.excluded === 'blank' && !recordOfFileRow.has(r.row))),
  ).length;
  const excludedDocTruth = labels.documentsExpected.filter((d) => 'excluded' in d.expected);
  const docReasons = new Map(built.excludedDocuments.map((e) => [e.name, e.reason]));
  const docRight = excludedDocTruth.filter((d) => 'excluded' in d.expected && docReasons.get(d.name) === d.expected.excluded).length;

  const ratio = (id: string, title: string, n: number, d: number, better: 'higher' | 'lower' = 'higher'): Measure => ({
    id: `V1/${id}`,
    title,
    unit: 'ratio',
    better,
    value: d === 0 ? null : n / d,
    numerator: n,
    denominator: d,
  });
  return {
    measures: [
      ratio('list-reading', 'Labelled rows whose name and email cells are read exactly', readRight, labels.rows.length),
      ratio('pairing-precision', 'Items paired with the labelled document', pairedRight, paired),
      ratio('pairing-recall', 'Rows labelled with a document that are paired with it', recallRight, withDoc.length),
      {
        id: 'V1/wrong-pairings',
        title: 'Items paired with a document labelled for someone else',
        unit: 'count',
        better: 'lower',
        value: wrong,
      },
      ratio('row-exclusion-accuracy', 'Rows left out with the labelled reason', rowRight, excludedRowTruth.length),
      ratio('document-exclusion-accuracy', 'Documents listed with the labelled reason', docRight, excludedDocTruth.length),
      ratio('loose-share', 'Items paired only loosely (another spelling, short form or initials)', built.looseRows.length, paired, 'lower'),
    ],
    notes: [
      `${paired} items paired of ${labels.rows.length} rows; ${built.excludedRows.length} rows and ${built.excludedDocuments.length} documents left out.`,
    ],
  };
}

const LIMITS = [
  'The pairing reads file names, never a document’s content (ADR 0039); whether a document is the right kind is measured by `document-kinds`.',
  'A synthetic set’s labels follow from how it was built, with the matcher’s tiers in view (`labelledWith: construction`): it shows the matcher does what it was designed to do, not accuracy on a customer’s files.',
  'A fully blank line is dropped by the table reader before pairing, so a blank row counts as left out when it does not appear as a record.',
  'Thresholds are proposals until the owner ratifies them (UAC-19); `wrong-pairings` max 0 restates the vertical’s rule and should be ratified first.',
];

function rename(measures: Measure[], suite: string): Measure[] {
  return measures.map((m) => ({ ...m, id: m.id.replace('V1/', `${suite}/`) }));
}

const syntheticPath = fileURLToPath(new URL('../sets/v1-vertical-synthetic.json', import.meta.url));

export function syntheticSet(): { labels: V1SetLabels; listCsv: string; documentNames: string[] } {
  return JSON.parse(readFileSync(syntheticPath, 'utf8')) as { labels: V1SetLabels; listCsv: string; documentNames: string[] };
}

export const v1VerticalSuite: Suite = {
  id: 'v1-vertical',
  title: 'The V1 vertical: reading the client list and pairing each row with its document',
  async run(): Promise<SuiteResult> {
    const set = syntheticSet();
    const { measures, notes } = measureSet({
      labels: set.labels,
      format: 'csv',
      csv: set.listCsv,
      documentNames: set.documentNames,
      digest: (n) => createHash('sha256').update(n).digest('hex'),
    });
    const info: LabelledSetInfo = {
      id: 'v1-vertical-synthetic',
      version: '1',
      provenance: 'synthetic',
      cases: set.labels.rows.length,
      contentHash: contentHash(set),
      description:
        'Seeded synthetic V1 set (packages/evaluation/sets/generate-v1-synthetic.ts, seed 20261123): exact, variant, reordered, short-form, initials, missing, repeated and blank rows, and documents naming no client. Labels by construction.',
    };
    return {
      suite: 'v1-vertical',
      title: 'The V1 vertical: reading the client list and pairing each row with its document',
      uac: ['UAC-5', 'UAC-19'],
      mode: 'deterministic',
      sets: [info],
      measures: rename(measures, 'v1-vertical'),
      notes,
      limits: LIMITS,
    };
  },
  async runExternal(context: SuiteContext): Promise<SuiteResult | undefined> {
    const dir = context.externalSets['v1-vertical'];
    if (dir === undefined) return undefined;
    const loaded = await loadV1Set(dir, context.repoRoot);
    const isXlsx = loaded.labels.list.toLowerCase().endsWith('.xlsx');
    const { measures } = measureSet({
      labels: loaded.labels,
      format: isXlsx ? 'xlsx' : 'csv',
      ...(isXlsx ? { bytes: loaded.listBytes } : { csv: loaded.listBytes.toString('utf8') }),
      documentNames: loaded.documentNames,
      digest: (n) => createHash('sha256').update(n).digest('hex'),
    });
    return {
      suite: 'v1-vertical-external',
      title: 'The V1 vertical on a labelled set kept outside the repository',
      uac: ['UAC-5', 'UAC-19'],
      mode: 'deterministic',
      sets: [
        {
          id: 'v1-external-set',
          version: '1',
          provenance: loaded.labels.provenance,
          cases: loaded.labels.rows.length,
          contentHash: loaded.hash,
          description: `An external set read where it lies: ${loaded.files} files, ${loaded.bytes} bytes, labelled by ${loaded.labels.labelledBy} (${loaded.labels.labelledWith}). Only its hash, sizes and the measures are reported.`,
        },
      ],
      measures: rename(measures, 'v1-vertical-external'),
      notes: [`${loaded.labels.rows.length} rows and ${loaded.documentNames.length} documents measured.`],
      limits: LIMITS,
    };
  },
};
