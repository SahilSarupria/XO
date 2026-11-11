import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PdfForge, pdfLiteral } from './pdf-forge.js';
import { buildEncrypted, type EncryptionSpec } from './pdf-encrypt.js';

/**
 * Failure-taxonomy cases. Every case is generated deterministically from code (no clock, no randomness) and carries
 * its own ground truth, so extraction quality is measured against known text. These documents are SYNTHETIC: they are
 * regression guards for known failure classes, never evidence of accuracy on real insurance documents.
 */
export type Category =
  'control' | 'layout' | 'table' | 'form' | 'script' | 'font' | 'scan' | 'encrypted' | 'scale' | 'corrupt' | 'inert' | 'bomb';

export interface PageTruth {
  /** Lines in correct reading order. For a table, cells row by row. */
  readonly lines: readonly string[];
}

export type Expectation =
  /** The text layer can and should read this. */
  | 'readable'
  /** There is no usable text layer: the page must be flagged for recovery (never returned as confident text). */
  | 'needs_recovery'
  /** The document may legitimately fail to open or lose pages; it must fail loudly and boundedly. */
  | 'bounded_failure';

export interface TaxonomyCase {
  readonly id: string;
  readonly category: Category;
  readonly description: string;
  readonly expectation: Expectation;
  readonly build: () => Uint8Array;
  /** Ground truth per page (1-based order). Absent for cases with no readable text by design. */
  readonly truth?: readonly PageTruth[];
  /** Words that must NOT appear in any extracted text (inert embedded content). */
  readonly forbiddenWords?: readonly string[];
  /** Cases large enough that the suite runs them once, not repeatedly. */
  readonly heavy?: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------------------------------------------------

const SENTENCES = [
  'The Insured must notify the Insurer within 7 days of becoming aware of the loss.',
  'If the claim assessment amount exceeds 10000, then deny the claim.',
  'The Insurer shall pay the sum insured less the applicable excess.',
  'Theft is excluded unless there is evidence of forced entry.',
  'Cover under this section is limited to 50000 per event.',
  'The policy period is twelve months from the effective date.',
  'Flood damage is covered only where the premises are located above the flood line.',
  'A waiting period of 30 days applies to all new claims.',
  'The Insured shall take all reasonable steps to prevent further loss.',
  'No claim will be paid where the loss was caused by wear and tear.',
];

const line = (i: number): string => SENTENCES[i % SENTENCES.length]!;
const lines = (start: number, n: number): string[] => Array.from({ length: n }, (_, k) => line(start + k));

interface Doc {
  readonly forge: PdfForge;
  readonly catalog: number;
  readonly pagesNode: number;
  readonly font: number;
  readonly pageNums: number[];
}

/** Starts a document with a catalog, a page-tree node and the standard Helvetica font as /F1. */
function startDoc(): Doc {
  const forge = new PdfForge();
  const catalog = forge.alloc();
  const pagesNode = forge.alloc();
  const font = forge.alloc();
  forge.obj(font, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  return { forge, catalog, pagesNode, font, pageNums: [] };
}

interface PageOptions {
  readonly rotate?: number;
  readonly mediaBox?: string;
  readonly extraResources?: string;
  readonly extraDict?: string;
}

function addPage(doc: Doc, content: string, opts: PageOptions = {}): number {
  const page = doc.forge.alloc();
  const cs = doc.forge.alloc();
  doc.pageNums.push(page);
  doc.forge.obj(
    page,
    `<< /Type /Page /Parent ${doc.pagesNode} 0 R /Contents ${cs} 0 R ${opts.rotate !== undefined ? `/Rotate ${opts.rotate} ` : ''}` +
      `${opts.mediaBox !== undefined ? `/MediaBox ${opts.mediaBox} ` : ''}/Resources << /Font << /F1 ${doc.font} 0 R ${opts.extraResources ?? ''}>> >> ${opts.extraDict ?? ''}>>`,
  );
  doc.forge.stream(cs, content, 'flate');
  return page;
}

function finishDoc(
  doc: Doc,
  catalogExtra = '',
  build: { xref?: 'classic' | 'none' | 'badOffsets'; truncateAt?: number; header?: string } = {},
): Buffer {
  doc.forge.obj(
    doc.pagesNode,
    `<< /Type /Pages /Kids [${doc.pageNums.map((p) => `${p} 0 R`).join(' ')}] /Count ${doc.pageNums.length} /MediaBox [0 0 612 792] >>`,
  );
  doc.forge.obj(doc.catalog, `<< /Type /Catalog /Pages ${doc.pagesNode} 0 R ${catalogExtra}>>`);
  return doc.forge.build(doc.catalog, build);
}

/** Left-aligned lines of Helvetica text, top to bottom. */
function textBlock(text: readonly string[], x = 72, yTop = 740, size = 11, leading = 18): string {
  return text.map((t, i) => `BT /F1 ${size} Tf ${x} ${yTop - i * leading} Td ${pdfLiteral(t)} Tj ET`).join('\n');
}

function textDoc(pages: readonly (readonly string[])[], pageOpts: PageOptions = {}, catalogExtra = ''): Buffer {
  const d = startDoc();
  for (const p of pages) addPage(d, textBlock(p), pageOpts);
  return finishDoc(d, catalogExtra);
}

const truthOf = (pages: readonly (readonly string[])[]): PageTruth[] => pages.map((p) => ({ lines: p }));

// ---------------------------------------------------------------------------------------------------------------------
// Fonts / scripts
// ---------------------------------------------------------------------------------------------------------------------

function utf16Hex(ch: string): string {
  const cp = ch.codePointAt(0)!;
  return cp.toString(16).toUpperCase().padStart(4, '0');
}

/** A Type0/Identity-H document whose codes are assigned in order of first use; `toUnicode` controls whether the CMap is emitted. */
function cidDoc(pages: readonly (readonly string[])[], toUnicode: boolean, dest: (ch: string) => string = utf16Hex): Buffer {
  const d = startDoc();
  const codeOf = new Map<string, number>();
  const code = (ch: string): number => {
    let c = codeOf.get(ch);
    if (c === undefined) {
      c = codeOf.size + 1;
      codeOf.set(ch, c);
    }
    return c;
  };
  const showHex = (s: string): string => '<' + [...s].map((ch) => code(ch).toString(16).toUpperCase().padStart(4, '0')).join('') + '>';
  const contents = pages.map((p) => p.map((t, i) => `BT /F2 12 Tf 72 ${740 - i * 20} Td ${showHex(t)} Tj ET`).join('\n'));
  const f2 = d.forge.alloc();
  const desc = d.forge.alloc();
  const fd = d.forge.alloc();
  const tu = d.forge.alloc();
  d.forge.obj(
    f2,
    `<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+NotoSans /Encoding /Identity-H /DescendantFonts [${desc} 0 R] ${toUnicode ? `/ToUnicode ${tu} 0 R ` : ''}>>`,
  );
  d.forge.obj(
    desc,
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+NotoSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${fd} 0 R /DW 600 /CIDToGIDMap /Identity >>`,
  );
  d.forge.obj(
    fd,
    '<< /Type /FontDescriptor /FontName /ABCDEF+NotoSans /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>',
  );
  for (const c of contents) addPage(d, c, { extraResources: `/F2 ${f2} 0 R ` });
  if (toUnicode) {
    const entries = [...codeOf.entries()].map(([ch, c]) => `<${c.toString(16).toUpperCase().padStart(4, '0')}> <${dest(ch)}>`);
    const chunks: string[] = [];
    for (let i = 0; i < entries.length; i += 100)
      chunks.push(`${Math.min(100, entries.length - i)} beginbfchar\n${entries.slice(i, i + 100).join('\n')}\nendbfchar`);
    d.forge.stream(
      tu,
      `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chunks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`,
      'flate',
    );
  }
  return finishDoc(d);
}

const CYRILLIC = ['Страховщик обязан выплатить страховую сумму', 'Срок действия полиса составляет двенадцать месяцев'];
const GREEK = ['Ο ασφαλιστής πρέπει να καταβάλει το ασφάλισμα', 'Η περίοδος ασφάλισης είναι δώδεκα μήνες'];
const ARABIC = ['يجب على المؤمن دفع مبلغ التأمين', 'مدة وثيقة التأمين اثنا عشر شهرا'];
const CJK = ['保险人应当支付保险金额', '保单有效期为十二个月自生效日起计算'];
const LATIN_EXT = [
  'Der Versicherer zahlt die Versicherungssumme abzüglich der Selbstbeteiligung',
  'Les dommages causés par l’eau sont exclus de la garantie',
];

function type3Doc(): { buf: Buffer; truth: PageTruth[] } {
  const d = startDoc();
  const f3 = d.forge.alloc();
  const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
  const procNums = letters.map(() => d.forge.alloc());
  d.forge.obj(
    f3,
    `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << ${letters.map((l, i) => `/${l} ${procNums[i]} 0 R`).join(' ')} >> ` +
      `/Encoding << /Type /Encoding /Differences [97 ${letters.map((l) => `/${l}`).join(' ')}] >> /FirstChar 97 /LastChar 122 /Widths [${letters.map(() => 600).join(' ')}] /Resources << >> >>`,
  );
  letters.forEach((_, i) => d.forge.stream(procNums[i]!, '600 0 0 0 500 700 d1 50 0 400 700 re f', 'none'));
  const text = ['the insurer shall pay the sum insured', 'theft is excluded unless forced entry'];
  addPage(d, text.map((t, i) => `BT /F3 12 Tf 72 ${740 - i * 20} Td (${t}) Tj ET`).join('\n'), { extraResources: `/F3 ${f3} 0 R ` });
  return { buf: finishDoc(d), truth: truthOf([text]) };
}

function ligatureDoc(): { buf: Buffer; truth: PageTruth[] } {
  // Simple font whose /Differences put ligature glyphs at codes 1..3; /ToUnicode maps them to their letter sequences.
  const d = startDoc();
  const f4 = d.forge.alloc();
  const tu = d.forge.alloc();
  d.forge.obj(
    f4,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [1 /fi /fl /ffi] >> /ToUnicode ${tu} 0 R >>`,
  );
  d.forge.stream(
    tu,
    '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n3 beginbfchar\n<01> <00660069>\n<02> <0066006C>\n<03> <006600660069>\nendbfchar\nendcmap\nend\nend',
    'flate',
  );
  const content = [
    'BT /F4 12 Tf 72 740 Td (The \\001nancial o\\003ce will \\002ag the claim.) Tj ET',
    'BT /F4 12 Tf 72 720 Td (A \\001re policy covers the o\\003ce \\001xtures.) Tj ET',
  ].join('\n');
  addPage(d, content, { extraResources: `/F4 ${f4} 0 R ` });
  return {
    buf: finishDoc(d),
    truth: truthOf([['The financial office will flag the claim.', 'A fire policy covers the office fixtures.']]),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------------------------------

function columnsDoc(cols: number): { buf: Buffer; truth: PageTruth[] } {
  const d = startDoc();
  const truthPages: string[][] = [];
  for (let p = 0; p < 2; p++) {
    const colTexts = Array.from({ length: cols }, (_, c) => lines(p * 7 + c * 3, 6).map((s) => s.split(' ').slice(0, 7).join(' ')));
    const colW = (612 - 144) / cols;
    const ops: string[] = [];
    colTexts.forEach((col, c) =>
      col.forEach((t, i) => ops.push(`BT /F1 10 Tf ${72 + c * colW} ${740 - i * 16} Td ${pdfLiteral(t)} Tj ET`)),
    );
    // Draw in ROW order (as many generators do) so a reader that follows stream order interleaves the columns.
    const rowMajor: string[] = [];
    for (let i = 0; i < 6; i++)
      for (let c = 0; c < cols; c++)
        rowMajor.push(`BT /F1 10 Tf ${72 + c * colW} ${740 - i * 16} Td ${pdfLiteral(colTexts[c]![i]!)} Tj ET`);
    addPage(d, rowMajor.join('\n'));
    truthPages.push(colTexts.flat());
  }
  return { buf: finishDoc(d), truth: truthOf(truthPages) };
}

function rotatedTextDoc(angleDeg: number): { buf: Buffer; truth: PageTruth[] } {
  const a = (angleDeg * Math.PI) / 180;
  const c = Math.cos(a).toFixed(5);
  const s = Math.sin(a).toFixed(5);
  const text = lines(0, 6);
  const ops = text.map((t, i) => {
    // Text matrix rotates the baseline; successive lines are offset perpendicular to the baseline.
    const ox = 300 + (-Math.sin(a) * -i * 18 + 0);
    const oy = 400 + Math.cos(a) * -i * 18;
    return `BT /F1 11 Tf ${c} ${s} ${(-Number(s)).toFixed(5)} ${c} ${ox.toFixed(2)} ${oy.toFixed(2)} Tm ${pdfLiteral(t)} Tj ET`;
  });
  const d = startDoc();
  addPage(d, ops.join('\n'));
  return { buf: finishDoc(d), truth: truthOf([text]) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------------------------------------

const TABLE_HEAD = ['Cover', 'Limit', 'Excess', 'Waiting'];
const TABLE_ROWS = [
  ['Buildings', '500000', '1000', '0 days'],
  ['Contents', '100000', '500', '0 days'],
  ['Theft', '25000', '1000', '30 days'],
  ['Flood', '50000', '2500', '30 days'],
  ['Liability', '1000000', '0', '14 days'],
  ['Legal', '10000', '250', '7 days'],
];

function gridOps(x0: number, yTop: number, colW: number[], rowH: number[]): string {
  const ops: string[] = ['0.5 w'];
  const totalW = colW.reduce((a, b) => a + b, 0);
  let y = yTop;
  ops.push(`${x0} ${y} m ${x0 + totalW} ${y} l S`);
  for (const h of rowH) {
    y -= h;
    ops.push(`${x0} ${y} m ${x0 + totalW} ${y} l S`);
  }
  let x = x0;
  const yBottom = yTop - rowH.reduce((a, b) => a + b, 0);
  ops.push(`${x} ${yTop} m ${x} ${yBottom} l S`);
  for (const w of colW) {
    x += w;
    ops.push(`${x} ${yTop} m ${x} ${yBottom} l S`);
  }
  return ops.join('\n');
}

function tableDoc(variant: 'plain' | 'wrapped' | 'merged'): { buf: Buffer; truth: PageTruth[] } {
  const colW = [120, 100, 100, 100];
  const x0 = 72;
  const yTop = 700;
  const ops: string[] = [];
  const truth: string[] = [];
  const cell = (x: number, y: number, t: string, size = 10): void => {
    ops.push(`BT /F1 ${size} Tf ${x} ${y} Td ${pdfLiteral(t)} Tj ET`);
  };
  if (variant === 'merged') {
    const rowH = [22, 22, ...TABLE_ROWS.slice(0, 4).map(() => 22)];
    ops.push(gridOps(x0, yTop, colW, rowH));
    // Row 1: a header spanning all columns (merged cell), drawn over the vertical dividers.
    ops.push(`1 g ${x0 + 1} ${yTop - 21} ${colW.reduce((a, b) => a + b, 0) - 2} 20 re f 0 g`);
    cell(x0 + 140, yTop - 16, 'Schedule of Cover', 11);
    truth.push('Schedule of Cover');
    TABLE_HEAD.forEach((h, c) => cell(x0 + 6 + colW.slice(0, c).reduce((a, b) => a + b, 0), yTop - 22 - 15, h));
    truth.push(...TABLE_HEAD);
    TABLE_ROWS.slice(0, 4).forEach((r, ri) =>
      r.forEach((t, c) => cell(x0 + 6 + colW.slice(0, c).reduce((a, b) => a + b, 0), yTop - 44 - ri * 22 - 15, t)),
    );
    truth.push(...TABLE_ROWS.slice(0, 4).flat());
  } else {
    const wrapped = variant === 'wrapped';
    const longText: Record<string, string[]> = {
      Buildings: ['Buildings', 'including outbuildings'],
      Theft: ['Theft', 'forced entry only'],
      Flood: ['Flood', 'above flood line'],
    };
    const rowHeights = [22, ...TABLE_ROWS.map((r) => (wrapped && longText[r[0]!] ? 34 : 22))];
    ops.push(gridOps(x0, yTop, colW, rowHeights));
    TABLE_HEAD.forEach((h, c) => cell(x0 + 6 + colW.slice(0, c).reduce((a, b) => a + b, 0), yTop - 15, h));
    truth.push(...TABLE_HEAD);
    let y = yTop - 22;
    TABLE_ROWS.forEach((r, ri) => {
      const h = rowHeights[ri + 1]!;
      r.forEach((t, c) => {
        const x = x0 + 6 + colW.slice(0, c).reduce((a, b) => a + b, 0);
        if (c === 0 && wrapped && longText[t]) {
          cell(x, y - 13, longText[t]![0]!);
          cell(x, y - 25, longText[t]![1]!);
        } else cell(x, y - 15, t);
      });
      truth.push(...(wrapped && longText[r[0]!] ? [...longText[r[0]!]!, ...r.slice(1)] : r));
      y -= h;
    });
  }
  const d = startDoc();
  addPage(d, ops.join('\n'));
  return { buf: finishDoc(d), truth: truthOf([truth]) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------------------------------------------------

function formDoc(): { buf: Buffer; truth: PageTruth[] } {
  const d = startDoc();
  const labels = ['Policy number', 'Insured name', 'Date of loss', 'Description of loss'];
  const values = ['POL 884213', 'Jordan Ellis', '2026 03 14', 'Water damage to kitchen ceiling'];
  const fieldNums = labels.map(() => d.forge.alloc());
  const apNums = labels.map(() => d.forge.alloc());
  const annotRefs = fieldNums.map((n) => `${n} 0 R`).join(' ');
  const content = labels.map((l, i) => `BT /F1 10 Tf 72 ${700 - i * 40} Td ${pdfLiteral(l)} Tj ET`).join('\n');
  const page = addPage(d, content, { extraDict: `/Annots [${annotRefs}] ` });
  labels.forEach((_, i) => {
    const y = 690 - i * 40;
    d.forge.stream(
      apNums[i]!,
      `BT /F1 10 Tf 2 4 Td ${pdfLiteral(values[i]!)} Tj ET`,
      'none',
      `/Type /XObject /Subtype /Form /BBox [0 0 300 18] /Resources << /Font << /F1 ${d.font} 0 R >> >> `,
    );
    d.forge.obj(
      fieldNums[i]!,
      `<< /Type /Annot /Subtype /Widget /FT /Tx /T ${pdfLiteral(`f${i}`)} /V ${pdfLiteral(values[i]!)} /Rect [200 ${y} 500 ${y + 18}] /P ${page} 0 R /F 4 /DA (/F1 10 Tf 0 g) /AP << /N ${apNums[i]} 0 R >> >>`,
    );
  });
  return {
    buf: finishDoc(d, `/AcroForm << /Fields [${annotRefs}] /DA (/F1 10 Tf 0 g) /DR << /Font << /F1 ${d.font} 0 R >> >> >> `),
    truth: truthOf([[...labels, ...values]]),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Corruption, inert content, bombs
// ---------------------------------------------------------------------------------------------------------------------

const BASE_PAGES = [lines(0, 8), lines(3, 8), lines(5, 8)];

function corruptCases(): TaxonomyCase[] {
  const base = (): Buffer => textDoc(BASE_PAGES);
  const truth = truthOf(BASE_PAGES);
  const mk = (
    id: string,
    description: string,
    build: () => Uint8Array,
    expectation: Expectation = 'readable',
    t: readonly PageTruth[] | undefined = truth,
  ): TaxonomyCase => ({
    id,
    category: 'corrupt',
    description,
    expectation,
    build,
    ...(t !== undefined ? { truth: t } : {}),
  });
  return [
    mk('corrupt-bad-xref-offsets', 'xref table present but every offset is wrong', () => {
      const d = startDoc();
      for (const p of BASE_PAGES) addPage(d, textBlock(p));
      return finishDoc(d, '', { xref: 'badOffsets' });
    }),
    mk('corrupt-no-xref', 'no xref table and no trailer at all', () => {
      const d = startDoc();
      for (const p of BASE_PAGES) addPage(d, textBlock(p));
      return finishDoc(d, '', { xref: 'none' });
    }),
    mk('corrupt-garbage-prefix', '300 bytes of junk before the %PDF header (offsets shifted)', () =>
      Buffer.concat([Buffer.alloc(300, 0x41), base()]),
    ),
    mk(
      'corrupt-truncated-90',
      'file cut at 90% (xref and trailer lost)',
      () => {
        const b = base();
        return b.subarray(0, Math.floor(b.length * 0.9));
      },
      'bounded_failure',
      undefined,
    ),
    mk('corrupt-bad-length', 'content stream /Length is wrong on every page', () => {
      const b = base()
        .toString('latin1')
        .replace(/\/Length (\d+)/g, (_m, n) => `/Length ${Number(n) + 11}`);
      return Buffer.from(b, 'latin1');
    }),
    mk(
      'corrupt-flate-error-page2',
      'page 2 content stream has invalid zlib data; pages 1 and 3 must survive',
      () => {
        const d = startDoc();
        addPage(d, textBlock(BASE_PAGES[0]!));
        const page = d.forge.alloc();
        const cs = d.forge.alloc();
        d.pageNums.push(page);
        d.forge.obj(
          page,
          `<< /Type /Page /Parent ${d.pagesNode} 0 R /Contents ${cs} 0 R /Resources << /Font << /F1 ${d.font} 0 R >> >> >>`,
        );
        d.forge.stream(cs, Buffer.alloc(0), { raw: Buffer.from('this is not zlib data at all, just bytes'), filter: '/FlateDecode' });
        addPage(d, textBlock(BASE_PAGES[2]!));
        return finishDoc(d);
      },
      'bounded_failure',
      [{ lines: BASE_PAGES[0]! }, { lines: [] }, { lines: BASE_PAGES[2]! }],
    ),
    mk(
      'corrupt-unsupported-filter-page2',
      'page 2 uses an unsupported filter (LZW); pages 1 and 3 must survive',
      () => {
        const d = startDoc();
        addPage(d, textBlock(BASE_PAGES[0]!));
        const page = d.forge.alloc();
        const cs = d.forge.alloc();
        d.pageNums.push(page);
        d.forge.obj(
          page,
          `<< /Type /Page /Parent ${d.pagesNode} 0 R /Contents ${cs} 0 R /Resources << /Font << /F1 ${d.font} 0 R >> >> >>`,
        );
        d.forge.stream(cs, Buffer.alloc(0), { raw: Buffer.from(textBlock(BASE_PAGES[1]!), 'latin1'), filter: '/LZWDecode' });
        addPage(d, textBlock(BASE_PAGES[2]!));
        return finishDoc(d);
      },
      'bounded_failure',
      [{ lines: BASE_PAGES[0]! }, { lines: [] }, { lines: BASE_PAGES[2]! }],
    ),
    mk(
      'corrupt-random-bytes',
      'not a PDF at all: 4 KB of deterministic noise',
      () => {
        const out = Buffer.alloc(4096);
        let s = 0x9e3779b9;
        for (let i = 0; i < out.length; i++) {
          s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
          out[i] = s >>> 24;
        }
        return out;
      },
      'bounded_failure',
      undefined,
    ),
    mk('corrupt-empty', 'a zero-byte file', () => Buffer.alloc(0), 'bounded_failure', undefined),
  ];
}

function inertCases(): TaxonomyCase[] {
  const pages = [lines(0, 5)];
  const forbidden = ['ATTACHMENTSECRET', 'JSEXECUTED'];
  return [
    {
      id: 'inert-javascript-openaction',
      category: 'inert',
      description: 'catalog /OpenAction and page /AA run JavaScript that would rewrite content; must never execute',
      expectation: 'readable',
      truth: truthOf(pages),
      forbiddenWords: forbidden,
      build: () => {
        const d = startDoc();
        const js = d.forge.alloc();
        d.forge.obj(js, `<< /S /JavaScript /JS (app.alert\\('JSEXECUTED'\\); this.getField\\('x'\\).value = 'JSEXECUTED';) >>`);
        addPage(d, textBlock(pages[0]!), { extraDict: `/AA << /O ${js} 0 R >> ` });
        return finishDoc(d, `/OpenAction ${js} 0 R /Names << /JavaScript << /Names [(init) ${js} 0 R] >> >> `);
      },
    },
    {
      id: 'inert-embedded-file',
      category: 'inert',
      description: 'an embedded file whose text must not leak into extraction, plus a /Launch and a /URI action',
      expectation: 'readable',
      truth: truthOf(pages),
      forbiddenWords: forbidden,
      build: () => {
        const d = startDoc();
        const ef = d.forge.alloc();
        const fs = d.forge.alloc();
        const launch = d.forge.alloc();
        const uri = d.forge.alloc();
        d.forge.stream(ef, 'BT /F1 12 Tf 72 700 Td (ATTACHMENTSECRET) Tj ET', 'flate', '/Type /EmbeddedFile ');
        d.forge.obj(fs, `<< /Type /Filespec /F (secret.pdf) /EF << /F ${ef} 0 R >> >>`);
        d.forge.obj(launch, '<< /S /Launch /F (cmd.exe) >>');
        d.forge.obj(uri, '<< /S /URI /URI (http://127.0.0.1:9/should-never-be-fetched) >>');
        addPage(d, textBlock(pages[0]!), {
          extraDict: `/Annots [<< /Type /Annot /Subtype /Link /Rect [0 0 100 100] /A ${launch} 0 R >> << /Type /Annot /Subtype /Link /Rect [0 0 50 50] /A ${uri} 0 R >>] `,
        });
        return finishDoc(d, `/Names << /EmbeddedFiles << /Names [(secret.pdf) ${fs} 0 R] >> >> `);
      },
    },
  ];
}

function bombCases(): TaxonomyCase[] {
  const oneStream =
    (data: Buffer, filter: 'flate' | 'runlength'): (() => Uint8Array) =>
    () => {
      const d = startDoc();
      const page = d.forge.alloc();
      const cs = d.forge.alloc();
      d.pageNums.push(page);
      d.forge.obj(page, `<< /Type /Page /Parent ${d.pagesNode} 0 R /Contents ${cs} 0 R /Resources << /Font << /F1 ${d.font} 0 R >> >> >>`);
      d.forge.stream(cs, data, filter);
      addPage(d, textBlock(lines(0, 3)));
      return finishDoc(d);
    };
  return [
    {
      id: 'bomb-flate-300mb',
      category: 'bomb',
      description: '300 MiB of zeros in a ~300 KB flate stream on page 1; page 2 is normal',
      expectation: 'bounded_failure',
      truth: [{ lines: [] }, { lines: lines(0, 3) }],
      build: oneStream(Buffer.alloc(300 * 1024 * 1024), 'flate'),
    },
    {
      id: 'bomb-runlength',
      category: 'bomb',
      description: 'RunLengthDecode expanding 128x, 80 MiB output, on page 1',
      expectation: 'bounded_failure',
      truth: [{ lines: [] }, { lines: lines(0, 3) }],
      build: oneStream(Buffer.alloc(80 * 1024 * 1024), 'runlength'),
    },
    {
      id: 'bomb-many-streams',
      category: 'bomb',
      description: '40 pages each carrying a legal-looking 20 MiB stream (document-wide decode budget)',
      expectation: 'bounded_failure',
      heavy: true,
      build: () => {
        const d = startDoc();
        for (let i = 0; i < 40; i++) addPage(d, ' '.repeat(20 * 1024 * 1024) + textBlock([line(i)]));
        return finishDoc(d);
      },
    },
  ];
}

// ---------------------------------------------------------------------------------------------------------------------
// Case list
// ---------------------------------------------------------------------------------------------------------------------

/** Scanned-page cases: rendered by `scan-fixtures/make_scans.py`, committed with their ground truth. */
function scanCases(): TaxonomyCase[] {
  const dir = new URL('./scan-fixtures/', import.meta.url);
  const truth = JSON.parse(readFileSync(fileURLToPath(new URL('scan-truth.json', dir)), 'utf8')) as Record<string, string[][]>;
  const describe: Record<string, string> = {
    'scan-clean-3p': 'three clean 150 dpi scanned pages (image only, no text layer)',
    'scan-rotated-90': 'scanned page physically rotated 90 degrees',
    'scan-rotated-180': 'scanned page upside down',
    'scan-rotated-270': 'scanned page physically rotated 270 degrees',
    'scan-skewed-2deg': 'scanned page skewed by 2 degrees',
    'scan-noisy-100dpi': 'low-resolution 100 dpi scan with noise and blur',
    'scan-two-column': 'two-column scanned page',
  };
  return Object.keys(truth).map((id) => ({
    id,
    category: 'scan' as const,
    description: describe[id] ?? id,
    expectation: 'needs_recovery' as const,
    truth: truth[id]!.map((lines) => ({ lines })),
    build: () => new Uint8Array(readFileSync(fileURLToPath(new URL(`${id}.pdf`, dir)))),
  }));
}

export function buildCases(): TaxonomyCase[] {
  const cases: TaxonomyCase[] = [];
  const add = (c: TaxonomyCase): void => void cases.push(c);

  const ctl = [lines(0, 10), lines(4, 10), lines(7, 10)];
  add({
    id: 'control-text-3p',
    category: 'control',
    description: 'three pages of ordinary single-column text',
    expectation: 'readable',
    truth: truthOf(ctl),
    build: () => textDoc(ctl),
  });

  for (const rot of [90, 180, 270]) {
    const pages = [lines(0, 8)];
    add({
      id: `layout-page-rotate-${rot}`,
      category: 'layout',
      description: `page /Rotate ${rot}; text layer unchanged`,
      expectation: 'readable',
      truth: truthOf(pages),
      build: () => textDoc(pages, { rotate: rot }),
    });
  }
  for (const [deg, name] of [
    [90, 'text-rotated-90'],
    [270, 'text-rotated-270'],
    [3, 'text-skewed-3deg'],
    [-4, 'text-skewed-minus-4deg'],
  ] as const) {
    const r = rotatedTextDoc(deg);
    add({
      id: `layout-${name}`,
      category: 'layout',
      description: `text drawn with a ${deg} degree text matrix`,
      expectation: 'readable',
      truth: r.truth,
      build: () => new Uint8Array(rotatedTextDoc(deg).buf),
    });
  }
  for (const cols of [2, 3]) {
    const c = columnsDoc(cols);
    add({
      id: `layout-${cols}-column`,
      category: 'layout',
      description: `${cols} columns drawn in row order; reading order must follow columns`,
      expectation: 'readable',
      truth: c.truth,
      build: () => new Uint8Array(columnsDoc(cols).buf),
    });
  }

  for (const v of ['plain', 'wrapped', 'merged'] as const) {
    const t = tableDoc(v);
    add({
      id: `table-${v}`,
      category: 'table',
      description: `ruled table, ${v} cells`,
      expectation: 'readable',
      truth: t.truth,
      build: () => new Uint8Array(tableDoc(v).buf),
    });
  }
  add({
    id: 'form-acroform-text-fields',
    category: 'form',
    description: 'AcroForm text widgets whose values live only in /V and appearance streams',
    expectation: 'readable',
    truth: formDoc().truth,
    build: () => new Uint8Array(formDoc().buf),
  });

  for (const [id, text] of [
    ['cyrillic', CYRILLIC],
    ['greek', GREEK],
    ['arabic', ARABIC],
    ['cjk', CJK],
    ['latin-extended', LATIN_EXT],
  ] as const) {
    add({
      id: `script-${id}-tounicode`,
      category: 'script',
      description: `${id} text via Type0/Identity-H with a ToUnicode CMap`,
      expectation: 'readable',
      truth: truthOf([text]),
      build: () => new Uint8Array(cidDoc([text], true)),
    });
  }
  add({
    id: 'font-subset-no-tounicode',
    category: 'font',
    description: 'Type0/Identity-H subset font with no ToUnicode: the text layer is meaningless',
    expectation: 'needs_recovery',
    truth: truthOf([lines(0, 4)]),
    build: () => new Uint8Array(cidDoc([lines(0, 4)], false)),
  });
  add({
    id: 'font-type3-glyph-names',
    category: 'font',
    description: 'Type3 font with /Differences glyph names',
    expectation: 'readable',
    truth: type3Doc().truth,
    build: () => new Uint8Array(type3Doc().buf),
  });
  add({
    id: 'font-ligatures',
    category: 'font',
    description: 'fi / fl / ffi ligature codes mapped by ToUnicode to letter sequences',
    expectation: 'readable',
    truth: ligatureDoc().truth,
    build: () => new Uint8Array(ligatureDoc().buf),
  });
  add({
    id: 'font-vector-outlined-text',
    category: 'font',
    description: 'every glyph drawn as filled paths (no text operators): page looks full but has no text layer',
    expectation: 'needs_recovery',
    truth: truthOf([lines(0, 3)]),
    build: () => {
      const d = startDoc();
      // Stand-in outlines: each character becomes a small filled box, positioned like text. There is no text layer.
      const ops: string[] = [];
      lines(0, 3).forEach((t, li) => [...t].forEach((ch, ci) => ch !== ' ' && ops.push(`${72 + ci * 6} ${740 - li * 20} 4 8 re f`)));
      addPage(d, ops.join('\n'));
      return new Uint8Array(finishDoc(d));
    },
  });

  const encPages = [lines(0, 6), lines(2, 6)];
  const encSpecs: [string, string, EncryptionSpec, Expectation][] = [
    [
      'enc-owner-only-rc4-128',
      'owner password set, empty user password, RC4 128-bit (opens without a password)',
      { cipher: 'rc4-128', userPassword: '', ownerPassword: 'owner-secret' },
      'readable',
    ],
    [
      'enc-owner-only-aes-128',
      'owner password set, empty user password, AES-128',
      { cipher: 'aes-128', userPassword: '', ownerPassword: 'owner-secret' },
      'readable',
    ],
    [
      'enc-owner-only-rc4-40',
      'owner password set, empty user password, RC4 40-bit',
      { cipher: 'rc4-40', userPassword: '', ownerPassword: 'owner-secret' },
      'readable',
    ],
    [
      'enc-user-password-rc4-128',
      'user password required to open: must be refused loudly, not read as garbage',
      { cipher: 'rc4-128', userPassword: 'open-sesame', ownerPassword: 'owner-secret' },
      'bounded_failure',
    ],
    [
      'enc-user-password-aes-128',
      'AES-128 with a user password: refused loudly',
      { cipher: 'aes-128', userPassword: 'open-sesame', ownerPassword: 'owner-secret' },
      'bounded_failure',
    ],
  ];
  for (const [id, description, spec, expectation] of encSpecs) {
    add({
      id,
      category: 'encrypted',
      description,
      expectation,
      ...(expectation === 'readable' ? { truth: truthOf(encPages) } : {}),
      build: () =>
        new Uint8Array(
          buildEncrypted(
            encPages.map((p) => textBlock(p)),
            spec,
          ),
        ),
    });
  }

  add({
    id: 'scale-3000-pages',
    category: 'scale',
    description: '3000 short pages',
    expectation: 'readable',
    heavy: true,
    truth: undefined,
    build: () => textDoc(Array.from({ length: 3000 }, (_, i) => [`Page ${i + 1} ${line(i)}`])),
  });
  add({
    id: 'scale-huge-single-page',
    category: 'scale',
    description: 'one 14400x14400 pt page with 60,000 positioned text runs',
    expectation: 'readable',
    heavy: true,
    build: () => {
      const d = startDoc();
      const ops: string[] = [];
      for (let i = 0; i < 60_000; i++) ops.push(`BT /F1 8 Tf ${20 + (i % 40) * 350} ${14380 - Math.floor(i / 40) * 9} Td (w${i}) Tj ET`);
      addPage(d, ops.join('\n'), { mediaBox: '[0 0 14400 14400]' });
      return new Uint8Array(finishDoc(d));
    },
  });

  for (const c of scanCases()) add(c);
  for (const c of corruptCases()) add(c);
  for (const c of inertCases()) add(c);
  for (const c of bombCases()) add(c);
  return cases;
}
