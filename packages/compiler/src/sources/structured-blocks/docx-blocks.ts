/**
 * UW-3c — a Word (.docx) document as document blocks, read the way Word shows it.
 *
 * The earlier reader turned every numbered paragraph into a "- " bullet (so a numbered procedure lost its order), fused a
 * table cell's paragraphs into one line, read a one-cell "callout box" as a table row, and tokenised the XML with one regular
 * expression that can run in quadratic time on malformed input. This reader:
 *
 * - tokenises the XML linearly (every character is looked at a bounded number of times; nothing backtracks);
 * - resolves list numbering from `word/numbering.xml` and paragraph styles from `word/styles.xml`: the list type (numbered or
 *   bulleted), the position Word shows (counters per list, restarts honoured), and the nesting level;
 * - reads headings from heading styles, the Title style and outline levels, and treats a short, entirely bold paragraph as a
 *   heading the way a reader does;
 * - reads a table with two or more columns as table rows, and a one-column table (a box around text) as ordinary paragraphs;
 * - keeps check-box glyphs (☐ ☒, and Wingdings check boxes) so a checklist keeps its tick states;
 * - reads text boxes, footnotes and endnotes; skips tracked deletions, field instructions and the duplicate "fallback" copy
 *   of drawings; and reports what it does not read (headers, footers, comments, images).
 */
import { BlockSink, cleanText, orderedMarker, type Span, type UnplacedBlock } from './block-sink.js';

export interface DocxParts {
  readonly document: string;
  readonly numbering?: string;
  readonly styles?: string;
  readonly footnotes?: string;
  readonly endnotes?: string;
}

export interface DocxStats {
  readonly paragraphs: number;
  readonly tableRows: number;
  readonly words: number;
}

export interface DocxRead {
  readonly blocks: UnplacedBlock[];
  readonly notes: string[];
  readonly stats: DocxStats;
}

// ------------------------------------------------------------------------------------------------ linear XML tokens

type XmlToken =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tag'; readonly name: string; readonly closing: boolean; readonly selfClosing: boolean; readonly attrs: string };

const TAG_NAME = /^[A-Za-z0-9]+:[A-Za-z0-9]+/;

/** A linear tokenizer: `indexOf` for `<` and `>`, one anchored match per tag. Comments, PIs and doctype are skipped. */
function* xmlTokens(xml: string): Generator<XmlToken> {
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      yield { kind: 'text', text: xml.slice(i) };
      return;
    }
    if (lt > i) yield { kind: 'text', text: xml.slice(i, lt) };
    const gt = xml.indexOf('>', lt + 1);
    if (gt === -1) return;
    let inner = xml.slice(lt + 1, gt);
    i = gt + 1;
    const closing = inner.startsWith('/');
    if (closing) inner = inner.slice(1);
    const match = TAG_NAME.exec(inner);
    if (match === null) continue;
    const rest = inner.slice(match[0].length);
    const selfClosing = !closing && rest.endsWith('/');
    yield { kind: 'tag', name: match[0], closing, selfClosing, attrs: selfClosing ? rest.slice(0, -1) : rest };
  }
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function safeCodePoint(cp: number): string | undefined {
  return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : undefined;
}

export function decodeXml(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (whole, body: string) => {
    if (body.startsWith('#x')) return safeCodePoint(parseInt(body.slice(2), 16)) ?? whole;
    if (body.startsWith('#')) return safeCodePoint(parseInt(body.slice(1), 10)) ?? whole;
    return ENTITIES[body] ?? whole;
  });
}

function attrOf(attrs: string, name: string): string | undefined {
  const k = attrs.indexOf(`${name}="`);
  if (k < 0) return undefined;
  const start = k + name.length + 2;
  const end = attrs.indexOf('"', start);
  return end < 0 ? undefined : decodeXml(attrs.slice(start, end));
}

/** `<w:b/>` is on; `<w:b w:val="0"/>` / `"false"` / `"off"` is off. */
function toggleOn(attrs: string): boolean {
  const v = attrOf(attrs, 'w:val');
  return v === undefined || !['0', 'false', 'off', 'none'].includes(v.toLowerCase());
}

// ------------------------------------------------------------------------------------------------ styles and numbering

interface StyleDef {
  readonly name: string;
  readonly basedOn?: string | undefined;
  readonly numId?: string | undefined;
  readonly ilvl?: number;
  readonly outline?: number;
  readonly bold?: boolean;
}

