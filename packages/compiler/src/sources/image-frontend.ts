import { err, ok, type Result } from '@xo/types';
import { ErrorCode, SourceError } from '@xo/errors';
import type { SourceFrontend, SourceIngestContext } from './frontend.js';
import type { CanonicalSource } from './types.js';
import { computeSourceId } from './source-id.js';
import type { LoadedPdfDocument } from '../pdf/pdf-loader.js';
import { parseDocument } from '../document/document-parser.js';
import { markRecoveredText } from '../document/recovered-text.js';
import { computePdfCoverage } from '../pdf/pdf-coverage.js';

export interface ImageSourceInput {
  readonly kind: 'image';
  readonly bytes: Uint8Array;
  readonly sourcePath: string;
  /** Supplied by the caller when known; otherwise sniffed from the bytes' magic header. */
  readonly mimeType?: string;
  /**
   * UW-3 — the image wrapped as a one-page document (`imageAsRecoverableDocument`) after the recovery tiers ran on it. When its page was
   * recovered, the image becomes a document source with that text (marked recovered, with tier and confidence); otherwise it stays a
   * binary source whose coverage says the text was not read.
   */
  readonly preloaded?: LoadedPdfDocument;
}

function isImageSourceInput(input: unknown): input is ImageSourceInput {
  if (typeof input !== 'object' || input === null) return false;
  const candidate = input as Partial<ImageSourceInput>;
  return candidate.kind === 'image' && candidate.bytes instanceof Uint8Array && typeof candidate.sourcePath === 'string';
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

export function sniffMimeType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (
    bytes.length >= 12 &&
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return 'image/webp';
  return undefined;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

/**
 * Deterministic, dependency-free dimension extraction from image headers (PNG, GIF, and since UW-3 JPEG: the frame header of a phone
 * photo). A malformed header simply yields no `dimensions`, never a guess. JPEG dimensions are as stored, before any EXIF rotation.
 */
export function extractDimensions(
  bytes: Uint8Array,
  mimeType: string | undefined,
): { readonly width: number; readonly height: number } | undefined {
  if (mimeType === 'image/png' && bytes.length >= 24) {
    return { width: readUint32BE(bytes, 16), height: readUint32BE(bytes, 20) };
  }
  if (mimeType === 'image/gif' && bytes.length >= 10) {
    return { width: readUint16LE(bytes, 6), height: readUint16LE(bytes, 8) };
  }
  if (mimeType === 'image/jpeg') return jpegDimensions(bytes);
  return undefined;
}

/** Walks JPEG markers to the first start-of-frame (SOF0..SOF15 except DHT, JPG and DAC) and reads its height and width. */
function jpegDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return undefined;
    const marker = bytes[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (length < 2) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (bytes[i + 5]! << 8) | bytes[i + 6]!;
      const width = (bytes[i + 7]! << 8) | bytes[i + 8]!;
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    i += 2 + length;
  }
  return undefined;
}

/**
 * The Image family. On its own this frontend represents an image's bytes, MIME type and pixel dimensions, and reads no text: an image
 * is a binary source (`semanticExtractionAvailable: false`), reported explicitly rather than with invented text. Since UW-3 a caller
 * that ran the page-recovery tiers on it (`compileSources` with `pageTiers`) passes the result as `preloaded`; a recovered image then
 * becomes a one-page document whose every block is marked as recovered text, with the tier and its confidence.
 */
export class ImageSourceFrontend implements SourceFrontend<ImageSourceInput> {
  readonly sourceType = 'image' as const;

  canHandle(input: unknown): input is ImageSourceInput {
    return isImageSourceInput(input);
  }

  ingest(input: ImageSourceInput, _context?: SourceIngestContext): Result<CanonicalSource, SourceError> {
    if (input.bytes.length === 0) {
      return err(
        new SourceError(ErrorCode.PRECONDITION_FAILED, `Image source "${input.sourcePath}" has no bytes`, {
          context: { sourcePath: input.sourcePath },
        }),
      );
    }

    const mimeType = input.mimeType ?? sniffMimeType(input.bytes);
    if (mimeType === undefined) {
      return err(
        new SourceError(
          ErrorCode.SERIALIZATION_SCHEMA_MISMATCH,
          `Image source "${input.sourcePath}" is not a recognized image format (no MIME type supplied and none could be sniffed from its bytes)`,
          {
            context: { sourcePath: input.sourcePath },
          },
        ),
      );
    }

    const dimensions = extractDimensions(input.bytes, mimeType);
    const sourceId = computeSourceId('image', input.sourcePath, input.bytes);
    const page = input.preloaded?.pages[0];
    if (input.preloaded !== undefined && page?.recovery !== undefined) {
      const parsed = markRecoveredText(parseDocument(input.preloaded), input.preloaded.pages);
      return ok({
        sourceId,
        sourceType: 'image',
        sourcePath: input.sourcePath,
        content: {
          kind: 'document',
          parsed,
          documentTitle: undefined,
          plainText: page.plainText,
          coverage: computePdfCoverage(input.preloaded),
        },
        metadata: {
          mimeType,
          textRecoveredBy: page.recovery.tier,
          textConfidence: String(page.recovery.confidence),
          ...(dimensions !== undefined ? { width: String(dimensions.width), height: String(dimensions.height) } : {}),
        },
        semanticExtractionAvailable: true,
      });
    }

    return ok({
      sourceId,
      sourceType: 'image',
      sourcePath: input.sourcePath,
      content: { kind: 'binary', mimeType, byteLength: input.bytes.length, ...(dimensions !== undefined ? { dimensions } : {}) },
      metadata: { mimeType, ...(input.preloaded !== undefined ? { textRecovery: 'no tier could read text from this image' } : {}) },
      semanticExtractionAvailable: false,
    });
  }
}
