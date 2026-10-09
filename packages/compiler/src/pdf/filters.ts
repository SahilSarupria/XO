import { inflateSync } from 'node:zlib';
import { PdfError, ErrorCode } from '@xo/errors';
import { isArray, isDictionary, isName, type PdfDictionary, type PdfStream, type PdfValue } from './types.js';

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
      throw new PdfError(ErrorCode.PDF_UNSUPPORTED_FEATURE, `TIFF predictor with BitsPerComponent ${bitsPerComponent} is not supported (only 8 is)`);
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
        case 0: value = raw; break; // None
        case 1: value = raw + a; break; // Sub
        case 2: value = raw + b; break; // Up
        case 3: value = raw + Math.floor((a + b) / 2); break; // Average
        case 4: value = raw + paethPredictor(a, b, c); break; // Paeth
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
export function decodeStream(stream: PdfStream): Uint8Array {
  let bytes = stream.rawBytes;
  const names = filterNames(stream);
  names.forEach((name, i) => {
    switch (name) {
      case 'FlateDecode':
      case 'Fl':
        try {
          bytes = new Uint8Array(inflateSync(Buffer.from(bytes)));
        } catch (cause) {
          throw new PdfError(ErrorCode.PDF_MALFORMED, 'FlateDecode stream failed to inflate', { cause });
        }
        bytes = applyPredictor(bytes, decodeParmsFor(stream, i, names.length));
        break;
      default:
        throw new PdfError(ErrorCode.PDF_UNSUPPORTED_FEATURE, `Unsupported stream filter "${name}"`);
    }
  });
  return bytes;
}
