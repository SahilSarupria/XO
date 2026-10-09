import { PdfError, ErrorCode } from '@xo/errors';
import { decodeStream } from './filters.js';
import { Lexer } from './lexer.js';
import { ObjectParser } from './object-parser.js';
import { decodePdfTextString } from './text-decoder.js';
import { isArray, isDictionary, isName, isPdfString, isReference, isStream, type PdfDictionary, type PdfValue } from './types.js';
import { parseXref, type XrefTable } from './xref.js';
import { rebuildXrefByScanning } from './rebuild-xref.js';

export interface PdfMetadata {
  readonly title: string | undefined;
  readonly author: string | undefined;
  readonly subject: string | undefined;
  readonly creator: string | undefined;
  readonly producer: string | undefined;
  readonly creationDate: string | undefined;
  readonly modificationDate: string | undefined;
}

export interface RawPdfPage {
  readonly pageNumber: number; // 1-based
  readonly objectNumber: number;
  readonly mediaBox: readonly [number, number, number, number];
  readonly rotate: number;
  readonly contentBytes: Uint8Array;
  /** True if this page's /Resources contains an image XObject whose bounding proportions suggest a full-page scan and there is no text-showing content — a strong signal Stage 1's OCR-requirement flag should be set (see document.ts's `requiresOcr` computation, driven from here by pdf-loader.ts). */
  readonly hasFullPageImageXObject: boolean;
  /** This page's (possibly inherited) resolved `/Resources` dictionary — carried through so a font-aware text decoder (`font-encoding.ts`) can look up the `/Font` entry a given text run's `fontName` refers to. Sub-entries (e.g. individual font dictionaries) may still be unresolved references; the consumer resolves them via the same `PdfDocument`. */
  readonly resources: PdfDictionary | undefined;
}

const DEFAULT_MEDIA_BOX: readonly [number, number, number, number] = [0, 0, 612, 792]; // US Letter, the PDF spec's fallback default

/**
 * The top-level PDF document model: resolves indirect references, decodes
 * stream filters, and walks the page tree with inherited attribute
 * resolution (Resources/MediaBox/Rotate). This is the one class that
 * needs the `xref` <-> `resolve()` <-> `object-parser.ts` triangle wired
 * together; every other module in this directory only ever sees already-
 * resolved `PdfValue`s or `RawPdfPage`s.
 */
export class PdfDocument {
  private readonly cache = new Map<number, PdfValue>();
  /** Decoded `/Type /ObjStm` bodies, keyed by that stream's own object number, so N compressed objects sharing one container stream only pay the inflate+predictor+parse cost once. */
  private readonly objStmCache = new Map<number, ReadonlyMap<number, PdfValue>>();

  private constructor(
    private readonly buf: Uint8Array,
    private readonly xref: XrefTable,
  ) {}

  static load(buf: Uint8Array): PdfDocument {
    let xref: XrefTable;
    try {
      xref = parseXref(buf);
    } catch {
      xref = rebuildXrefByScanning(buf);
    }
    const doc = new PdfDocument(buf, xref);
    if (xref.trailer.entries.has('Encrypt')) {
      throw new PdfError(ErrorCode.PDF_ENCRYPTED, 'This PDF is encrypted; decryption is not supported');
    }
    if (!xref.trailer.entries.has('Root')) {
      throw new PdfError(ErrorCode.PDF_MALFORMED, 'No /Root found in trailer (even after xref recovery)');
    }
    return doc;
  }

  getObject(objectNumber: number): PdfValue {
    const cached = this.cache.get(objectNumber);
    if (cached !== undefined) return cached;

    const entry = this.xref.entriesByObjectNumber.get(objectNumber);
    if (!entry || entry.free) {
      throw new PdfError(ErrorCode.PDF_MALFORMED, `Object ${objectNumber} is not present in the cross-reference table`);
    }

    if (entry.compressed) {
      const value = this.getCompressedObject(entry.compressed.streamObjectNumber, entry.compressed.indexInStream, objectNumber);
      this.cache.set(objectNumber, value);
      return value;
    }

    const parser = new ObjectParser(this.buf, entry.byteOffset);
    const indirect = parser.parseIndirectObject((refObjNum) => {
      const lengthValue = this.getObject(refObjNum);
      return typeof lengthValue === 'number' ? lengthValue : undefined;
    });
    this.cache.set(objectNumber, indirect.value);
    return indirect.value;
  }

