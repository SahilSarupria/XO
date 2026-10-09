import { PdfError, ErrorCode } from '@xo/errors';
import { Lexer } from './lexer.js';
import { ObjectParser } from './object-parser.js';
import { decodeStream } from './filters.js';
import { isArray, isDictionary, isName, isStream, type PdfDictionary } from './types.js';

export interface XrefEntry {
  /** Byte offset of `<n> <g> obj` in the file — meaningful only when `compressed` is absent (type-1 entries). */
  readonly byteOffset: number;
  readonly generation: number;
  readonly free: boolean;
  /** Present for a type-2 cross-reference-stream entry (ISO 32000-1 §7.5.8, Table 18): the object is not a top-level `obj`, it lives inside another object's `/Type /ObjStm` compressed object stream, at this index within it. */
  readonly compressed?: { readonly streamObjectNumber: number; readonly indexInStream: number };
}

export interface XrefTable {
  readonly entriesByObjectNumber: ReadonlyMap<number, XrefEntry>;
  readonly trailer: PdfDictionary;
}

const STARTXREF_KEYWORD = Buffer.from('startxref', 'latin1');

/** Finds the byte offset of the last `startxref` keyword and reads the offset number that follows it. */
function findStartxrefOffset(buf: Uint8Array): number {
  const idx = Buffer.from(buf).lastIndexOf(STARTXREF_KEYWORD);
  if (idx === -1) {
    throw new PdfError(ErrorCode.PDF_MALFORMED, 'No "startxref" keyword found');
  }
  const lexer = new Lexer(buf, idx + STARTXREF_KEYWORD.length);
  const numTok = lexer.next();
  const offset = Number.parseInt(numTok.text, 10);
  if (Number.isNaN(offset)) {
    throw new PdfError(ErrorCode.PDF_MALFORMED, `"startxref" was not followed by a number (at byte offset ${idx})`);
  }
  return offset;
}

/** Merges `earlier` into `entries` without overriding any object number `entries` already defines — the standard "later/closer section wins" precedence used for every source of xref entries in this file (`/Prev` chains, hybrid `/XRefStm` sections, either xref representation). */
function mergeOlder(entries: Map<number, XrefEntry>, earlier: ReadonlyMap<number, XrefEntry>): void {
  for (const [objNum, entry] of earlier) {
    if (!entries.has(objNum)) entries.set(objNum, entry);
  }
}

function followPrevChain(buf: Uint8Array, trailer: PdfDictionary, entries: Map<number, XrefEntry>, seenOffsets: Set<number>): void {
  // Hybrid-reference file (ISO 32000-1 §7.5.8.4): a classic xref table's trailer
  // may point to a supplemental cross-reference *stream* holding entries for
  // objects a classic table can't describe (namely, compressed/type-2 entries) —
  // written this way so older readers that only understand classic tables can
  // still open the file (they just won't see anything only reachable via
  // /XRefStm), while readers that support streams get the full object set.
  const xrefStm = trailer.entries.get('XRefStm');
  if (typeof xrefStm === 'number' && !seenOffsets.has(xrefStm)) {
    mergeOlder(entries, parseXrefSectionChain(buf, xrefStm, seenOffsets).entriesByObjectNumber);
  }
  const prev = trailer.entries.get('Prev');
  if (typeof prev === 'number') {
    mergeOlder(entries, parseXrefSectionChain(buf, prev, seenOffsets).entriesByObjectNumber);
  }
}

/** Parses one classic cross-reference table section (`xref` ... `trailer` << ... >>) starting exactly at `offset`. Assumes the literal `xref` keyword is next; callers dispatch here only after confirming that. */
function parseClassicXrefSection(buf: Uint8Array, offset: number, seenOffsets: Set<number>): XrefTable {
  const lexer = new Lexer(buf, offset);
  lexer.next(); // the already-confirmed "xref" keyword

  const entries = new Map<number, XrefEntry>();
  for (;;) {
    const savedPos = lexer.position;
    const startTok = lexer.next();
    if (startTok.kind !== 'number') {
      lexer.seek(savedPos);
      break; // reached the "trailer" keyword
    }
    const countTok = lexer.next();
    const start = Number.parseInt(startTok.text, 10);
    const count = Number.parseInt(countTok.text, 10);
    for (let i = 0; i < count; i += 1) {
      const offsetTok = lexer.next();
      const genTok = lexer.next();
      const typeTok = lexer.next();
      const objectNumber = start + i;
      if (!entries.has(objectNumber)) {
        entries.set(objectNumber, {
          byteOffset: Number.parseInt(offsetTok.text, 10),
          generation: Number.parseInt(genTok.text, 10),
          free: typeTok.text === 'f',
        });
      }
    }
  }

  const trailerTok = lexer.next();
  if (trailerTok.text !== 'trailer') {
    throw new PdfError(ErrorCode.PDF_MALFORMED, `Expected "trailer" keyword after xref table at byte offset ${lexer.position}`);
  }
  const trailerParser = new ObjectParser(buf, lexer.position);
  const trailer = trailerParser.parseValue();
  if (!isDictionary(trailer)) {
    throw new PdfError(ErrorCode.PDF_MALFORMED, 'Trailer is not a dictionary');
  }

  followPrevChain(buf, trailer, entries, seenOffsets);
  return { entriesByObjectNumber: entries, trailer };
}

