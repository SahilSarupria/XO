import { PdfError, ErrorCode } from '@xo/errors';
import { Lexer, type Token } from './lexer.js';
import type { IndirectObject, PdfArray, PdfDictionary, PdfValue } from './types.js';

/** Resolves an indirect `/Length` reference to a byte count. Object parsing happens before xref-based random access exists for every object (chicken-and-egg for the first pass), so this is optional — when absent, a stream's length is instead recovered by scanning forward for `endstream` (see `readStreamBody`). */
export type LengthResolver = (objectNumber: number, generation: number) => number | undefined;

const STREAM_KEYWORD = 'stream';
const ENDSTREAM_KEYWORD = 'endstream';

/**
 * Recursive-descent parser from PDF tokens (lexer.ts) to the `PdfValue`
 * tree (types.ts). One parser instance is scoped to one contiguous parse
 * (typically one indirect object's body) — it is not shared across
 * objects, so there is no risk of one object's malformed content leaking
 * lexer state into the next.
 */
export class ObjectParser {
  private readonly lexer: Lexer;

  constructor(
    private readonly buf: Uint8Array,
    startOffset: number,
  ) {
    this.lexer = new Lexer(buf, startOffset);
  }

  get position(): number {
    return this.lexer.position;
  }

  /** Parses `<num> <gen> obj ... endobj`, including a trailing stream body if the value is a stream dictionary. */
  parseIndirectObject(resolveLength?: LengthResolver): IndirectObject {
    const byteOffset = this.lexer.position;
    const numTok = this.lexer.next();
    const genTok = this.lexer.next();
    const objTok = this.lexer.next();
    if (numTok.kind !== 'number' || genTok.kind !== 'number' || objTok.text !== 'obj') {
      throw new PdfError(ErrorCode.PDF_MALFORMED, `Expected "<n> <g> obj" at byte offset ${byteOffset}, got "${numTok.text} ${genTok.text} ${objTok.text}"`);
    }
    const objectNumber = Number.parseInt(numTok.text, 10);
    const generation = Number.parseInt(genTok.text, 10);
    let value = this.parseValue();

    // A dictionary immediately followed by `stream` is a stream object, not a plain dictionary.
    const savedPos = this.lexer.position;
    const maybeStream = this.lexer.next();
    if (maybeStream.kind === 'keyword' && maybeStream.text === STREAM_KEYWORD && value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'dictionary') {
      value = this.readStreamBody(value, resolveLength);
    } else {
      this.lexer.seek(savedPos);
    }

    return { objectNumber, generation, value, byteOffset };
  }

  /** Parses a single value starting at the current position — the entry point content-stream parsing and dictionary-value parsing both share. */
  parseValue(): PdfValue {
    const token = this.lexer.next();
    return this.parseValueFromToken(token);
  }

  private parseValueFromToken(token: Token): PdfValue {
    switch (token.kind) {
      case 'number':
        return this.parseNumberOrReference(token);
      case 'name':
        return { kind: 'name', name: token.text };
      case 'string':
      case 'hexstring':
        return { kind: 'string', bytes: token.bytes ?? new Uint8Array(0) };
      case 'array_start':
        return this.parseArray();
      case 'dict_start':
        return this.parseDictionary();
      case 'keyword':
        if (token.text === 'true') return true;
        if (token.text === 'false') return false;
        if (token.text === 'null') return null;
        throw new PdfError(ErrorCode.PDF_MALFORMED, `Unexpected keyword "${token.text}" at byte offset ${token.offset}`);
      default:
        throw new PdfError(ErrorCode.PDF_MALFORMED, `Unexpected token kind "${token.kind}" at byte offset ${token.offset}`);
    }
  }

  /** A bare number might actually be the start of an indirect reference (`<n> <g> R`) — look ahead up to two tokens and roll back if it isn't. */
  private parseNumberOrReference(numTok: Token): PdfValue {
    const savedPos = this.lexer.position;
    const genTok = this.lexer.next();
    if (genTok.kind === 'number') {
      const rTok = this.lexer.next();
      if (rTok.kind === 'keyword' && rTok.text === 'R') {
        return { kind: 'reference', objectNumber: Number.parseInt(numTok.text, 10), generation: Number.parseInt(genTok.text, 10) };
      }
    }
    this.lexer.seek(savedPos);
    return Number.parseFloat(numTok.text);
  }

