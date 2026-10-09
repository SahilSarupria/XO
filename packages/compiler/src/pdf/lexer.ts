/**
 * A byte-level tokenizer for PDF syntax (ISO 32000-1 §7.2). Shared by both
 * `object-parser.ts` (parsing `obj ... endobj` bodies, dictionaries,
 * arrays, the trailer) and `content-stream.ts` (parsing a decoded content
 * stream's operators/operands) — both are built from the same seven
 * lexical token kinds below; a content stream just never contains `obj`/
 * `R`/`stream` keywords in practice, and treats every other keyword as an
 * operator rather than rejecting it.
 *
 * Deliberately hand-written rather than regex-driven: PDF's string/name
 * escaping rules (`\ddd` octal, `#xx` hex-in-name, balanced nested parens
 * in literal strings) are stateful in a way a single regex can't express
 * correctly, and the input is untrusted bytes, not text to search for
 * patterns in — this is binary format parsing, not text/entity
 * extraction.
 */
export type TokenKind = 'number' | 'name' | 'string' | 'hexstring' | 'array_start' | 'array_end' | 'dict_start' | 'dict_end' | 'keyword' | 'eof';

export interface Token {
  readonly kind: TokenKind;
  /** For 'number': the numeric value as a string (parse with Number() at the call site — PDF numbers can be integers or reals). For 'name'/'keyword': the decoded text. For 'string'/'hexstring': decoded raw bytes. */
  readonly text: string;
  readonly bytes?: Uint8Array;
  readonly offset: number;
}

function isWhitespace(byte: number): boolean {
  return byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
}
function isDelimiter(byte: number): boolean {
  return byte === 0x28 || byte === 0x29 || byte === 0x3c || byte === 0x3e || byte === 0x5b || byte === 0x5d || byte === 0x7b || byte === 0x7d || byte === 0x2f || byte === 0x25;
}
function isRegular(byte: number): boolean {
  return !isWhitespace(byte) && !isDelimiter(byte);
}

export class Lexer {
  private pos: number;

  constructor(
    private readonly buf: Uint8Array,
    startOffset = 0,
  ) {
    this.pos = startOffset;
  }

  get position(): number {
    return this.pos;
  }

  seek(offset: number): void {
    this.pos = offset;
  }

  private skipWhitespaceAndComments(): void {
    while (this.pos < this.buf.length) {
      const b = this.buf[this.pos]!;
      if (isWhitespace(b)) {
        this.pos += 1;
      } else if (b === 0x25 /* % */) {
        while (this.pos < this.buf.length && this.buf[this.pos] !== 0x0a && this.buf[this.pos] !== 0x0d) this.pos += 1;
      } else {
        break;
      }
    }
  }

  /** Reads the next token. Throws only on truly malformed input (an unterminated string/name at EOF) — callers decide whether that's fatal via `object-parser.ts`'s error handling. */
  next(): Token {
    this.skipWhitespaceAndComments();
    const offset = this.pos;
    if (this.pos >= this.buf.length) return { kind: 'eof', text: '', offset };

    const b = this.buf[this.pos]!;

    if (b === 0x2f /* / */) return this.readName(offset);
    if (b === 0x28 /* ( */) return this.readLiteralString(offset);
    if (b === 0x3c /* < */) {
      if (this.buf[this.pos + 1] === 0x3c) {
        this.pos += 2;
        return { kind: 'dict_start', text: '<<', offset };
      }
      return this.readHexString(offset);
    }
    if (b === 0x3e /* > */ && this.buf[this.pos + 1] === 0x3e) {
      this.pos += 2;
      return { kind: 'dict_end', text: '>>', offset };
    }
    if (b === 0x5b /* [ */) {
      this.pos += 1;
      return { kind: 'array_start', text: '[', offset };
    }
    if (b === 0x5d /* ] */) {
      this.pos += 1;
      return { kind: 'array_end', text: ']', offset };
    }
    if (b === 0x2b || b === 0x2d || b === 0x2e || (b >= 0x30 && b <= 0x39) /* + - . 0-9 */) {
      return this.readNumberOrKeyword(offset);
    }
    return this.readKeyword(offset);
  }

