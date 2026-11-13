import { inflateRawSync } from 'node:zlib';
import { readDocx, type DocxDocument } from '@xo/compiler';

/**
 * Reading an uploaded `.docx` at the door. The file is a ZIP from an untrusted user, so this API first holds it to its own
 * limits — entry names are only ever compared to fixed strings (never used as paths), ZIP64 / encrypted / oddly-compressed
 * entries are refused, and every part the reader will open is inflated under a cap, so a zip bomb fails with an error
 * rather than exhausting memory. The content is then read by `@xo/compiler`'s Word reader (UW-3c), the one the compile
 * step uses: list numbering and nesting from `numbering.xml`, check boxes, bold run-in titles, tables, footnotes. What it
 * does not read is reported (`notes`) instead of pretended.
 */

const MAX_COMPRESSED_BYTES = 40 * 1024 * 1024;
const MAX_XML_BYTES = 30 * 1024 * 1024;
const MAX_ENTRIES = 5000;

export interface DocxExtraction {
  readonly text: string;
  readonly notes: readonly string[];
  readonly stats: { readonly paragraphs: number; readonly tableRows: number; readonly words: number };
}

export class DocxError extends Error {}

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

function readEntries(zip: Buffer): ZipEntry[] {
  if (zip.length < 22 || zip.length > MAX_COMPRESSED_BYTES) throw new DocxError('not a readable .docx (size out of range)');
  // End of central directory record: search backwards (it may be followed by a comment of up to 65535 bytes).
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new DocxError('not a .docx: no ZIP directory found');
  const total = zip.readUInt16LE(eocd + 10);
  const cdSize = zip.readUInt32LE(eocd + 12);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new DocxError('ZIP64 archives are not supported');
  if (total > MAX_ENTRIES) throw new DocxError('archive has too many entries');
  if (cdOffset + cdSize > zip.length) throw new DocxError('corrupt ZIP directory');

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new DocxError('corrupt ZIP directory entry');
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const compressedSize = zip.readUInt32LE(p + 20);
    const uncompressedSize = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, method, flags, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(zip: Buffer, entry: ZipEntry): Buffer {
  if ((entry.flags & 0x1) !== 0) throw new DocxError('encrypted .docx files are not supported');
  if (entry.uncompressedSize > MAX_XML_BYTES) throw new DocxError(`"${entry.name}" is too large to read safely`);
  const o = entry.localOffset;
  if (o + 30 > zip.length || zip.readUInt32LE(o) !== 0x04034b50) throw new DocxError('corrupt ZIP entry');
  const nameLen = zip.readUInt16LE(o + 26);
  const extraLen = zip.readUInt16LE(o + 28);
  const start = o + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > zip.length) throw new DocxError('corrupt ZIP entry (truncated)');
  const raw = zip.subarray(start, end);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method !== 8) throw new DocxError(`unsupported ZIP compression method ${entry.method}`);
  try {
    return inflateRawSync(raw, { maxOutputLength: MAX_XML_BYTES });
  } catch {
    throw new DocxError(`"${entry.name}" could not be decompressed (corrupt, or larger than the safety limit)`);
  }
}

/** The Word parts the compiler reads; each is held to this API's inflation cap before the compiler sees the file. */
const READ_PARTS = /^word\/(?:document|numbering|styles|footnotes|endnotes)\.xml$/;

/**
 * Checks the file against this API's limits, then reads it with the compiler's Word reader — the same reader the compile
 * step uses on these bytes, so what the uploader is told here (notes, counts, a refusal) is what compiling will do.
 */
export function extractDocxText(bytes: Uint8Array): DocxExtraction {
  const zip = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = readEntries(zip);
  if (!entries.some((e) => e.name === 'word/document.xml')) throw new DocxError('not a Word document: word/document.xml is missing');
  for (const e of entries) if (READ_PARTS.test(e.name)) readEntry(zip, e);

  const read = readDocx(bytes);
  if (!read.ok) throw new DocxError(read.error.message.replace(/^could not read DOCX: /, '').replace(/^the Word document/, 'the document'));
  const doc = read.value;
  const text = renderText(doc);
  if (text.length === 0) throw new DocxError('the document contains no extractable text');
  const words = text.split(/\s+/).filter(Boolean).length;
  return { text, notes: doc.notes, stats: { paragraphs: doc.stats.paragraphs, tableRows: doc.stats.tableRows, words } };
}

/** A plain-text view for people: `#` headings, `- ` / `N. ` items (indented by level, with check boxes), `| a | b |` rows. */
function renderText(doc: DocxDocument): string {
  const lines: string[] = [];
  for (const b of doc.blocks) {
    if (b.kind === 'heading') lines.push(`${'#'.repeat(Math.min(b.level, 6))} ${b.text}`);
    else if (b.kind === 'list_item') {
      const box = b.checkbox === 'checked' ? '[x] ' : b.checkbox === 'unchecked' ? '[ ] ' : '';
      lines.push(`${'  '.repeat(b.depth ?? 0)}${b.listKind === 'ordered' ? (b.marker ?? `${b.ordinal ?? 1}.`) : '-'} ${box}${b.text}`);
    } else if (b.kind === 'table_row') lines.push(`| ${b.cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`);
    else if (b.kind === 'paragraph') lines.push(b.text);
  }
  const parts = [lines.join('\n')];
  if (doc.footnotes.length > 0) parts.push(`Footnotes:\n${doc.footnotes.map((n) => `- ${n}`).join('\n')}`);
  if (doc.endnotes.length > 0) parts.push(`Endnotes:\n${doc.endnotes.map((n) => `- ${n}`).join('\n')}`);
  return parts
    .filter((x) => x.trim().length > 0)
    .join('\n\n')
    .trim();
}
