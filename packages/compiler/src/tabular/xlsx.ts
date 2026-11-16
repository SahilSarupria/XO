/**
 * Typed XLSX cell reader (UW-3). Reads every sheet into a grid of cells that keep exactly what was stored: shared, inline and formula
 * strings; number literals as written; booleans; error values; dates ONLY where the cell's own number format declares a date (read in the
 * workbook's 1900 or 1904 date system, with the serial kept). Formulas are recorded and never evaluated: the value is the result the
 * workbook cached. Merged ranges and hidden sheets are reported, never filled in or skipped.
 *
 * Hostile input is refused loudly: anything the hardened ZIP reader refuses (bombs, zip64, bad CRCs, too many entries), any XML part with
 * a DOCTYPE (entity expansion and external entities), shared-string indexes out of range, and anything past the tabular limits.
 */
import { err, ok, type Result } from '@xo/types';
import { ErrorCode, SourceError } from '@xo/errors';
import { readCentralDirectory, readZipEntry, ZipFormatError, type ZipEntry } from '../sources/zip-reader.js';
import { TABULAR_LIMITS, type TabularLimits } from './limits.js';
import { cellRef, parseA1 } from './refs.js';
import type { SheetGrid, TabularCell, TabularFinding } from './types.js';

export interface XlsxWorkbook {
  readonly sheets: readonly SheetGrid[];
  readonly dateSystem: 1900 | 1904;
  readonly findings: readonly TabularFinding[];
}

class Refusal extends Error {}

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_m, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_m, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function safeCodePoint(cp: number): string {
  return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '�';
}

/** A DOCTYPE is how both entity-expansion bombs and external-entity reads start; no legitimate workbook part needs one. */
function guardXml(name: string, xml: string): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Refusal(`the part "${name}" declares a DOCTYPE or entities, which workbooks never need`);
  return xml;
}

function textRuns(xml: string): string {
  const withoutPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of withoutPhonetic.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += decodeXmlEntities(m[1] ?? '');
  return out;
}

const attr = (attrs: string, name: string): string | undefined => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];

/** Built-in number formats that are dates or times (ECMA-376 §18.8.30, plus the common locale-specific ids). */
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);
const BUILTIN_FORMAT_CODES: Readonly<Record<number, string>> = {
  9: '0%',
  10: '0.00%',
  14: 'mm-dd-yy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yy h:mm',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mmss.0',
};

/** True when a custom format code shows a date or time: date/time tokens remain once quoted text, escapes and [colour] blocks are removed. */
export function isDateFormatCode(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[(?!h\]|m\]|s\])[^\]]*\]/gi, '')
    .split(';')[0]!;
  if (/^general$/i.test(stripped.trim())) return false;
  return /[dmyhs]/i.test(stripped) && !/^[#0.,%\s?E+-]*$/i.test(stripped);
}

/** The ISO reading of a date serial in the workbook's date system (wall clock, no time zone). */
export function serialToIso(serial: number, system: 1900 | 1904): string {
  // 1900 system: day 1 is 1900-01-01, and serial 60 is the non-existent 1900-02-29 (kept by Excel for Lotus compatibility).
  const epoch = system === 1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  const whole = Math.floor(serial);
  const dayOffset = system === 1900 && whole >= 60 ? whole - 1 : whole;
  const ms = epoch + dayOffset * 86_400_000 + Math.round((serial - whole) * 86_400_000);
  const d = new Date(ms);
  const date = d.toISOString().slice(0, 10);
  return serial === whole ? date : `${date}T${d.toISOString().slice(11, 19)}`;
}

export function readXlsxWorkbook(
  bytes: Uint8Array,
  options: { readonly limits?: Partial<TabularLimits> } = {},
): Result<XlsxWorkbook, SourceError> {
  const limits: TabularLimits = { ...TABULAR_LIMITS, ...options.limits };
  try {
    return ok(read(bytes, limits));
  } catch (cause) {
    const message = cause instanceof Refusal || cause instanceof ZipFormatError ? cause.message : (cause as Error).message;
    return err(new SourceError(ErrorCode.PRECONDITION_FAILED, `cannot read this workbook: ${message}`));
  }
}