  /**
   * Resolves object `objectNumber` at `indexInStream` within `streamObjectNumber`'s
   * `/Type /ObjStm` compressed object stream (ISO 32000-1 §7.5.7). The stream
   * body is: an `/N`-pair header of `<objNum> <byteOffsetFromFirst>` tokens,
   * then the objects themselves back-to-back starting at `/First` — each one a
   * bare value (no `<n> <g> obj`/`endobj` wrapper; compressed objects always
   * have generation 0 and are never themselves streams, per spec).
   */
  private getCompressedObject(streamObjectNumber: number, indexInStream: number, expectedObjectNumber: number): PdfValue {
    let objects = this.objStmCache.get(streamObjectNumber);
    if (!objects) {
      const streamValue = this.getObject(streamObjectNumber);
      if (!isStream(streamValue)) {
        throw new PdfError(ErrorCode.PDF_MALFORMED, `Object ${streamObjectNumber} referenced as a compressed-object container is not a stream`);
      }
      const nValue = streamValue.dictionary.entries.get('N');
      const firstValue = streamValue.dictionary.entries.get('First');
      const n = typeof nValue === 'number' ? nValue : 0;
      const first = typeof firstValue === 'number' ? firstValue : 0;
      const data = decodeStream(streamValue);

      const header: Array<[number, number]> = [];
      const headerLexer = new Lexer(data, 0);
      for (let i = 0; i < n; i += 1) {
        const objNumTok = headerLexer.next();
        const offsetTok = headerLexer.next();
        header.push([Number.parseInt(objNumTok.text, 10), Number.parseInt(offsetTok.text, 10)]);
      }

      const parsed = new Map<number, PdfValue>();
      header.forEach(([objNum, relOffset]) => {
        const valueParser = new ObjectParser(data, first + relOffset);
        parsed.set(objNum, valueParser.parseValue());
      });
      objects = parsed;
      this.objStmCache.set(streamObjectNumber, objects);
    }

    const value = objects.get(expectedObjectNumber);
    if (value === undefined) {
      throw new PdfError(ErrorCode.PDF_MALFORMED, `Object ${expectedObjectNumber} not found at index ${indexInStream} of compressed-object stream ${streamObjectNumber}`);
    }
    return value;
  }

  /** Follows a `PdfReference` to its target, recursively (guarding against a reference cycle) — every other accessor in this class calls this before inspecting a value's shape. */
  resolve(value: PdfValue, depth = 0): PdfValue {
    if (depth > 64) {
      throw new PdfError(ErrorCode.PDF_MALFORMED, 'Reference chain too deep (possible cycle)');
    }
    if (isReference(value)) {
      return this.resolve(this.getObject(value.objectNumber), depth + 1);
    }
    return value;
  }

  private dictGet(dict: PdfDictionary, key: string): PdfValue | undefined {
    const raw = dict.entries.get(key);
    return raw === undefined ? undefined : this.resolve(raw);
  }

  get info(): PdfMetadata {
    const infoValue = this.dictGet(this.xref.trailer, 'Info');
    const info = infoValue !== undefined && isDictionary(infoValue) ? infoValue : { kind: 'dictionary' as const, entries: new Map<string, PdfValue>() };
    const str = (key: string): string | undefined => {
      const v = this.dictGet(info, key);
      return v !== undefined && isPdfString(v) ? decodePdfTextString(v.bytes) : undefined;
    };
    return {
      title: str('Title'),
      author: str('Author'),
      subject: str('Subject'),
      creator: str('Creator'),
      producer: str('Producer'),
      creationDate: str('CreationDate'),
      modificationDate: str('ModDate'),
    };
  }

