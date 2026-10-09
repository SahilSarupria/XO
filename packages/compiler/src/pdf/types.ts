/**
 * The PDF object model — a direct, faithful representation of the seven
 * primitive PDF object types (ISO 32000-1 §7.3), plus the two composite
 * forms (indirect reference, stream) built from them. Every other module
 * in this package (`object-parser.ts`, `xref.ts`, `document.ts`,
 * `content-stream.ts`) operates purely on these types — nothing reaches
 * back into raw bytes once parsed into a `PdfValue`.
 */
export type PdfValue = number | boolean | null | PdfString | PdfName | PdfArray | PdfDictionary | PdfReference | PdfStream;

export interface PdfString {
  readonly kind: 'string';
  /** Raw decoded bytes — NOT yet resolved to a JS string, since that requires knowing the containing font's encoding (see text-decoder.ts). */
  readonly bytes: Uint8Array;
}

export interface PdfName {
  readonly kind: 'name';
  readonly name: string;
}

export interface PdfArray {
  readonly kind: 'array';
  readonly items: readonly PdfValue[];
}

export interface PdfDictionary {
  readonly kind: 'dictionary';
  readonly entries: ReadonlyMap<string, PdfValue>;
}

export interface PdfReference {
  readonly kind: 'reference';
  readonly objectNumber: number;
  readonly generation: number;
}

export interface PdfStream {
  readonly kind: 'stream';
  readonly dictionary: PdfDictionary;
  /** Raw (still-encoded) bytes between `stream`/`endstream` — decode via `decodeStream()` in `filters.ts`. */
  readonly rawBytes: Uint8Array;
}

export function isDictionary(value: PdfValue): value is PdfDictionary {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'dictionary';
}
export function isArray(value: PdfValue): value is PdfArray {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'array';
}
export function isReference(value: PdfValue): value is PdfReference {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'reference';
}
export function isStream(value: PdfValue): value is PdfStream {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'stream';
}
export function isName(value: PdfValue): value is PdfName {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'name';
}
export function isPdfString(value: PdfValue): value is PdfString {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'string';
}

/** A parsed indirect object: `<objectNumber> <generation> obj ... endobj`. */
export interface IndirectObject {
  readonly objectNumber: number;
  readonly generation: number;
  readonly value: PdfValue;
  /** Byte offset of `<objectNumber>` in the source file — carried through to XOIR node provenance. */
  readonly byteOffset: number;
}
