/**
 * Decodes a PDF "text string" (ISO 32000-1 §7.9.2.2) — used for
 * `/Info` dictionary values (Title, Author, ...) and other metadata
 * strings. This is distinct from decoding text *shown on a page*, which
 * depends on the containing font's encoding (see `font-encoding.ts`) —
 * text strings have their own, simpler two-case rule: UTF-16BE (with a
 * `FE FF` byte-order-mark) if present, otherwise PDFDocEncoding, which is
 * a superset of Latin-1 for the printable ASCII range this decoder
 * approximates as Latin-1 (the two encodings differ only in a handful of
 * codepoints above 0x7F that are rare outside multilingual metadata).
 */
export function decodePdfTextString(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeUtf16BE(bytes.subarray(2));
  }
  return Buffer.from(bytes).toString('latin1');
}

function decodeUtf16BE(bytes: Uint8Array): string {
  const swapped = Buffer.alloc(bytes.length);
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    swapped[i] = bytes[i + 1]!;
    swapped[i + 1] = bytes[i]!;
  }
  return swapped.toString('utf16le');
}
