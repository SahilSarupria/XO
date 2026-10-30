import { inflateSync } from 'node:zlib';
import { PdfError, ErrorCode } from '@xo/errors';
import { isArray, isDictionary, isName, type PdfDictionary, type PdfStream, type PdfValue } from './types.js';
import { DEFAULT_PDF_LIMITS, PdfResourceLimitError, ResourceMeter } from './limits.js';

/** Used when a caller decodes without a per-document meter: still bounded per stream, never unbounded. */
const STANDALONE_METER_LIMITS = DEFAULT_PDF_LIMITS;

function filterNames(stream: PdfStream): readonly string[] {
  const filter = stream.dictionary.entries.get('Filter');
  if (filter === undefined) return [];
  if (isName(filter)) return [filter.name];
  if (isArray(filter)) return filter.items.filter(isName).map((n) => n.name);
  return [];
}

/** `/DecodeParms` (or its abbreviation `/DP`) can be a single dictionary (applies to the sole/last filter) or an array parallel to `/Filter`; `null` entries mean "no parms for this filter." Values here are typically raw ints/names since a stream dictionary is never itself behind an indirect `/Length`-style forward reference in practice for these fields — this reader does not resolve references (a resolved value would need a `PdfDocument`, which this module deliberately has no dependency on; see `document.ts`, which decodes streams only after any indirect `/DecodeParms` would already need resolving upstream). */
function decodeParmsFor(stream: PdfStream, filterIndex: number, filterCount: number): PdfDictionary | undefined {
  const parms = stream.dictionary.entries.get('DecodeParms') ?? stream.dictionary.entries.get('DP');
  if (parms === undefined) return undefined;
  if (isDictionary(parms)) return filterCount <= 1 ? parms : undefined;
  if (isArray(parms)) {
    const entry = parms.items[filterIndex];
    return entry !== undefined && isDictionary(entry) ? entry : undefined;
  }
  return undefined;
}

function numParam(dict: PdfDictionary | undefined, key: string, fallback: number): number {
  const v: PdfValue | undefined = dict?.entries.get(key);
  return typeof v === 'number' ? v : fallback;
}

/**
 * Reverses a PNG-style predictor (ISO 32000-1 §7.4.4.4, Predictor values
 * 10–15 — the actual per-row filter type is read from a leading tag byte
 * on every row regardless of which of 10–15 was declared, per spec) or a
 * TIFF-style predictor (Predictor value 2, horizontal differencing).
 * Cross-reference streams (`/Type /XRef`) and many compressed object
 * streams are written with `Predictor 12` (PNG "Up") almost universally,
 * because it compresses far better than raw FlateDecode for the
 * mostly-sequential integer fields those streams contain — decoding a
 * modern PDF's xref stream without this step yields bytes that don't
 * correspond to any real field values.
 */
