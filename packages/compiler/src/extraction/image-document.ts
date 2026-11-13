import type { LoadedPdfDocument } from '../pdf/pdf-loader.js';

/**
 * UW-3 — a photographed or scanned image (a certificate snapped on a phone) wrapped as a one-page document with no text layer, so the
 * page-recovery tiers read it exactly as they read a scanned PDF page: in cost order, within budget, cached, with the outcome in the
 * coverage ledger and the tier and confidence on every block of text it yields. Page space is the image's pixel grid (one pixel, one
 * point); dimensions default to A4 at 72 dpi when the frontend could not read them.
 */
export function imageAsRecoverableDocument(
  sourcePath: string,
  mimeType: string,
  dimensions?: { readonly width: number; readonly height: number },
): LoadedPdfDocument {
  const width = dimensions?.width ?? 595;
  const height = dimensions?.height ?? 842;
  return {
    sourcePath,
    metadata: {
      title: undefined,
      author: undefined,
      subject: undefined,
      creator: undefined,
      producer: undefined,
      creationDate: undefined,
      modificationDate: undefined,
    },
    pageCount: 1,
    sourceImage: { mimeType, ...(dimensions !== undefined ? { width: dimensions.width, height: dimensions.height } : {}) },
    pages: [
      {
        pageNumber: 1,
        sourceObjectNumber: 0,
        mediaBox: [0, 0, width, height],
        rotate: 0,
        plainText: '',
        textRuns: [],
        requiresOcr: true,
        isBlank: false,
        hasImage: true,
        resolveFontEncoding: () => ({ codeByteWidth: 1, decode: (bytes) => Buffer.from(bytes).toString('latin1') }),
      },
    ],
  };
}