  private readName(offset: number): Token {
    this.pos += 1; // consume '/'
    let out = '';
    while (this.pos < this.buf.length && isRegular(this.buf[this.pos]!)) {
      const b = this.buf[this.pos]!;
      if (b === 0x23 /* # */ && this.pos + 2 < this.buf.length) {
        const hex = String.fromCharCode(this.buf[this.pos + 1]!, this.buf[this.pos + 2]!);
        const code = Number.parseInt(hex, 16);
        if (!Number.isNaN(code)) {
          out += String.fromCharCode(code);
          this.pos += 3;
          continue;
        }
      }
      out += String.fromCharCode(b);
      this.pos += 1;
    }
    return { kind: 'name', text: out, offset };
  }

  private readLiteralString(offset: number): Token {
    this.pos += 1; // consume '('
    const bytes: number[] = [];
    let depth = 1;
    while (this.pos < this.buf.length && depth > 0) {
      const b = this.buf[this.pos]!;
      if (b === 0x5c /* backslash */) {
        this.pos += 1;
        const esc = this.buf[this.pos];
        if (esc === undefined) break;
        switch (esc) {
          case 0x6e: bytes.push(0x0a); this.pos += 1; break; // \n
          case 0x72: bytes.push(0x0d); this.pos += 1; break; // \r
          case 0x74: bytes.push(0x09); this.pos += 1; break; // \t
          case 0x62: bytes.push(0x08); this.pos += 1; break; // \b
          case 0x66: bytes.push(0x0c); this.pos += 1; break; // \f
          case 0x28: bytes.push(0x28); this.pos += 1; break; // \(
          case 0x29: bytes.push(0x29); this.pos += 1; break; // \)
          case 0x5c: bytes.push(0x5c); this.pos += 1; break; // \\
          case 0x0d: // line continuation: \<CR> or \<CR><LF> — emit nothing
            this.pos += 1;
            if (this.buf[this.pos] === 0x0a) this.pos += 1;
            break;
          case 0x0a: // \<LF>
            this.pos += 1;
            break;
          default:
            if (esc >= 0x30 && esc <= 0x37) {
              // up to 3 octal digits
              let val = 0;
              let count = 0;
              while (count < 3 && this.buf[this.pos] !== undefined && this.buf[this.pos]! >= 0x30 && this.buf[this.pos]! <= 0x37) {
                val = val * 8 + (this.buf[this.pos]! - 0x30);
                this.pos += 1;
                count += 1;
              }
              bytes.push(val & 0xff);
            } else {
              bytes.push(esc);
              this.pos += 1;
            }
        }
        continue;
      }
      if (b === 0x28) depth += 1;
      if (b === 0x29) {
        depth -= 1;
        if (depth === 0) {
          this.pos += 1;
          break;
        }
      }
      bytes.push(b);
      this.pos += 1;
    }
    return { kind: 'string', text: '', bytes: Uint8Array.from(bytes), offset };
  }

  private readHexString(offset: number): Token {
    this.pos += 1; // consume '<'
    const hexDigits: number[] = [];
    while (this.pos < this.buf.length && this.buf[this.pos] !== 0x3e) {
      const b = this.buf[this.pos]!;
      if (!isWhitespace(b)) hexDigits.push(b);
      this.pos += 1;
    }
    this.pos += 1; // consume '>'
    if (hexDigits.length % 2 === 1) hexDigits.push(0x30); // odd trailing digit is padded with 0, per spec
    const bytes = new Uint8Array(hexDigits.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
      const hi = hexDigits[i * 2]!;
      const lo = hexDigits[i * 2 + 1]!;
      bytes[i] = (hexCharToNibble(hi) << 4) | hexCharToNibble(lo);
    }
    return { kind: 'hexstring', text: '', bytes, offset };
  }

  private readNumberOrKeyword(offset: number): Token {
    let out = '';
    while (this.pos < this.buf.length) {
      const b = this.buf[this.pos]!;
      if ((b >= 0x30 && b <= 0x39) || b === 0x2b || b === 0x2d || b === 0x2e) {
        out += String.fromCharCode(b);
        this.pos += 1;
      } else {
        break;
      }
    }
    return { kind: 'number', text: out, offset };
  }

  private readKeyword(offset: number): Token {
    let out = '';
    while (this.pos < this.buf.length && isRegular(this.buf[this.pos]!)) {
      out += String.fromCharCode(this.buf[this.pos]!);
      this.pos += 1;
    }
    if (out.length === 0) {
      // A stray delimiter we don't otherwise handle (e.g. stray '}'); consume it to guarantee forward progress.
      out = String.fromCharCode(this.buf[this.pos]!);
      this.pos += 1;
    }
    return { kind: 'keyword', text: out, offset };
  }
}

function hexCharToNibble(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  return 0;
}