  private parseArray(): PdfArray {
    const items: PdfValue[] = [];
    for (;;) {
      const savedPos = this.lexer.position;
      const token = this.lexer.next();
      if (token.kind === 'array_end') break;
      if (token.kind === 'eof') throw new PdfError(ErrorCode.PDF_MALFORMED, `Unterminated array starting before byte offset ${savedPos}`);
      items.push(this.parseValueFromToken(token));
    }
    return { kind: 'array', items };
  }

  private parseDictionary(): PdfDictionary {
    const entries = new Map<string, PdfValue>();
    for (;;) {
      const keyTok = this.lexer.next();
      if (keyTok.kind === 'dict_end') break;
      if (keyTok.kind === 'eof') throw new PdfError(ErrorCode.PDF_MALFORMED, `Unterminated dictionary at byte offset ${keyTok.offset}`);
      if (keyTok.kind !== 'name') throw new PdfError(ErrorCode.PDF_MALFORMED, `Expected a /Name dictionary key at byte offset ${keyTok.offset}, got "${keyTok.text}"`);
      const value = this.parseValue();
      entries.set(keyTok.text, value);
    }
    return { kind: 'dictionary', entries };
  }

  private readStreamBody(dictionary: PdfDictionary, resolveLength?: LengthResolver): PdfValue {
    // Per spec, `stream` is followed by CRLF or LF (never a bare CR) before the raw data begins.
    let dataStart = this.lexer.position;
    if (this.buf[dataStart] === 0x0d) dataStart += 1;
    if (this.buf[dataStart] === 0x0a) dataStart += 1;

    let length: number | undefined;
    const lengthValue = dictionary.entries.get('Length');
    if (typeof lengthValue === 'number') {
      length = lengthValue;
    } else if (lengthValue !== null && typeof lengthValue === 'object' && 'kind' in lengthValue && lengthValue.kind === 'reference') {
      length = resolveLength?.(lengthValue.objectNumber, lengthValue.generation);
    }

    let dataEnd: number;
    if (length !== undefined && this.endstreamFollowsAt(dataStart + length)) {
      dataEnd = dataStart + length;
    } else {
      // Length was wrong, unresolved, or absent — recover by scanning forward for the literal `endstream` keyword, a standard fallback real-world PDF readers use for malformed/inconsistent /Length values.
      dataEnd = this.findEndstream(dataStart);
    }

    const rawBytes = this.buf.subarray(dataStart, dataEnd);
    this.lexer.seek(dataEnd);
    const endstreamTok = this.lexer.next();
    if (endstreamTok.text !== ENDSTREAM_KEYWORD) {
      throw new PdfError(ErrorCode.PDF_MALFORMED, `Expected "endstream" at byte offset ${dataEnd}, got "${endstreamTok.text}"`);
    }
    return { kind: 'stream', dictionary, rawBytes };
  }

  private endstreamFollowsAt(offset: number): boolean {
    let p = offset;
    while (p < this.buf.length && (this.buf[p] === 0x0d || this.buf[p] === 0x0a || this.buf[p] === 0x20 || this.buf[p] === 0x09)) p += 1;
    const slice = Buffer.from(this.buf.subarray(p, p + ENDSTREAM_KEYWORD.length)).toString('latin1');
    return slice === ENDSTREAM_KEYWORD;
  }

  private findEndstream(from: number): number {
    const needle = Buffer.from(ENDSTREAM_KEYWORD, 'latin1');
    const idx = Buffer.from(this.buf).indexOf(needle, from);
    if (idx === -1) {
      throw new PdfError(ErrorCode.PDF_MALFORMED, `Could not find "endstream" after byte offset ${from}`);
    }
    // Trim a single trailing EOL that precedes `endstream`, which is not part of the stream's data.
    let end = idx;
    if (this.buf[end - 1] === 0x0a) end -= 1;
    if (this.buf[end - 1] === 0x0d) end -= 1;
    return end;
  }
}