function read(bytes: Uint8Array, limits: TabularLimits): XlsxWorkbook {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = readCentralDirectory(buf);
  const part = (e: ZipEntry | undefined, name: string): string | undefined =>
    e === undefined ? undefined : guardXml(name, readZipEntry(buf, e).toString('utf8'));

  const workbook = part(entries.get('xl/workbook.xml'), 'xl/workbook.xml');
  if (workbook === undefined) throw new Refusal('the archive has no xl/workbook.xml, so it is not an Excel workbook');
  const dateSystem: 1900 | 1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(workbook) ? 1904 : 1900;

  const targets = new Map<string, string>();
  for (const m of (part(entries.get('xl/_rels/workbook.xml.rels'), 'xl/_rels/workbook.xml.rels') ?? '').matchAll(
    /<Relationship\b([^>]*)\/?>/g,
  )) {
    const id = attr(m[1] ?? '', 'Id');
    const target = attr(m[1] ?? '', 'Target');
    if (id !== undefined && target !== undefined)
      targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  }

  const shared = [
    ...(part(entries.get('xl/sharedStrings.xml'), 'xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g),
  ].map((m) => textRuns(m[1] ?? ''));

  // Styles: cellXfs index -> number format code, and whether that format is a date.
  const stylesXml = part(entries.get('xl/styles.xml'), 'xl/styles.xml') ?? '';
  const custom = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const id = Number(attr(m[1] ?? '', 'numFmtId'));
    const code = attr(m[1] ?? '', 'formatCode');
    if (Number.isInteger(id) && code !== undefined) custom.set(id, decodeXmlEntities(code));
  }
  const xfs: { code?: string; date: boolean }[] = [];
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  for (const m of cellXfs.matchAll(/<xf\b([^>]*?)(?:\/>|>)/g)) {
    const id = Number(attr(m[1] ?? '', 'numFmtId') ?? '0');
    const code = custom.get(id) ?? BUILTIN_FORMAT_CODES[id];
    xfs.push({
      ...(code !== undefined ? { code } : {}),
      date: custom.has(id) ? isDateFormatCode(custom.get(id)!) : BUILTIN_DATE_FORMATS.has(id),
    });
  }

  const findings: TabularFinding[] = [];
  const sheets: SheetGrid[] = [];
  let total = 0;
  let fictitious = false;
  const sheetDecls = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)];
  if (sheetDecls.length > limits.maxSheets) throw new Refusal(`it has ${sheetDecls.length} sheets (limit ${limits.maxSheets})`);
  for (const [i, m] of sheetDecls.entries()) {
    const attrs = m[1] ?? '';
    const name = decodeXmlEntities(attr(attrs, 'name') ?? `Sheet${i + 1}`);
    const rid = /\br:id="([^"]*)"/.exec(attrs)?.[1];
    const path = rid !== undefined ? targets.get(rid) : undefined;
    if (path === undefined) throw new Refusal(`sheet "${name}" has no resolvable worksheet part`);
    const xml = part(entries.get(path), path);
    if (xml === undefined) throw new Refusal(`sheet "${name}" points to a missing part "${path}"`);
    const hidden = /\bstate="(hidden|veryHidden)"/.test(attrs);
    if (hidden)
      findings.push({
        code: 'HIDDEN_SHEET',
        ref: name,
        message: `sheet "${name}" is hidden in the workbook; its data was read and is marked hidden`,
      });

    const rows: { row: number; cells: TabularCell[] }[] = [];
    let implicitRow = 0;
    for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const rAttr = attr(rm[1] ?? '', 'r');
      const rowNumber = rAttr !== undefined ? Number(rAttr) : implicitRow + 1;
      if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > limits.maxRows)
        throw new Refusal(`sheet "${name}" has an invalid row number "${rAttr}"`);
      implicitRow = rowNumber;
      const cells: TabularCell[] = [];
      let implicitCol = 0;
      for (const c of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const cAttrs = c[1] ?? '';
        const inner = c[2] ?? '';
        const refAttr = attr(cAttrs, 'r');
        const pos = refAttr !== undefined ? parseA1(refAttr) : { column: implicitCol + 1, row: rowNumber };
        if (pos === undefined || pos.column > limits.maxColumns)
          throw new Refusal(`sheet "${name}" has an invalid cell reference "${refAttr}"`);
        implicitCol = pos.column;
        const type = attr(cAttrs, 't') ?? 'n';
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        const f = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(inner)?.[1];
        const styleIndex = Number(attr(cAttrs, 's') ?? '0');
        const style = xfs[styleIndex];
        let raw: string;
        let kind: TabularCell['kind'];
        if (type === 's') {
          if (v === undefined) continue;
          const idx = Number(v);
          if (!Number.isInteger(idx) || idx < 0 || idx >= shared.length)
            throw new Refusal(`cell ${name}!${refAttr} points to shared string ${v}, which does not exist`);
          raw = shared[idx]!;
          kind = 'string';
        } else if (type === 'inlineStr') {
          raw = textRuns(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '');
          kind = 'string';
        } else if (type === 'str') {
          raw = decodeXmlEntities(v ?? '');
          kind = 'string';
        } else if (type === 'b') {
          if (v !== '1' && v !== '0') continue;
          raw = v;
          kind = 'boolean';
        } else if (type === 'e') {
          raw = decodeXmlEntities(v ?? '');
          kind = 'error';
        } else {
          if (v === undefined || v.trim() === '') continue;
          raw = v.trim();
          if (!Number.isFinite(Number(raw))) throw new Refusal(`cell ${name}!${refAttr} is a number cell holding "${raw.slice(0, 40)}"`);
          kind = style?.date === true ? 'date' : 'number';
        }
        if (raw.length === 0) continue;
        if (raw.length > limits.maxCellChars) throw new Refusal(`cell ${name}!${refAttr} is longer than ${limits.maxCellChars} characters`);
        if (++total > limits.maxCells) throw new Refusal(`it has more than ${limits.maxCells} values`);
        const serial = kind === 'date' ? Number(raw) : undefined;
        if (serial !== undefined && dateSystem === 1900 && Math.floor(serial) === 60) fictitious = true;
        cells.push({
          ref: cellRef(name, pos.column, pos.row),
          row: pos.row,
          column: pos.column,
          raw,
          kind,
          ...(f !== undefined ? { formula: decodeXmlEntities(f) } : {}),
          ...(style?.code !== undefined ? { numberFormat: style.code } : {}),
          ...(serial !== undefined && serial >= 0 ? { date: { serial, system: dateSystem, iso: serialToIso(serial, dateSystem) } } : {}),
        });
      }
      if (cells.length > 0) rows.push({ row: rowNumber, cells: cells.sort((a, b) => a.column - b.column) });
    }
    rows.sort((a, b) => a.row - b.row);
    const merges = [...xml.matchAll(/<mergeCell\b[^>]*\bref="([^"]+)"/g)].map((mm) => mm[1]!);
    sheets.push({ name, index: i + 1, rows, merges, ...(hidden ? { hidden: true } : {}) });
  }
  if (fictitious) {
    findings.push({
      code: 'FICTITIOUS_DATE',
      message:
        'a date cell holds serial 60, the non-existent 29 February 1900 that Excel keeps for Lotus compatibility; it reads as 1900-02-28',
    });
  }
  return { sheets, dateSystem, findings };
}