function readStyles(xml: string | undefined): Map<string, StyleDef> {
  const styles = new Map<string, StyleDef>();
  if (xml === undefined) return styles;
  let cur:
    | {
        id: string;
        def: { name: string; basedOn?: string | undefined; numId?: string | undefined; ilvl?: number; outline?: number; bold?: boolean };
      }
    | undefined;
  let inRPr = false;
  for (const t of xmlTokens(xml)) {
    if (t.kind !== 'tag') continue;
    if (t.name === 'w:style') {
      if (t.closing) {
        if (cur !== undefined) styles.set(cur.id, cur.def);
        cur = undefined;
      } else {
        const id = attrOf(t.attrs, 'w:styleId');
        cur = id !== undefined ? { id, def: { name: id } } : undefined;
        if (t.selfClosing && cur !== undefined) {
          styles.set(cur.id, cur.def);
          cur = undefined;
        }
      }
      continue;
    }
    if (cur === undefined) continue;
    if (t.name === 'w:rPr') inRPr = !t.closing && !t.selfClosing;
    else if (t.name === 'w:name' && !t.closing) cur.def.name = attrOf(t.attrs, 'w:val') ?? cur.def.name;
    else if (t.name === 'w:basedOn' && !t.closing) cur.def.basedOn = attrOf(t.attrs, 'w:val');
    else if (t.name === 'w:numId' && !t.closing) cur.def.numId = attrOf(t.attrs, 'w:val');
    else if (t.name === 'w:ilvl' && !t.closing) cur.def.ilvl = Number(attrOf(t.attrs, 'w:val') ?? '0');
    else if (t.name === 'w:outlineLvl' && !t.closing) cur.def.outline = Number(attrOf(t.attrs, 'w:val') ?? '9');
    else if (t.name === 'w:b' && !t.closing && inRPr) cur.def.bold = toggleOn(t.attrs);
  }
  return styles;
}

/** A style's own value, else the value inherited through `basedOn` (cycles cut). */
function styleValue<K extends keyof StyleDef>(styles: Map<string, StyleDef>, id: string | undefined, key: K): StyleDef[K] | undefined {
  const seen = new Set<string>();
  let cur = id;
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    const def = styles.get(cur);
    if (def === undefined) return undefined;
    if (def[key] !== undefined) return def[key];
    cur = def.basedOn;
  }
  return undefined;
}

type NumFormat = 'bullet' | 'none' | 'decimal' | 'lower-alpha' | 'upper-alpha' | 'lower-roman' | 'upper-roman';

interface LevelDef {
  readonly format: NumFormat;
  readonly start: number;
}

interface Numbering {
  readonly abstracts: Map<string, Map<number, LevelDef>>;
  readonly nums: Map<string, { readonly abstractId: string; readonly startOverrides: Map<number, number> }>;
}

function numFormat(v: string | undefined): NumFormat {
  switch (v) {
    case 'bullet':
      return 'bullet';
    case 'none':
      return 'none';
    case 'lowerLetter':
      return 'lower-alpha';
    case 'upperLetter':
      return 'upper-alpha';
    case 'lowerRoman':
      return 'lower-roman';
    case 'upperRoman':
      return 'upper-roman';
    default:
      return 'decimal';
  }
}