  get pages(): readonly RawPdfPage[] {
    const root = this.dictGet(this.xref.trailer, 'Root');
    if (root === undefined || !isDictionary(root)) {
      throw new PdfError(ErrorCode.PDF_MALFORMED, '/Root did not resolve to a dictionary');
    }
    const pagesRoot = this.dictGet(root, 'Pages');
    if (pagesRoot === undefined || !isDictionary(pagesRoot)) {
      throw new PdfError(ErrorCode.PDF_MALFORMED, '/Root/Pages did not resolve to a dictionary');
    }

    const pages: RawPdfPage[] = [];
    let pageNumber = 0;
    const visitedObjectIds = new Set<PdfDictionary>();

    const walk = (node: PdfDictionary, inheritedMediaBox: readonly [number, number, number, number], inheritedRotate: number, inheritedResources: PdfDictionary | undefined): void => {
      if (visitedObjectIds.has(node)) return; // guards against a malformed cyclic page tree
      visitedObjectIds.add(node);

      const mediaBoxValue = this.dictGet(node, 'MediaBox');
      const mediaBox = mediaBoxValue !== undefined && isArray(mediaBoxValue) && mediaBoxValue.items.length === 4 ? (mediaBoxValue.items.map((n) => (typeof n === 'number' ? n : 0)) as [number, number, number, number]) : inheritedMediaBox;

      const rotateValue = this.dictGet(node, 'Rotate');
      const rotate = typeof rotateValue === 'number' ? rotateValue : inheritedRotate;

      const resourcesValue = this.dictGet(node, 'Resources');
      const resources = resourcesValue !== undefined && isDictionary(resourcesValue) ? resourcesValue : inheritedResources;

      const typeValue = this.dictGet(node, 'Type');
      const isLeafPage = typeValue !== undefined && isName(typeValue) && typeValue.name === 'Page';

      if (isLeafPage) {
        pageNumber += 1;
        pages.push(this.buildPage(pageNumber, node, mediaBox, rotate, resources));
        return;
      }

      const kidsValue = this.dictGet(node, 'Kids');
      if (kidsValue !== undefined && isArray(kidsValue)) {
        for (const kidRef of kidsValue.items) {
          const kid = this.resolve(kidRef);
          if (isDictionary(kid)) walk(kid, mediaBox, rotate, resources);
        }
      }
    };

    walk(pagesRoot, DEFAULT_MEDIA_BOX, 0, undefined);
    return pages;
  }

  private buildPage(
    pageNumber: number,
    node: PdfDictionary,
    mediaBox: readonly [number, number, number, number],
    rotate: number,
    resources: PdfDictionary | undefined,
  ): RawPdfPage {
    const contentsValue = this.dictGet(node, 'Contents');
    const streams: Uint8Array[] = [];
    if (contentsValue !== undefined) {
      if (isStream(contentsValue)) {
        streams.push(decodeStream(contentsValue));
      } else if (isArray(contentsValue)) {
        for (const item of contentsValue.items) {
          const resolved = this.resolve(item);
          if (isStream(resolved)) streams.push(decodeStream(resolved));
        }
      }
    }
    const contentBytes = concatWithNewlines(streams);

    let objectNumber = -1;
    for (const [objNum] of this.xref.entriesByObjectNumber) {
      if (this.cache.get(objNum) === node) {
        objectNumber = objNum;
        break;
      }
    }

    return {
      pageNumber,
      objectNumber,
      mediaBox,
      rotate,
      contentBytes,
      hasFullPageImageXObject: hasSuspiciouslyFullPageImage(this, resources, mediaBox),
      resources,
    };
  }
}

function concatWithNewlines(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 0) return new Uint8Array(0);
  const total = parts.reduce((sum, p) => sum + p.length + 1, -1);
  const out = new Uint8Array(Math.max(total, 0));
  let offset = 0;
  parts.forEach((part, i) => {
    out.set(part, offset);
    offset += part.length;
    if (i < parts.length - 1) {
      out[offset] = 0x0a;
      offset += 1;
    }
  });
  return out;
}

function hasSuspiciouslyFullPageImage(doc: PdfDocument, resources: PdfDictionary | undefined, mediaBox: readonly [number, number, number, number]): boolean {
  if (!resources) return false;
  const xObjectsValue = resources.entries.get('XObject');
  if (xObjectsValue === undefined) return false;
  const xObjects = doc.resolve(xObjectsValue);
  if (!isDictionary(xObjects)) return false;

  const pageArea = Math.abs((mediaBox[2] - mediaBox[0]) * (mediaBox[3] - mediaBox[1]));
  for (const value of xObjects.entries.values()) {
    const resolved = doc.resolve(value);
    if (!isStream(resolved)) continue;
    const subtype = resolved.dictionary.entries.get('Subtype');
    if (!(subtype !== undefined && isName(subtype) && subtype.name === 'Image')) continue;
    const widthValue = doc.resolve(resolved.dictionary.entries.get('Width') ?? 0);
    const heightValue = doc.resolve(resolved.dictionary.entries.get('Height') ?? 0);
    const width = typeof widthValue === 'number' ? widthValue : 0;
    const height = typeof heightValue === 'number' ? heightValue : 0;
    // A rough heuristic: an embedded image with a pixel count in the same order of magnitude as the page's point-area at typical scan resolutions (~100+ DPI) is almost certainly a full-page scan, not a small figure/logo.
    if (width * height > pageArea * 0.5) return true;
  }
  return false;
}