/**
 * Parses one cross-reference *stream* section (ISO 32000-1 §7.5.8) at
 * `offset` — the PDF-1.5+ alternative to a classic `xref` table, itself an
 * indirect object `<n> <g> obj << /Type /XRef ... >> stream ... endstream`
 * whose decoded body is a flat array of fixed-width binary records, one
 * per object, per the dictionary's `/W` field widths. This is also how a
 * modern writer's `/Index`-based free-list works and how type-2
 * (compressed-object) entries are represented — a classic table has no way
 * to express "this object lives inside an /ObjStm", which is exactly why a
 * PDF using compressed object streams necessarily uses this format for at
 * least its own xref section.
 */
function parseXrefStreamSection(buf: Uint8Array, offset: number, seenOffsets: Set<number>): XrefTable {
  const parser = new ObjectParser(buf, offset);
  const indirect = parser.parseIndirectObject();
  if (!isStream(indirect.value)) {
    throw new PdfError(ErrorCode.PDF_MALFORMED, `Expected a cross-reference stream object at byte offset ${offset}`);
  }
  const dict = indirect.value.dictionary;
  const typeValue = dict.entries.get('Type');
  if (!(typeValue !== undefined && isName(typeValue) && typeValue.name === 'XRef')) {
    throw new PdfError(ErrorCode.PDF_MALFORMED, `Object at byte offset ${offset} is not a /Type /XRef stream`);
  }

  const wValue = dict.entries.get('W') ?? null;
  if (!isArray(wValue) || wValue.items.length < 3) {
    throw new PdfError(ErrorCode.PDF_MALFORMED, 'Cross-reference stream is missing a valid /W field-width array');
  }
  const w = wValue.items.map((n) => (typeof n === 'number' ? n : 0)) as [number, number, number];

  const sizeValue = dict.entries.get('Size');
  const size = typeof sizeValue === 'number' ? sizeValue : 0;
  const indexValue = dict.entries.get('Index') ?? null;
  const index: number[] = isArray(indexValue) ? (indexValue.items.filter((n): n is number => typeof n === 'number') as number[]) : [0, size];

  const data = decodeStream(indirect.value);
  const recordWidth = w[0] + w[1] + w[2];
  const entries = new Map<number, XrefEntry>();

  let pos = 0;
  for (let sub = 0; sub + 1 < index.length; sub += 2) {
    const start = index[sub]!;
    const count = index[sub + 1]!;
    for (let i = 0; i < count && pos + recordWidth <= data.length; i += 1) {
      const objectNumber = start + i;
      const type = w[0] === 0 ? 1 : readBigEndian(data, pos, w[0]);
      const field2 = readBigEndian(data, pos + w[0], w[1]);
      const field3 = readBigEndian(data, pos + w[0] + w[1], w[2]);
      pos += recordWidth;

      if (entries.has(objectNumber)) continue;
      if (type === 0) {
        entries.set(objectNumber, { byteOffset: 0, generation: field3, free: true });
      } else if (type === 2) {
        entries.set(objectNumber, { byteOffset: 0, generation: 0, free: false, compressed: { streamObjectNumber: field2, indexInStream: field3 } });
      } else {
        entries.set(objectNumber, { byteOffset: field2, generation: field3, free: false });
      }
    }
  }

  followPrevChain(buf, dict, entries, seenOffsets);
  return { entriesByObjectNumber: entries, trailer: dict };
}

function readBigEndian(data: Uint8Array, offset: number, width: number): number {
  let value = 0;
  for (let i = 0; i < width; i += 1) value = value * 256 + (data[offset + i] ?? 0);
  return value;
}

/** Dispatches to the classic-table or cross-reference-stream parser at `offset`, whichever is actually there, and follows `/Prev`/`/XRefStm` to merge in incremental-update sections (earlier sections never override an object number a later section already defined). */
function parseXrefSectionChain(buf: Uint8Array, offset: number, seenOffsets: Set<number> = new Set()): XrefTable {
  if (seenOffsets.has(offset)) {
    throw new PdfError(ErrorCode.PDF_MALFORMED, `Cyclic /Prev or /XRefStm chain detected at byte offset ${offset}`);
  }
  seenOffsets.add(offset);

  const peek = new Lexer(buf, offset).next();
  if (peek.kind === 'keyword' && peek.text === 'xref') {
    return parseClassicXrefSection(buf, offset, seenOffsets);
  }
  if (peek.kind === 'number') {
    return parseXrefStreamSection(buf, offset, seenOffsets);
  }
  throw new PdfError(ErrorCode.PDF_MALFORMED, `Expected "xref" or an indirect object at byte offset ${offset}, got "${peek.text}"`);
}

export function parseXref(buf: Uint8Array): XrefTable {
  const startOffset = findStartxrefOffset(buf);
  return parseXrefSectionChain(buf, startOffset);
}