function readNumbering(xml: string | undefined): Numbering {
  const abstracts = new Map<string, Map<number, LevelDef>>();
  const nums = new Map<string, { abstractId: string; startOverrides: Map<number, number> }>();
  if (xml === undefined) return { abstracts, nums };
  let abs: Map<number, LevelDef> | undefined;
  let lvl: { ilvl: number; format: NumFormat; start: number } | undefined;
  let num: { id: string; abstractId: string; startOverrides: Map<number, number> } | undefined;
  let overrideLvl: number | undefined;
  for (const t of xmlTokens(xml)) {
    if (t.kind !== 'tag') continue;
    switch (t.name) {
      case 'w:abstractNum':
        if (!t.closing) {
          abs = new Map();
          abstracts.set(attrOf(t.attrs, 'w:abstractNumId') ?? '', abs);
        } else abs = undefined;
        break;
      case 'w:lvl':
        if (abs === undefined) break;
        if (!t.closing) lvl = { ilvl: Number(attrOf(t.attrs, 'w:ilvl') ?? '0'), format: 'decimal', start: 1 };
        if ((t.closing || t.selfClosing) && lvl !== undefined) {
          abs.set(lvl.ilvl, { format: lvl.format, start: lvl.start });
          lvl = undefined;
        }
        break;
      case 'w:numFmt':
        if (lvl !== undefined && !t.closing) lvl.format = numFormat(attrOf(t.attrs, 'w:val'));
        break;
      case 'w:start':
        if (lvl !== undefined && !t.closing) lvl.start = Number(attrOf(t.attrs, 'w:val') ?? '1') || 1;
        break;
      case 'w:num':
        if (!t.closing) num = { id: attrOf(t.attrs, 'w:numId') ?? '', abstractId: '', startOverrides: new Map() };
        if ((t.closing || t.selfClosing) && num !== undefined) {
          nums.set(num.id, num);
          num = undefined;
        }
        break;
      case 'w:abstractNumId':
        if (num !== undefined && !t.closing) num.abstractId = attrOf(t.attrs, 'w:val') ?? '';
        break;
      case 'w:lvlOverride':
        overrideLvl = !t.closing && num !== undefined ? Number(attrOf(t.attrs, 'w:ilvl') ?? '0') : undefined;
        break;
      case 'w:startOverride':
        if (num !== undefined && overrideLvl !== undefined && !t.closing)
          num.startOverrides.set(overrideLvl, Number(attrOf(t.attrs, 'w:val') ?? '1') || 1);
        break;
      default:
        break;
    }
  }
  return { abstracts, nums };
}

// ------------------------------------------------------------------------------------------------ the document body

interface Para {
  style?: string | undefined;
  numId?: string | undefined;
  ilvl?: number;
  outline?: number;
  spans: Span[];
}

interface Cell {
  paras: Para[];
}

interface Table {
  rows: Cell[][];
  row: Cell[] | undefined;
  cell: Cell | undefined;
}

/** Wingdings / Wingdings 2 check-box symbols Word inserts with `<w:sym>`. */
const SYMBOL_BOXES: Readonly<Record<string, string>> = {
  F06F: '☐',
  F0A8: '☐',
  F0A3: '☐',
  F0FE: '☒',
  F0FD: '☒',
  F078: '☒',
  F052: '☑',
  F0FC: '☑',
};

const HEADING_STYLE = /^(?:heading|überschrift|titre|título|kop)\s*([1-9])$/i;

