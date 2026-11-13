import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  compileSources,
  createPdfiumReaderTier,
  createTesseractTier,
  isTesseractAvailable,
  shutdownTesseract,
  type PageTier,
} from '@xo/compiler';
import { contentHash, type Measure, type Suite, type SuiteResult } from '../src/index.js';
import { scoreDocument, type FailureMode, type LabelledItem, type OutputNode, type Score } from './real-documents-score.js';

/**
 * UW-3c — how XO reads real documents it was not written against.
 *
 * The set (sets/real-documents.json) holds fourteen public-domain / CC0 documents written by US federal teams (18F, CISA, USDS), each
 * read in the formats it travels in: the original (Word, Markdown, a PDF form), a web page, a Word file, a PDF export, a Word HTML
 * export and a printed-and-scanned copy. Every sentence or list item carries its expected reading, labelled from the source text.
 * The held-out and blind documents were labelled before XO was run on them and were never used to tune the compiler; the dev documents were.
 * All three splits are reported, separately. PDFs are read with the instance's default page recovery (a second PDF reader, then local OCR).
 */

export type Split = 'dev' | 'held-out' | 'blind';

interface CaseFormat {
  readonly format: 'markdown' | 'html' | 'docx' | 'pdf' | 'scan' | 'word-html';
  readonly path: string;
  readonly sha256: string;
}
interface LabelledDocument {
  readonly id: string;
  readonly split: Split;
  readonly title: string;
  readonly source: Readonly<Record<string, string>>;
  readonly formats: readonly CaseFormat[];
  readonly items: readonly LabelledItem[];
}
interface RealDocumentSet {
  readonly id: string;
  readonly version: string;
  readonly provenance: 'real';
  readonly description: string;
  readonly policy: readonly string[];
  readonly documents: readonly LabelledDocument[];
}

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const NORMATIVE = new Set(['constraint', 'heuristic', 'decision_node', 'escalation_rule', 'risk_policy']);

export function loadRealDocumentSet(): RealDocumentSet {
  return JSON.parse(readFileSync(fileURLToPath(new URL('../sets/real-documents.json', import.meta.url)), 'utf8')) as RealDocumentSet;
}

