/**
 * Reading a Word (.docx) document, with no third-party dependency.
 *
 * A .docx is a ZIP of XML parts. `readDocx` reads only what it needs (`word/document.xml`, its numbering and styles, and the
 * footnotes and endnotes), refuses anything it cannot read faithfully (not a ZIP, zip64, unknown compression, CRC mismatch,
 * oversize) with a specific error, and turns the document into blocks (`structured-blocks/docx-blocks.ts`). Safety limits bound
 * entry count and decompressed size, so a decompression bomb cannot exhaust memory, and the XML is tokenised in linear time.
 *
 * `extractDocxText` is the earlier plain-text view of the same reading (headings as `#`, list items as `- ` or `N. `, table rows
 * as `a | b`), kept for callers that want text.
 */
import { readCentralDirectory, readZipEntry, ZipFormatError, type ZipEntry } from './zip-reader.js';
import { err, ok, type Result } from '@xo/types';
import { ErrorCode, SourceError } from '@xo/errors';
import { docxBlocks, type DocxRead } from './structured-blocks/docx-blocks.js';

const fail = (message: string): Result<never, SourceError> => err(new SourceError(ErrorCode.PRECONDITION_FAILED, message));

export interface DocxDocument extends DocxRead {
  readonly footnotes: readonly string[];
  readonly endnotes: readonly string[];
}

function partsOf(entries: Map<string, ZipEntry>, readEntry: (e: ZipEntry) => Buffer) {
  const text = (name: string): string | undefined => {
    const e = entries.get(name);
    return e === undefined ? undefined : readEntry(e).toString('utf8');
  };
  return {
    document: text('word/document.xml'),
    numbering: text('word/numbering.xml'),
    styles: text('word/styles.xml'),
    footnotes: text('word/footnotes.xml'),
    endnotes: text('word/endnotes.xml'),
  };
}

/** The document as blocks, with what was not read (`notes`) and simple counts. Fails with a specific, honest error. */
export function readDocx(bytes: Uint8Array): Result<DocxDocument, SourceError> {
  try {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = readCentralDirectory(buf);
    if (!entries.has('word/document.xml')) return fail('not a Word document: word/document.xml is missing');
    const parts = partsOf(entries, (e) => readZipEntry(buf, e));
    const read = docxBlocks({
      document: parts.document!,
      ...(parts.numbering !== undefined ? { numbering: parts.numbering } : {}),
      ...(parts.styles !== undefined ? { styles: parts.styles } : {}),
    });
    const footnotes = parts.footnotes !== undefined ? docxNotes(parts.footnotes, 'w:footnote') : [];
    const endnotes = parts.endnotes !== undefined ? docxNotes(parts.endnotes, 'w:endnote') : [];
    const blocks = [...read.blocks, ...[...footnotes, ...endnotes].map((text) => ({ kind: 'footnote' as const, text }))];
    if (blocks.length === 0) return fail('the Word document contains no extractable text');
    const notes = [...read.notes];
    const names = [...entries.keys()];
    if (names.some((n) => /^word\/(header|footer)\d*\.xml$/.test(n)))
      notes.push('Headers and footers are not read (repeated page furniture, not content).');
    if (names.some((n) => /^word\/comments\.xml$/.test(n))) notes.push('Comments are not read.');
    return ok({ ...read, blocks, notes, footnotes, endnotes });
  } catch (cause) {
    if (cause instanceof ZipFormatError) return fail(`could not read DOCX: ${cause.message}`);
    return fail(`could not read DOCX: ${(cause as Error).message}`);
  }
}

/** Footnote or endnote texts, in order; Word's separator notes are skipped. */
function docxNotes(xml: string, tag: 'w:footnote' | 'w:endnote'): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}\\b`, 'g');
  // Split on the note elements linearly, then read each note's body as a tiny document.
  const starts: number[] = [];
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) starts.push(m.index);
  for (let k = 0; k < starts.length; k++) {
    const chunk = xml.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : xml.length);
    const head = chunk.slice(0, chunk.indexOf('>') + 1);
    if (/w:type="(?:separator|continuationSeparator|continuationNotice)"/.test(head)) continue;
    const body = docxBlocks({ document: chunk }).blocks.map((b) => (b.kind === 'table_row' ? b.cells.join(' | ') : b.text));
    const text = body.join(' ').trim();
    if (text.length > 0) out.push(text);
  }
  return out;
}

/** The plain-text view: `#` headings, `- ` / `N. ` list items, `a | b` table rows, then labelled footnotes and endnotes. */
export function extractDocxText(bytes: Uint8Array): Result<string, SourceError> {
  const read = readDocx(bytes);
  if (!read.ok) return read;
  const lines: string[] = [];
  for (const b of read.value.blocks) {
    if (b.kind === 'heading') lines.push(`${'#'.repeat(b.level)} ${b.text}`);
    else if (b.kind === 'list_item') {
      const box = b.checkbox === 'checked' ? '[x] ' : b.checkbox === 'unchecked' ? '[ ] ' : '';
      lines.push(`${'  '.repeat(b.depth ?? 0)}${b.listKind === 'ordered' ? `${b.ordinal ?? 1}.` : '-'} ${box}${b.text}`);
    } else if (b.kind === 'table_row') lines.push(b.cells.join(' | '));
    else if (b.kind === 'paragraph') lines.push(b.text);
  }
  const parts = [lines.join('\n')];
  if (read.value.footnotes.length > 0) parts.push(`Footnotes:\n${read.value.footnotes.map((n) => `- ${n}`).join('\n')}`);
  if (read.value.endnotes.length > 0) parts.push(`Endnotes:\n${read.value.endnotes.map((n) => `- ${n}`).join('\n')}`);
  const text = parts.filter((p) => p.length > 0).join('\n\n');
  if (text.trim().length === 0) return fail('the Word document contains no extractable text');
  return ok(text);
}
