/**
 * Minimal, hardened DOCX text extraction with no third-party dependency.
 *
 * A .docx is a ZIP of XML parts. This reads only what is needed (`word/document.xml`, plus footnotes/endnotes), keeps
 * reading order, turns headings/lists/tables into structured text lines, and REFUSES anything it cannot read faithfully
 * (not a ZIP, zip64, unknown compression, CRC mismatch, oversize) with a specific error — it never returns garbage text.
 * Safety limits bound entry count and decompressed size, so a decompression bomb cannot exhaust memory.
 * Headers/footers are deliberately ignored (repeated boilerplate, not content); tracked deletions (`w:delText`) are ignored.
 */
import { readCentralDirectory, readZipEntry, ZipFormatError } from './zip-reader.js';
import { err, ok, type Result } from '@xo/types';
import { ErrorCode, SourceError } from '@xo/errors';

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

interface TableFrame {
  rows: string[][];
  row: string[];
  cell: string[];
}

const TOKEN = /<(\/?)w:(tbl|tr|tc|p)\b[^>]*?(\/?)>|<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\b[^>]*\/>|<w:pStyle\b[^>]*w:val="([^"]*)"[^>]*\/>|<w:numPr\b/g;

/** Block-level XML to structured lines. Exported for the footnote/endnote reuse; not part of the public surface. */
function xmlToLines(xml: string): string[] {
  const lines: string[] = [];
  const tables: TableFrame[] = [];
  let text = '';
  let style = '';
  let numbered = false;
  let inParagraph = false;

  const finishParagraph = (): void => {
    const body = text.replace(/\s+/g, ' ').trim();
    if (body.length > 0) {
      const heading = /^(?:heading\s*([1-6])|title)$/i.exec(style);
      const rendered = heading ? `${'#'.repeat(heading[1] ? Number(heading[1]) : 1)} ${body}` : numbered ? `- ${body}` : body;
      const frame = tables[tables.length - 1];
      if (frame) frame.cell.push(body);
      else lines.push(rendered);
    }
    text = '';
    style = '';
    numbered = false;
    inParagraph = false;
  };

  for (const m of xml.matchAll(TOKEN)) {
    const [whole, closing, tag, selfClosing, runText, pStyle] = m;
    if (tag !== undefined) {
      if (tag === 'p') {
        if (closing === '/') finishParagraph();
        else if (selfClosing !== '/') {
          inParagraph = true;
          text = '';
          style = '';
          numbered = false;
        }
      } else if (tag === 'tbl') {
        if (closing === '/') {
          const done = tables.pop();
          if (done) {
            const rows = done.rows.filter((r) => r.some((c) => c.length > 0)).map((r) => r.join(' | '));
            const parent = tables[tables.length - 1];
            if (parent) parent.cell.push(rows.join('; '));
            else lines.push(...rows);
          }
        } else tables.push({ rows: [], row: [], cell: [] });
      } else if (tag === 'tr') {
        const frame = tables[tables.length - 1];
        if (frame) {
          if (closing === '/') {
            frame.rows.push(frame.row);
            frame.row = [];
          } else frame.row = [];
        }
      } else if (tag === 'tc') {
        const frame = tables[tables.length - 1];
        if (frame) {
          if (closing === '/') {
            frame.row.push(frame.cell.join(' ').trim());
            frame.cell = [];
          } else frame.cell = [];
        }
      }
    } else if (runText !== undefined) {
      text += decodeEntities(runText);
    } else if (pStyle !== undefined) {
      style = pStyle;
    } else if (whole.startsWith('<w:numPr')) {
      numbered = true;
    } else if (whole.startsWith('<w:tab') || whole.startsWith('<w:br')) {
      text += ' ';
    }
  }
  if (inParagraph) finishParagraph();
  return lines;
}

function noteSection(xml: string, tag: 'footnote' | 'endnote'): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(new RegExp(`<w:${tag}\\b([^>]*)>([\\s\\S]*?)</w:${tag}>`, 'g'))) {
    if (/w:type="(?:separator|continuationSeparator|continuationNotice)"/.test(m[1] ?? '')) continue;
    const body = xmlToLines(m[2] ?? '').join(' ').trim();
    if (body.length > 0) out.push(`- ${body}`);
  }
  return out;
}

export function extractDocxText(bytes: Uint8Array): Result<string, SourceError> {
  try {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = readCentralDirectory(buf);
    const main = entries.get('word/document.xml');
    if (!main) return fail('not a Word document: the archive has no word/document.xml');
    const parts = [xmlToLines(readZipEntry(buf, main).toString('utf8')).join('\n')];
    for (const [name, tag, label] of [
      ['word/footnotes.xml', 'footnote', 'Footnotes'],
      ['word/endnotes.xml', 'endnote', 'Endnotes'],
    ] as const) {
      const entry = entries.get(name);
      if (!entry) continue;
      const notes = noteSection(readZipEntry(buf, entry).toString('utf8'), tag);
      if (notes.length > 0) parts.push(`${label}:\n${notes.join('\n')}`);
    }
    const text = parts.filter((p) => p.length > 0).join('\n\n');
    if (text.trim().length === 0) return fail('the Word document contains no extractable text');
    return ok(text);
  } catch (cause) {
    if (cause instanceof ZipFormatError) return fail(`could not read DOCX: ${cause.message}`);
    return fail(`could not read DOCX: ${(cause as Error).message}`);
  }
}