function applyPredictor(data: Uint8Array, parms: PdfDictionary | undefined): Uint8Array {
  const predictor = numParam(parms, 'Predictor', 1);
  if (predictor <= 1) return data;

  const colors = numParam(parms, 'Colors', 1);
  const bitsPerComponent = numParam(parms, 'BitsPerComponent', 8);
  const columns = numParam(parms, 'Columns', 1);
  const bytesPerPixel = Math.max(1, Math.ceil((colors * bitsPerComponent) / 8));
  const rowBytes = Math.ceil((colors * bitsPerComponent * columns) / 8);

  if (predictor === 2) {
    if (bitsPerComponent !== 8) {
      throw new PdfError(
        ErrorCode.PDF_UNSUPPORTED_FEATURE,
        `TIFF predictor with BitsPerComponent ${bitsPerComponent} is not supported (only 8 is)`,
      );
    }
    const out = Uint8Array.from(data);
    const rowCount = Math.floor(out.length / rowBytes);
    for (let r = 0; r < rowCount; r += 1) {
      const base = r * rowBytes;
      for (let i = bytesPerPixel; i < rowBytes; i += 1) {
        out[base + i] = (out[base + i]! + out[base + i - bytesPerPixel]!) & 0xff;
      }
    }
    return out;
  }

  // PNG predictors: each row is prefixed by a 1-byte filter-type tag, so the
  // encoded stream is (rowBytes + 1) bytes per row, decoding to rowBytes per row.
  const stride = rowBytes + 1;
  const rowCount = Math.floor(data.length / stride);
  const out = new Uint8Array(rowCount * rowBytes);
  let prevRow = new Uint8Array(rowBytes);
  for (let r = 0; r < rowCount; r += 1) {
    const tag = data[r * stride]!;
    const src = data.subarray(r * stride + 1, r * stride + 1 + rowBytes);
    const dst = out.subarray(r * rowBytes, r * rowBytes + rowBytes);
    for (let i = 0; i < rowBytes; i += 1) {
      const raw = src[i]!;
      const a = i >= bytesPerPixel ? dst[i - bytesPerPixel]! : 0; // left
      const b = prevRow[i]!; // up
      const c = i >= bytesPerPixel ? prevRow[i - bytesPerPixel]! : 0; // upper-left
      let value: number;
      switch (tag) {
        case 0:
          value = raw;
          break; // None
        case 1:
          value = raw + a;
          break; // Sub
        case 2:
          value = raw + b;
          break; // Up
        case 3:
          value = raw + Math.floor((a + b) / 2);
          break; // Average
        case 4:
          value = raw + paethPredictor(a, b, c);
          break; // Paeth
        default:
          throw new PdfError(ErrorCode.PDF_UNSUPPORTED_FEATURE, `Unknown PNG predictor row filter type ${tag}`);
      }
      dst[i] = value & 0xff;
    }
    prevRow = dst;
  }
  return out;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Applies a stream's `/Filter` chain to its raw bytes. Only `FlateDecode`
 * (by far the most common filter for text/content streams produced by
 * real-world PDF writers, and the only filter cross-reference streams and
 * compressed object streams are ever written with in practice) is
 * implemented, via Node's built-in `zlib` — no external dependency, plus
 * the `/DecodeParms` PNG/TIFF predictor reversal above, since a huge
 * fraction of real-world FlateDecode streams are predictor-encoded and
 * silently skipping that step doesn't fail loudly, it just produces
 * plausible-looking wrong bytes. `ASCIIHexDecode`/`ASCII85Decode`/
 * `LZWDecode`/`DCTDecode` (JPEG, for image XObjects) are explicitly
 * unsupported: a stream using one of those throws `PDF_UNSUPPORTED_FEATURE`
 * rather than silently returning wrong bytes — see this package's README
 * for the consequence (image-only pages using those filters are exactly
 * the case `requiresOcr` is meant to flag instead of mis-parsing).
 */
export function decodeStream(stream: PdfStream, meter: ResourceMeter = new ResourceMeter(STANDALONE_METER_LIMITS)): Uint8Array {
  let bytes = stream.rawBytes;
  const names = filterNames(stream);
  const inputBytes = Math.max(1, stream.rawBytes.length);
  names.forEach((name, i) => {
    const allowance = meter.allowance();
    switch (name) {
      case 'FlateDecode':
      case 'Fl':
        try {
          // `maxOutputLength` makes zlib stop at the bound instead of materialising a bomb first.
          bytes = new Uint8Array(inflateSync(bytes, { maxOutputLength: Math.max(1, allowance) }));
        } catch (cause) {
          if ((cause as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
            throw new PdfResourceLimitError('maxStreamBytes', `stream inflates beyond ${allowance} bytes`);
          }
          throw new PdfError(ErrorCode.PDF_MALFORMED, 'FlateDecode stream failed to inflate', { cause });
        }
        enforceRatio(bytes.length, inputBytes, meter);
        bytes = applyPredictor(bytes, decodeParmsFor(stream, i, names.length));
        break;
      case 'ASCII85Decode':
      case 'A85':
        bytes = decodeAscii85(bytes);
        break;
      case 'ASCIIHexDecode':
      case 'AHx':
        bytes = decodeAsciiHex(bytes);
        break;
      case 'RunLengthDecode':
      case 'RL':
        bytes = decodeRunLength(bytes, Math.max(1, allowance));
        break;
      case 'Crypt':
        break; // handled by the document's decryptor before filters run
      default:
        throw new PdfError(ErrorCode.PDF_UNSUPPORTED_FEATURE, `Unsupported stream filter "${name}"`);
    }
    if (bytes.length > allowance) throw new PdfResourceLimitError('maxStreamBytes', `stream decodes beyond ${allowance} bytes`);
  });
  meter.charge(bytes.length);
  return bytes;
}

function enforceRatio(outBytes: number, inBytes: number, meter: ResourceMeter): void {
  const { ratioFloorBytes, maxInflateRatio } = meter.limits;
  if (outBytes > ratioFloorBytes && outBytes / inBytes > maxInflateRatio) {
    throw new PdfResourceLimitError('maxInflateRatio', `stream expands ${Math.round(outBytes / inBytes)}x (limit ${maxInflateRatio}x)`);
  }
}

const isPdfSpace = (b: number): boolean => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x0c || b === 0x00;

/** ASCII85Decode (PDF 32000-1 §7.4.3): 5 chars -> 4 bytes, `z` = four zero bytes, `~>` ends the data. */
export function decodeAscii85(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  const group: number[] = [];
  const flush = (count: number): void => {
    // A short final group of n chars (n >= 2) is padded with 'u' and yields n-1 bytes.
    const padded = group.concat(new Array<number>(5 - count).fill(84));
    let value = 0;
    for (const d of padded) value = value * 85 + d;
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    out.push(...bytes.slice(0, count - 1));
  };
  let i = 0;
  // An optional leading `<~` is tolerated.
  while (i < input.length && isPdfSpace(input[i]!)) i++;
  if (input[i] === 0x3c && input[i + 1] === 0x7e) i += 2;
  for (; i < input.length; i++) {
    const c = input[i]!;
    if (isPdfSpace(c)) continue;
    if (c === 0x7e) break; // '~' -> end-of-data marker
    if (c === 0x7a && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 0x21 || c > 0x75) throw new PdfError(ErrorCode.PDF_MALFORMED, `ASCII85Decode: invalid character 0x${c.toString(16)}`);
    group.push(c - 0x21);
    if (group.length === 5) {
      flush(5);
      group.length = 0;
    }
  }
  if (group.length === 1) throw new PdfError(ErrorCode.PDF_MALFORMED, 'ASCII85Decode: dangling single character in final group');
  if (group.length > 1) flush(group.length);
  return Uint8Array.from(out);
}

/** ASCIIHexDecode (§7.4.2): hex pairs, whitespace ignored, `>` ends the data, a final odd digit is padded with 0. */
export function decodeAsciiHex(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let high = -1;
  for (const c of input) {
    if (isPdfSpace(c)) continue;
    if (c === 0x3e) break;
    const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1;
    if (v < 0) throw new PdfError(ErrorCode.PDF_MALFORMED, `ASCIIHexDecode: invalid character 0x${c.toString(16)}`);
    if (high < 0) high = v;
    else {
      out.push(high * 16 + v);
      high = -1;
    }
  }
  if (high >= 0) out.push(high * 16);
  return Uint8Array.from(out);
}

/** RunLengthDecode (§7.4.5): length byte n: 0-127 copy n+1 literal bytes, 129-255 repeat the next byte 257-n times, 128 = EOD. */
export function decodeRunLength(input: Uint8Array, maxOut = DEFAULT_PDF_LIMITS.maxStreamBytes): Uint8Array {
  let out = new Uint8Array(Math.min(Math.max(input.length * 4, 1024), maxOut + 1));
  let len = 0;
  const ensure = (extra: number): void => {
    if (len + extra > maxOut) throw new PdfResourceLimitError('maxStreamBytes', `RunLengthDecode output exceeds ${maxOut} bytes`);
    if (len + extra > out.length) {
      const grown = new Uint8Array(Math.min(Math.max(out.length * 2, len + extra), maxOut + 1));
      grown.set(out.subarray(0, len));
      out = grown;
    }
  };
  let i = 0;
  while (i < input.length) {
    const n = input[i++]!;
    if (n === 128) break;
    if (n < 128) {
      const end = i + n + 1;
      if (end > input.length) throw new PdfError(ErrorCode.PDF_MALFORMED, 'RunLengthDecode: literal run overruns the data');
      ensure(n + 1);
      out.set(input.subarray(i, end), len);
      len += n + 1;
      i = end;
    } else {
      if (i >= input.length) throw new PdfError(ErrorCode.PDF_MALFORMED, 'RunLengthDecode: repeat run missing its byte');
      const count = 257 - n;
      ensure(count);
      out.fill(input[i++]!, len, len + count);
      len += count;
    }
  }
  return out.slice(0, len);
}