export function docxBlocks(parts: DocxParts): DocxRead {
  const styles = readStyles(parts.styles);
  const numbering = readNumbering(parts.numbering);
  const sink = new BlockSink();
  const notes: string[] = [];
  let paragraphs = 0;
  let tableRows = 0;
  let unresolvedNumbering = 0;
  let sawTextBox = false;
  let images = 0;
  const counters = new Map<string, (number | undefined)[]>();
  const startedNums = new Set<string>();

  const headingLevel = (p: Para): number | undefined => {
    const name = styleValue(styles, p.style, 'name') ?? p.style ?? '';
    const h = HEADING_STYLE.exec(name.trim());
    if (h !== null) return Number(h[1]);
    if (/^(?:title)$/i.test(name.trim())) return 1;
    if (/^(?:subtitle)$/i.test(name.trim())) return 2;
    const outline = p.outline ?? styleValue(styles, p.style, 'outline');
    if (outline !== undefined && outline >= 0 && outline <= 5) return outline + 1;
    return undefined;
  };

  /** The list position Word shows for this paragraph, advancing the list's counters. */
  const listInfo = (p: Para): { ordered: boolean; ordinal?: number; marker?: string; depth: number } | undefined => {
    const numId = p.numId ?? styleValue(styles, p.style, 'numId');
    if (numId === undefined || numId === '0') return undefined;
    const ilvl = p.ilvl ?? styleValue(styles, p.style, 'ilvl') ?? 0;
    const num = numbering.nums.get(numId);
    const level = num !== undefined ? numbering.abstracts.get(num.abstractId)?.get(ilvl) : undefined;
    if (num === undefined || level === undefined) {
      unresolvedNumbering += 1;
      return { ordered: false, depth: ilvl };
    }
    if (level.format === 'bullet' || level.format === 'none') return { ordered: false, depth: ilvl };
    const key = num.abstractId;
    const levels: (number | undefined)[] = counters.get(key) ?? [];
    if (!startedNums.has(numId)) {
      startedNums.add(numId);
      for (const [l, start] of num.startOverrides) levels[l] = start - 1;
    }
    levels[ilvl] = (levels[ilvl] ?? level.start - 1) + 1;
    levels.length = ilvl + 1; // a deeper level restarts after its parent advances
    counters.set(key, levels);
    const ordinal = levels[ilvl]!;
    return { ordered: true, ordinal, marker: orderedMarker(ordinal, level.format), depth: ilvl };
  };

  const emit = (p: Para): void => {
    const text = cleanText(p.spans.map((s) => s.text).join(''));
    if (text.length === 0) return;
    paragraphs += 1;
    const level = headingLevel(p);
    if (level !== undefined) {
      sink.heading(level, text);
      return;
    }
    const list = listInfo(p);
    if (list !== undefined) {
      sink.listItem({ ...list, spans: p.spans });
      return;
    }
    const styleBold = styleValue(styles, p.style, 'bold') === true;
    sink.paragraph(styleBold ? p.spans.map((s) => ({ ...s, bold: true })) : p.spans);
  };

  const emitTable = (table: Table, parent: Table | undefined): void => {
    const width = Math.max(0, ...table.rows.map((r) => r.length));
    if (parent !== undefined) {
      // A table inside a cell: its rows become text of the enclosing cell.
      const lines = table.rows
        .map((r) =>
          r
            .map((c) => cellText(c))
            .filter((t) => t.length > 0)
            .join(' | '),
        )
        .filter((l) => l.length > 0);
      if (parent.cell !== undefined && lines.length > 0) parent.cell.paras.push({ spans: [{ text: lines.join('; ') }] });
      return;
    }
    if (width <= 1) {
      for (const r of table.rows) for (const c of r) for (const p of c.paras) emit(p);
      return;
    }
    let first = true;
    for (const r of table.rows) {
      const cells = r.map(cellText);
      if (cells.every((c) => c.length === 0)) continue;
      tableRows += 1;
      sink.tableRow(cells, first);
      first = false;
    }
  };

  const cellText = (c: Cell): string =>
    cleanText(
      c.paras
        .map((p) => cleanText(p.spans.map((s) => s.text).join('')))
        .filter((t) => t.length > 0)
        .join(' '),
    );

  const readBody = (xml: string, onNote?: (text: string) => void, noteTag?: 'w:footnote' | 'w:endnote'): void => {
    const paraStack: Para[] = [];
    const tables: Table[] = [];
    let inText = false;
    let inInstr = false;
    let skipDepth = 0; // inside mc:Fallback, w:del, w:instrText containers we do not read
    let inPPr = false;
    let inRPr = false;
    let runBold = false;
    let noteSkip = false;
    let noteParas: string[] = [];

    const para = (): Para | undefined => paraStack[paraStack.length - 1];

    for (const t of xmlTokens(xml)) {
      if (t.kind === 'text') {
        const p = para();
        if (inText && !inInstr && skipDepth === 0 && p !== undefined)
          p.spans.push({ text: decodeXml(t.text), ...(runBold ? { bold: true } : {}) });
        continue;
      }
      const { name, closing, selfClosing, attrs } = t;
      if (name === 'mc:Fallback' || name === 'w:del' || name === 'w:moveFrom') {
        if (!selfClosing) skipDepth += closing ? -1 : 1;
        if (skipDepth < 0) skipDepth = 0;
        continue;
      }
      if (noteTag !== undefined && name === noteTag) {
        if (!closing) {
          noteSkip = /w:type="(?:separator|continuationSeparator|continuationNotice)"/.test(attrs);
          noteParas = [];
        } else {
          if (!noteSkip && noteParas.length > 0) onNote?.(noteParas.join(' '));
          noteSkip = false;
        }
        continue;
      }
      switch (name) {
        case 'w:p':
          if (!closing) {
            paraStack.push({ spans: [] });
            if (selfClosing) paraStack.pop();
          } else {
            const p = paraStack.pop();
            if (p === undefined) break;
            if (noteTag !== undefined) {
              const txt = cleanText(p.spans.map((s) => s.text).join(''));
              if (txt.length > 0) noteParas.push(txt);
              break;
            }
            const table = tables[tables.length - 1];
            if (table?.cell !== undefined && paraStack.length === 0) table.cell.paras.push(p);
            else emit(p);
          }
          break;
        case 'w:pPr':
          inPPr = !closing && !selfClosing;
          break;
        case 'w:rPr':
          inRPr = !closing && !selfClosing;
          break;
        case 'w:pStyle':
          if (inPPr && para() !== undefined) para()!.style = attrOf(attrs, 'w:val');
          break;
        case 'w:numId':
          if (inPPr && para() !== undefined) para()!.numId = attrOf(attrs, 'w:val');
          break;
        case 'w:ilvl':
          if (inPPr && para() !== undefined) para()!.ilvl = Number(attrOf(attrs, 'w:val') ?? '0');
          break;
        case 'w:outlineLvl':
          if (inPPr && para() !== undefined) para()!.outline = Number(attrOf(attrs, 'w:val') ?? '9');
          break;
        case 'w:r':
          if (!closing) runBold = false;
          break;
        case 'w:b':
          if (inRPr && !inPPr && !closing) runBold = toggleOn(attrs);
          break;
        case 'w:rStyle': {
          if (inRPr && !closing) {
            const id = attrOf(attrs, 'w:val');
            if (styleValue(styles, id, 'bold') === true || /^(?:strong|bold)/i.test(id ?? '')) runBold = true;
          }
          break;
        }
        case 'w:t':
          inText = !closing && !selfClosing;
          break;
        case 'w:instrText':
        case 'w:delText':
          inInstr = !closing && !selfClosing;
          break;
        case 'w:tab':
        case 'w:br':
        case 'w:cr':
          if (!closing && para() !== undefined && skipDepth === 0) para()!.spans.push({ text: ' ' });
          break;
        case 'w:noBreakHyphen':
          if (!closing && para() !== undefined) para()!.spans.push({ text: '-' });
          break;
        case 'w:sym': {
          const ch = (attrOf(attrs, 'w:char') ?? '').toUpperCase();
          const glyph = SYMBOL_BOXES[ch];
          if (glyph !== undefined && para() !== undefined && skipDepth === 0) para()!.spans.push({ text: `${glyph} ` });
          break;
        }
        case 'w:txbxContent':
          if (!closing) sawTextBox = true;
          break;
        case 'w:drawing':
        case 'w:pict':
          if (!closing) images += 1;
          break;
        case 'w:tbl':
          if (!closing) tables.push({ rows: [], row: undefined, cell: undefined });
          else {
            const done = tables.pop();
            if (done !== undefined) emitTable(done, tables[tables.length - 1]);
          }
          break;
        case 'w:tr': {
          const table = tables[tables.length - 1];
          if (table === undefined) break;
          if (!closing) table.row = [];
          else if (table.row !== undefined) {
            table.rows.push(table.row);
            table.row = undefined;
          }
          break;
        }
        case 'w:tc': {
          const table = tables[tables.length - 1];
          if (table === undefined) break;
          if (!closing) table.cell = { paras: [] };
          else if (table.cell !== undefined) {
            table.row?.push(table.cell);
            table.cell = undefined;
          }
          break;
        }
        default:
          break;
      }
    }
    while (paraStack.length > 0) emit(paraStack.shift()!);
  };

  readBody(parts.document);
  const noteTexts: string[] = [];
  if (parts.footnotes !== undefined) readBody(parts.footnotes, (t) => noteTexts.push(t), 'w:footnote');
  if (parts.endnotes !== undefined) readBody(parts.endnotes, (t) => noteTexts.push(t), 'w:endnote');
  for (const n of noteTexts) sink.footnote(n);

  if (unresolvedNumbering > 0)
    notes.push(
      `List numbering definitions are missing for ${unresolvedNumbering} numbered paragraph(s) (word/numbering.xml), so they were read as bullets without positions.`,
    );
  if (sawTextBox) notes.push('Text boxes were read in document order; their position on the page is not preserved.');
  if (images > 0)
    notes.push(`${images} image(s) or drawing(s) are not read; text inside them (a picture of a table, say) is not extracted.`);
  if (/<w:del[ >]/.test(parts.document)) notes.push('Tracked deletions are excluded; tracked insertions are included as final text.');
  const blocks = sink.blocks();
  const words = blocks.reduce((w, b) => w + (b.kind === 'table_row' ? b.cells.join(' ') : b.text).split(/\s+/).filter(Boolean).length, 0);
  return { blocks, notes, stats: { paragraphs, tableRows, words } };
}
