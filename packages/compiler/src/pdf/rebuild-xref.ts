import { decodeStream } from './filters.js';
import { Lexer } from './lexer.js';
import { isDictionary, isName, isStream, type PdfDictionary } from './types.js';
import { ObjectParser } from './object-parser.js';
import type { XrefEntry, XrefTable } from './xref.js';

const OBJ_KEYWORD = Buffer.from(' obj', 'latin1');
const TRAILER_KEYWORD = Buffer.from('trailer', 'latin1');

/**
 * Recovers a cross-reference table by scanning the entire file for
 * `<n> <g> obj` occurrences, rather than trusting a `/Prev` chain from
 * `startxref`. This is the standard fallback real-world PDF readers fall
 * back to for a damaged or missing xref table — not a text/entity
 * extraction technique, a structural-recovery scan using plain byte
 * search (`Buffer.indexOf`), never a regex.
 *
 * Later occurrences of the same object number win (a later revision of
 * an incrementally-updated file appends a new `obj`/`endobj` body further
 * into the file), matching the precedence a well-formed `/Prev` chain
 * would also produce.
 */
export function rebuildXrefByScanning(buf: Uint8Array): XrefTable {
  const entries = new Map<number, XrefEntry>();
  const buffer = Buffer.from(buf);
  let searchFrom = 0;

  for (;;) {
    const objIdx = buffer.indexOf(OBJ_KEYWORD, searchFrom);
    if (objIdx === -1) break;

    // Walk backward from " obj" to find the "<n> <g>" that precedes it.
    let cursor = objIdx;
    let numEnd = cursor;
    // skip the single space already matched by OBJ_KEYWORD
    cursor -= 1;
    while (cursor >= 0 && buf[cursor]! >= 0x30 && buf[cursor]! <= 0x39) cursor -= 1;
    const genStart = cursor + 1;
    const genEnd = cursor + 1;
    void genEnd;
    if (buf[cursor] === 0x20) cursor -= 1;
    const generation = Number.parseInt(buffer.toString('latin1', genStart, numEnd), 10);
    numEnd = cursor + 1;
    while (cursor >= 0 && buf[cursor]! >= 0x30 && buf[cursor]! <= 0x39) cursor -= 1;
    const numStart = cursor + 1;

    if (numStart < numEnd && !Number.isNaN(generation)) {
      const objectNumber = Number.parseInt(buffer.toString('latin1', numStart, numEnd), 10);
      if (!Number.isNaN(objectNumber)) {
        entries.set(objectNumber, { byteOffset: numStart, generation, free: false });
      }
    }

    searchFrom = objIdx + OBJ_KEYWORD.length;
  }

  expandCompressedObjectStreams(buf, entries);

  const trailer = findTrailer(buf, buffer) ?? findRootViaCatalogScan(buf, entries);
  return { entriesByObjectNumber: entries, trailer };
}

/**
 * A byte-scan for literal `<n> <g> obj` occurrences (above) cannot, by
 * construction, find an object packed inside a `/Type /ObjStm` compressed
 * object stream — those objects have no `obj`/`endobj` wrapper anywhere in
 * the file, only an entry in the ObjStm's own internal header. This pass
 * closes that gap: for every recovered object that turns out to be an
 * ObjStm, decode it and register each object it contains too, so scan-based
 * recovery is a real fallback for a corrupt cross-reference *stream*, not
 * only for a corrupt classic table — matching what `xref.ts`'s primary
 * (non-recovery) path already handles for a well-formed file. Marked with
 * `compressed` so `document.ts.getObject` resolves them the same way
 * either path produces them.
 */
function expandCompressedObjectStreams(buf: Uint8Array, entries: Map<number, XrefEntry>): void {
  const objStmObjectNumbers: number[] = [];
  for (const [objNum, entry] of entries) {
    if (entry.free || entry.compressed) continue;
    const parser = new ObjectParser(buf, entry.byteOffset);
    let indirect;
    try {
      indirect = parser.parseIndirectObject();
    } catch {
      continue;
    }
    if (!isStream(indirect.value)) continue;
    const typeValue = indirect.value.dictionary.entries.get('Type');
    if (typeValue !== undefined && isName(typeValue) && typeValue.name === 'ObjStm') {
      objStmObjectNumbers.push(objNum);
    }
  }

  for (const streamObjNum of objStmObjectNumbers) {
    const entry = entries.get(streamObjNum);
    if (!entry) continue;
    try {
      const parser = new ObjectParser(buf, entry.byteOffset);
      const indirect = parser.parseIndirectObject();
      if (!isStream(indirect.value)) continue;
      const dict = indirect.value.dictionary;
      const nValue = dict.entries.get('N');
      const n = typeof nValue === 'number' ? nValue : 0;
      const data = decodeStream(indirect.value);
      const headerLexer = new Lexer(data, 0);
      for (let i = 0; i < n; i += 1) {
        const objNumTok = headerLexer.next();
        headerLexer.next(); // offset — not needed here, only presence/index matters
        const objectNumber = Number.parseInt(objNumTok.text, 10);
        if (Number.isNaN(objectNumber)) continue;
        // A later top-level "obj" occurrence (already in `entries`) or an
        // object recovered from an earlier ObjStm always wins, matching this
        // file's "later occurrence wins" precedence rule.
        if (!entries.has(objectNumber)) {
          entries.set(objectNumber, { byteOffset: 0, generation: 0, free: false, compressed: { streamObjectNumber: streamObjNum, indexInStream: i } });
        }
      }
    } catch {
      continue; // a damaged ObjStm just contributes nothing further; not fatal to overall recovery
    }
  }
}

function findTrailer(buf: Uint8Array, buffer: Buffer): PdfDictionary | undefined {
  const idx = buffer.lastIndexOf(TRAILER_KEYWORD);
  if (idx === -1) return undefined;
  const parser = new ObjectParser(buf, idx + TRAILER_KEYWORD.length);
  const value = parser.parseValue();
  return isDictionary(value) ? value : undefined;
}

/** A file recovered by scanning may have no `trailer` at all (e.g. it only ever had a cross-reference *stream*, itself unsupported — see xref.ts). As a last resort, find a `/Type /Catalog` object among the recovered entries and synthesize a trailer pointing `/Root` at it. */
function findRootViaCatalogScan(buf: Uint8Array, entries: ReadonlyMap<number, XrefEntry>): PdfDictionary {
  for (const [objectNumber, entry] of entries) {
    const parser = new ObjectParser(buf, entry.byteOffset);
    let indirect;
    try {
      indirect = parser.parseIndirectObject();
    } catch {
      continue;
    }
    if (isDictionary(indirect.value)) {
      const typeValue = indirect.value.entries.get('Type');
      if (typeValue !== undefined && isName(typeValue) && typeValue.name === 'Catalog') {
        return {
          kind: 'dictionary',
          entries: new Map([['Root', { kind: 'reference', objectNumber, generation: entry.generation }]]),
        };
      }
    }
  }
  return { kind: 'dictionary', entries: new Map() };
}
