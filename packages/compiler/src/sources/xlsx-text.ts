/**
 * Dependency-free XLSX text extraction. Reads `xl/workbook.xml` (sheet names/order), its relationships (sheet parts),
 * `xl/sharedStrings.xml`, and each worksheet's cells; renders every non-empty row as one pipe-separated line under a
 * `## <sheet name>` heading so row/column structure survives into the shared document pipeline.
 *
 * Cell values: shared/inline/formula strings, numbers (raw, as stored — date serials are NOT guessed into dates), booleans
 * (TRUE/FALSE) and cached formula results. Empty cells inside a row keep their column position. Anything that cannot be read
 * faithfully (not a ZIP, no workbook, a sheet part that is missing) is refused with a specific error; limits come from the
 * shared hardened ZIP reader.
 */
import { err, ok, type Result } from '@xo/types';
import { ErrorCode, SourceError } from '@xo/errors';
import { readCentralDirectory, readZipEntry, ZipFormatError, type ZipEntry } from './zip-reader.js';

const fail = (message: string): Result<never, SourceError> => err(new SourceError(ErrorCode.PRECONDITION_FAILED, message));

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Concatenated text of every `<t>` run inside one XML fragment (rich-text runs join; phonetic runs are excluded). */
function textRuns(xml: string): string {
  const withoutPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of withoutPhonetic.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += decodeEntities(m[1] ?? '');
  return out;
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textRuns(m[1] ?? ''));
}

function sheetRows(xml: string, shared: readonly string[]): string[] {
  const lines: string[] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1] ?? '';
      const inner = c[2] ?? '';
      const ref = /\br="([A-Za-z]+\d*)"/.exec(attrs)?.[1] ?? 'A1';
      const type = /\bt="([^"]*)"/.exec(attrs)?.[1] ?? 'n';
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = '';
      if (type === 's') value = v !== undefined ? (shared[Number(v)] ?? '') : '';
      else if (type === 'inlineStr') value = textRuns(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '');
      else if (type === 'b') value = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : '';
      else if (v !== undefined) value = decodeEntities(v);
      const idx = columnIndex(ref);
      while (cells.length < idx) cells.push('');
      cells[idx] = value.replace(/\s+/g, ' ').trim();
    }
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    if (cells.some((x) => x.length > 0)) lines.push(cells.join(' | '));
  }
  return lines;
}

export function extractXlsxText(bytes: Uint8Array): Result<string, SourceError> {
  try {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = readCentralDirectory(buf);
    const read = (e: ZipEntry | undefined): string | undefined => (e === undefined ? undefined : readZipEntry(buf, e).toString('utf8'));

    const workbook = read(entries.get('xl/workbook.xml'));
    if (workbook === undefined) return fail('not an Excel workbook: the archive has no xl/workbook.xml');
    const relsXml = read(entries.get('xl/_rels/workbook.xml.rels')) ?? '';
    const targets = new Map<string, string>();
    for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      const id = /\bId="([^"]*)"/.exec(m[1] ?? '')?.[1];
      const target = /\bTarget="([^"]*)"/.exec(m[1] ?? '')?.[1];
      if (id !== undefined && target !== undefined) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    }
    const shared = parseSharedStrings(read(entries.get('xl/sharedStrings.xml')) ?? '');

    const sections: string[] = [];
    for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
      const attrs = m[1] ?? '';
      const name = decodeEntities(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? 'Sheet');
      const rid = /\br:id="([^"]*)"/.exec(attrs)?.[1];
      const path = rid !== undefined ? targets.get(rid) : undefined;
      if (path === undefined) return fail(`could not read XLSX: sheet "${name}" has no resolvable worksheet part`);
      const part = entries.get(path);
      if (part === undefined) return fail(`could not read XLSX: sheet "${name}" points to a missing part "${path}"`);
      const rows = sheetRows(readZipEntry(buf, part).toString('utf8'), shared);
      if (rows.length > 0) sections.push(`## ${name}\n${rows.join('\n')}`);
    }
    if (sections.length === 0) return fail('the workbook contains no extractable text');
    return ok(sections.join('\n\n'));
  } catch (cause) {
    return fail(`could not read XLSX: ${cause instanceof ZipFormatError ? cause.message : (cause as Error).message}`);
  }
}
