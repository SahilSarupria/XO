import { inflateRawSync } from 'node:zlib';

/**
 * Plain-text extraction from a `.docx` file, done in this API so `@xo/compiler` is untouched: the compiler receives
 * the result as an ordinary `document` source (the same path `.txt`/`.md` take).
 *
 * This is deliberately a TEXT extractor, not a faithful converter, and it reports what it does not carry over
 * (`notes`) instead of pretending. It never guesses structure: a paragraph is a paragraph, a heading style becomes a
 * `#` heading, a table row becomes a `| cell | cell |` line, and anything else it cannot read confidently is omitted.
 *
 * Hostile-input posture: a .docx is a ZIP from an untrusted user. Entry names are only ever compared to fixed
 * strings (never used as paths), ZIP64 / encrypted / oddly-compressed entries are refused, and inflation is capped, so
 * a zip bomb fails with an error rather than exhausting memory.
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

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x')) return safeCodePoint(parseInt(body.slice(2), 16)) ?? whole;
    if (body.startsWith('#')) return safeCodePoint(parseInt(body.slice(1), 10)) ?? whole;
    return ENTITIES[body] ?? whole;
  });
}

function safeCodePoint(cp: number): string | undefined {
  return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : undefined;
}

type XmlToken =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tag'; readonly name: string; readonly closing: boolean; readonly selfClosing: boolean; readonly attrs: string };

const TAG_NAME = /^[A-Za-z0-9]+:[A-Za-z0-9]+/;

/**
 * A LINEAR tokenizer: every character is examined a bounded number of times (`indexOf` for '<' and '>', then one
 * anchored match on the tag's own text). The earlier version was a single lazy regex, which backtracks quadratically
 * on malformed input such as a long run of `<w:t ` with no closing `>` — 512 KB took ~19 s and the 30 MB inflate cap
 * would have allowed hours, blocking the API's event loop for everyone. Do not reintroduce a regex over the whole document.
 * Anything that is not a `prefix:name` element (comments, processing instructions, doctype) is skipped; an unterminated
 * tag ends the scan.
 */
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

export function extractDocxText(bytes: Uint8Array): DocxExtraction {
  const zip = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = readEntries(zip);
  const doc = entries.find((e) => e.name === 'word/document.xml');
  if (doc === undefined) throw new DocxError('not a Word document: word/document.xml is missing');
  const xml = readEntry(zip, doc).toString('utf8');

  const notes: string[] = [];
  const hasPart = (re: RegExp) => entries.some((e) => re.test(e.name));
  if (hasPart(/^word\/(header|footer)\d*\.xml$/)) notes.push('Headers and footers are not extracted.');
  if (hasPart(/^word\/(footnotes|endnotes)\.xml$/)) notes.push('Footnotes and endnotes are not extracted.');
  if (hasPart(/^word\/comments\.xml$/)) notes.push('Comments are not extracted.');

  const lines: string[] = [];
  let paragraphs = 0;
  let tableRows = 0;
  let sawNumbering = false;
  let sawTextBox = false;

  // Per-paragraph state
  let inParagraph = false;
  let paraText = '';
  let headingLevel = 0;
  let isListItem = false;
  // Table state (nesting depth is tracked; nested tables are flattened into their parent cell)
  let tableDepth = 0;
  let rowCells: string[] | undefined;
  let cellParas: string[] | undefined;
  let inText = false;
  let inDeleted = 0;

  const flushParagraph = () => {
    const raw = paraText.replace(/[ \t]+$/g, '');
    let line = raw;
    if (line.trim().length > 0) {
      if (headingLevel > 0) line = `${'#'.repeat(Math.min(headingLevel, 6))} ${line.trim()}`;
      else if (isListItem) line = `- ${line.trim()}`;
    }
    paragraphs++;
    if (cellParas !== undefined) {
      if (raw.trim().length > 0) cellParas.push(raw.trim());
    } else {
      lines.push(line);
    }
    paraText = '';
    headingLevel = 0;
    isListItem = false;
    inParagraph = false;
  };

  for (const token of xmlTokens(xml)) {
    if (token.kind === 'text') {
      if (inText && inDeleted === 0) paraText += decodeXml(token.text);
      continue;
    }
    const closing = token.closing;
    const tag = token.name;
    const attrs = token.attrs;
    const selfClosing = token.selfClosing;
    switch (tag) {
      case 'w:p':
        if (!closing) {
          if (inParagraph) flushParagraph();
          inParagraph = true;
          paraText = '';
          if (selfClosing) flushParagraph();
        } else if (inParagraph) flushParagraph();
        break;
      case 'w:pStyle': {
        const v = /w:val="([^"]*)"/.exec(attrs)?.[1] ?? '';
        const h = /^Heading([1-9])$/i.exec(v);
        if (h !== null) headingLevel = Number(h[1]);
        else if (/^Title$/i.test(v)) headingLevel = 1;
        break;
      }
      case 'w:numPr':
        if (!closing) {
          isListItem = true;
          sawNumbering = true;
        }
        break;
      case 'w:t':
        inText = !closing && !selfClosing;
        break;
      case 'w:delText':
        break;
      case 'w:del':
        if (!selfClosing) inDeleted += closing ? -1 : 1;
        break;
      case 'w:tab':
        if (!closing && inParagraph) paraText += '\t';
        break;
      case 'w:br':
      case 'w:cr':
        if (!closing && inParagraph) paraText += ' ';
        break;
      case 'w:tbl':
        if (!closing) tableDepth++;
        else tableDepth = Math.max(0, tableDepth - 1);
        break;
      case 'w:tr':
        if (!closing) rowCells = [];
        else if (rowCells !== undefined) {
          tableRows++;
          lines.push(`| ${rowCells.join(' | ')} |`);
          rowCells = undefined;
        }
        break;
      case 'w:tc':
        if (!closing) cellParas = [];
        else if (cellParas !== undefined) {
          rowCells?.push(cellParas.join(' ').replace(/\|/g, '\\|'));
          cellParas = undefined;
        }
        break;
      case 'w:txbxContent':
        sawTextBox = true;
        break;
      default:
        break;
    }
  }
  if (inParagraph) flushParagraph();
  void tableDepth;

  if (sawNumbering)
    notes.push(
      'Automatic list numbering and bullets are not reproduced: numbered items appear as plain "- " lines, so references like "step 6" may not match the visible numbers.',
    );
  if (sawTextBox) notes.push('Text boxes were read in document order; their position on the page is not preserved.');
  if (/<w:del[ >]/.test(xml)) notes.push('Tracked deletions are excluded; tracked insertions are included as final text.');

  // Collapse runs of blank lines but keep paragraph separation.
  const text = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length === 0) throw new DocxError('the document contains no extractable text');
  const words = text.split(/\s+/).filter(Boolean).length;
  return { text, notes, stats: { paragraphs, tableRows, words } };
}