function inputFor(f: CaseFormat): unknown {
  const abs = `${ROOT}${f.path}`;
  const name = f.path.split('/').pop()!;
  if (f.format === 'markdown') return { kind: 'document', text: readFileSync(abs, 'utf8'), sourcePath: name };
  if (f.format === 'html' || f.format === 'word-html') return { kind: 'html', html: readFileSync(abs, 'utf8'), sourcePath: name };
  if (f.format === 'docx') return { kind: 'docx', bytes: new Uint8Array(readFileSync(abs)), sourcePath: name };
  return { kind: 'pdf', bytes: new Uint8Array(readFileSync(abs)), sourcePath: name };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export interface CaseRun {
  readonly documentId: string;
  readonly split: Split;
  readonly format: CaseFormat['format'];
  readonly compiled: boolean;
  readonly refusal?: string;
  readonly score?: Score;
  readonly outputs?: readonly OutputNode[];
}

/** Compile one document in one format and score it. A refusal is a result (fail closed), scored as every item missed-reported. */
export async function runCase(doc: LabelledDocument, f: CaseFormat, tiers: readonly PageTier[]): Promise<CaseRun> {
  const input = inputFor(f);
  const r = await compileSources([input], {
    now: () => '2026-01-01T00:00:00.000Z',
    ...(f.format === 'pdf' || f.format === 'scan' ? { pageTiers: tiers } : {}),
  });
  if (!r.ok) {
    const items = doc.items;
    return {
      documentId: doc.id,
      split: doc.split,
      format: f.format,
      compiled: false,
      refusal: r.error.message,
      score: scoreDocument({ items, nodes: [], sequence: [], reported: items.flatMap((i) => i.phrases) }),
    };
  }
  const v = r.value;
  const outputs: OutputNode[] = v.graph
    .allNodes()
    .filter((n) => n.kind === 'capability' || NORMATIVE.has(n.kind))
    .map((n) => {
      const p = n.properties as Record<string, unknown>;
      const custom = (n.metadata as { custom?: Record<string, unknown> }).custom ?? {};
      const joined = (a: string | undefined, b: string | undefined): string =>
        a !== undefined && b !== undefined && a !== b ? `${a} ${b}` : (a ?? b ?? '');
      const primary =
        n.kind === 'capability'
          ? (str(p['name']) ?? '')
          : n.kind === 'constraint'
            ? (str(p['rule']) ?? '')
            : n.kind === 'heuristic'
              ? joined(str(p['condition']), str(p['action']))
              : n.kind === 'decision_node'
                ? joined(str(p['question']), str(p['outcome']))
                : n.kind === 'escalation_rule'
                  ? joined(str(p['triggerCondition']), str(p['escalationTarget']))
                  : (str(p['domain']) ?? '');
      return {
        id: n.id,
        kind: n.kind,
        primary,
        ...(str(p['modality']) !== undefined ? { modality: str(p['modality'])! } : {}),
        ...(str(p['checkbox']) !== undefined ? { checkbox: str(p['checkbox'])! } : {}),
        flagged: Object.values(custom).some((x) => x === 'possible-extraction-error'),
      };
    });
  const sequence = v.graph
    .allEdges()
    .filter((e) => e.kind === 'custom:sequence')
    .map((e) => ({ from: e.fromId, to: e.toId }));
  const reported = [...v.unclassified.map((u) => u.text), ...(v.reviewQueue?.items ?? []).map((i) => `${i.summary} ${i.detail}`)];
  return {
    documentId: doc.id,
    split: doc.split,
    format: f.format,
    compiled: true,
    score: scoreDocument({ items: doc.items, nodes: outputs, sequence, reported }),
    outputs,
  };
}

export async function runRealDocuments(filter?: (doc: LabelledDocument, f: CaseFormat) => boolean): Promise<CaseRun[]> {
  const set = loadRealDocumentSet();
  const tiers: PageTier[] = (await isTesseractAvailable())
    ? [createPdfiumReaderTier(), createTesseractTier({ workers: 2 })]
    : [createPdfiumReaderTier()];
  const runs: CaseRun[] = [];
  try {
    for (const doc of set.documents)
      for (const f of doc.formats) if (filter === undefined || filter(doc, f)) runs.push(await runCase(doc, f, tiers));
  } finally {
    await shutdownTesseract();
  }
  return runs;
}

const ratio = (n: number, d: number): number | null => (d === 0 ? null : n / d);

function sum(runs: readonly CaseRun[], pick: (s: Score) => number): number {
  return runs.reduce((acc, r) => acc + (r.score ? pick(r.score) : 0), 0);
}

function measuresFor(split: Split, runs: readonly CaseRun[]): Measure[] {
  const id = (m: string) => `real-documents/${split}/${m}`;
  const m = (key: string, title: string, num: number, den: number): Measure => ({
    id: id(key),
    title: `${title} (${split})`,
    unit: 'ratio',
    better: 'higher',
    value: ratio(num, den),
    numerator: num,
    denominator: den,
  });
  const count = (key: string, title: string, n: number): Measure => ({
    id: id(key),
    title: `${title} (${split})`,
    unit: 'count',
    better: 'lower',
    value: n,
    numerator: n,
  });
  const fails = (mode: FailureMode) => runs.reduce((a, r) => a + (r.score?.failures[mode].length ?? 0), 0);
  return [
    m(
      'items-read',
      'Expected items read at all',
      sum(runs, (s) => s.found),
      sum(runs, (s) => s.expected),
    ),
    m(
      'items-read-right',
      'Expected items read as the right kind',
      sum(runs, (s) => s.kindCorrect),
      sum(runs, (s) => s.expected),
    ),
    m(
      'modality',
      'Modality right where the wording is unambiguous',
      sum(runs, (s) => s.modalityCorrect),
      sum(runs, (s) => s.modalityChecked),
    ),
    m(
      'checkbox',
      'Check-box state kept',
      sum(runs, (s) => s.checkboxCorrect),
      sum(runs, (s) => s.checkboxChecked),
    ),
    m(
      'order',
      'Procedure order kept (consecutive step pairs)',
      sum(runs, (s) => s.orderKept),
      sum(runs, (s) => s.orderPairs),
    ),
    m(
      'output-precision',
      'Output that is a right reading of something in the document',
      sum(runs, (s) => s.correctOutput),
      sum(runs, (s) => s.judgedOutput),
    ),
    count('missed-silently', 'Expected items lost without any report', fails('missed-silently')),
    count('mixed-text', 'Outputs built from text of two items', fails('mixed-text')),
    count('spurious', 'Outputs built from questions, labels, placeholders or descriptions', fails('spurious-from-non-content')),
  ];
}

const FORMAT_LABEL: Readonly<Record<CaseFormat['format'], string>> = {
  markdown: 'Markdown',
  html: 'web page',
  docx: 'Word',
  pdf: 'PDF',
  scan: 'scanned PDF',
  'word-html': 'Word HTML export',
};

export function summarizeByFormat(runs: readonly CaseRun[]): string[] {
  const formats = [...new Set(runs.map((r) => r.format))];
  return formats.map((f) => {
    const rs = runs.filter((r) => r.format === f);
    const read = sum(rs, (s) => s.kindCorrect);
    const exp = sum(rs, (s) => s.expected);
    const ok = sum(rs, (s) => s.correctOutput);
    const judged = sum(rs, (s) => s.judgedOutput);
    return `${FORMAT_LABEL[f]}: ${read}/${exp} items read right, ${ok}/${judged} outputs right${rs.some((r) => !r.compiled) ? `, ${rs.filter((r) => !r.compiled).length} refused` : ''}`;
  });
}

export const realDocumentsSuite: Suite = {
  id: 'real-documents',
  title: 'Reading real documents XO was not written against',
  slow: true,
  async run(): Promise<SuiteResult> {
    const set = loadRealDocumentSet();
    const runs = await runRealDocuments();
    const by = (split: Split) => runs.filter((r) => r.split === split);
    const modes: FailureMode[] = [
      'missed-silently',
      'missed-reported',
      'wrong-kind',
      'wrong-modality',
      'wrong-checkbox',
      'order-lost',
      'duplicate',
      'mixed-text',
      'spurious-from-non-content',
      'unmatched-output',
    ];
    const modeLine = (rs: readonly CaseRun[]) =>
      modes
        .map((md) => [md, rs.reduce((a, r) => a + (r.score?.failures[md].length ?? 0), 0)] as const)
        .filter(([, n]) => n > 0)
        .map(([md, n]) => `${md} ${n}`)
        .join(', ') || 'none';
    const splits: Split[] = ['blind', 'held-out', 'dev'];
    return {
      suite: 'real-documents',
      title: 'Reading real documents XO was not written against',
      uac: ['UAC-19'],
      mode: 'deterministic',
      sets: [
        {
          id: set.id,
          version: set.version,
          provenance: set.provenance,
          cases: runs.length,
          contentHash: contentHash({ documents: set.documents, policy: set.policy }),
          description: set.description,
        },
      ],
      measures: splits.flatMap((sp) => measuresFor(sp, by(sp))),
      notes: splits.flatMap((sp) => [
        `${sp} by format: ${summarizeByFormat(by(sp)).join('; ')}.`,
        `${sp} failure modes: ${modeLine(by(sp))}.`,
      ]),
      limits: [
        "Fourteen documents from three US federal teams, all English and all about software delivery or administration. They are real, but they are not a customer's documents; the pilot set is still owed (R12).",
        "Labels are one reader's reading under a written policy; ambiguous text is labelled neutral rather than forced either way.",
        'Format variants other than the originals were produced by pandoc and LibreOffice, and the scans by rasterising and degrading a PDF export (examples/real-corpus/build.sh). A phone photo of a crumpled page is harder than these scans.',
        'Matching is by distinctive phrase with OCR tolerance; a reading with the right words in the wrong structure can still match.',
      ],
    };
  },
};
