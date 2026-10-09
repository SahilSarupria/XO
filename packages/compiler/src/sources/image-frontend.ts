import { err, ok, type Result } from '@xo/types';
import { ErrorCode, SourceError } from '@xo/errors';
import type { SourceFrontend, SourceIngestContext } from './frontend.js';
import type { CanonicalSource } from './types.js';
import { computeSourceId } from './source-id.js';

export interface ImageSourceInput {
  readonly kind: 'image';
  readonly bytes: Uint8Array;
  readonly sourcePath: string;
  /** Supplied by the caller when known; otherwise sniffed from the bytes' magic header. */
  readonly mimeType?: string;
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

function sniffMimeType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (bytes.length >= 12 && startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return undefined;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

/** Deterministic, dependency-free dimension extraction for the two formats whose headers are trivial to read without a full decoder. Any other format (or a malformed header) simply yields no `dimensions` — never a guess. */
function extractDimensions(bytes: Uint8Array, mimeType: string | undefined): { readonly width: number; readonly height: number } | undefined {
  if (mimeType === 'image/png' && bytes.length >= 24) {
    return { width: readUint32BE(bytes, 16), height: readUint32BE(bytes, 20) };
  }
  if (mimeType === 'image/gif' && bytes.length >= 10) {
    return { width: readUint16LE(bytes, 6), height: readUint16LE(bytes, 8) };
  }
  return undefined;
}

/**
 * The Image family (Stage 8 §8). Deliberately "Extensible," not "Fully
 * supported" (§22, §23): this frontend can represent an image's bytes,
 * MIME type, and (for PNG/GIF) pixel dimensions deterministically and
 * with real provenance, but performs no OCR/vision extraction — there is
 * no such dependency in this repository to integrate, and Stage 8 §8
 * explicitly forbids adding a large external vision dependency for this
 * stage. `CanonicalSource.semanticExtractionAvailable` is `false` for
 * every image this frontend ingests, and `compile-sources.ts` reports
 * that explicitly (a diagnostic, not a silent drop and not invented
 * text) rather than ever claiming "image compilation supported."
 */
export class ImageSourceFrontend implements SourceFrontend<ImageSourceInput> {
  readonly sourceType = 'image' as const;

  canHandle(input: unknown): input is ImageSourceInput {
    return isImageSourceInput(input);
  }

  ingest(input: ImageSourceInput, _context?: SourceIngestContext): Result<CanonicalSource, SourceError> {
    if (input.bytes.length === 0) {
      return err(new SourceError(ErrorCode.PRECONDITION_FAILED, `Image source "${input.sourcePath}" has no bytes`, { context: { sourcePath: input.sourcePath } }));
    }

    const mimeType = input.mimeType ?? sniffMimeType(input.bytes);
    if (mimeType === undefined) {
      return err(
        new SourceError(ErrorCode.SERIALIZATION_SCHEMA_MISMATCH, `Image source "${input.sourcePath}" is not a recognized image format (no MIME type supplied and none could be sniffed from its bytes)`, {
          context: { sourcePath: input.sourcePath },
        }),
      );
    }

    const dimensions = extractDimensions(input.bytes, mimeType);
    const sourceId = computeSourceId('image', input.sourcePath, input.bytes);

    return ok({
      sourceId,
      sourceType: 'image',
      sourcePath: input.sourcePath,
      content: { kind: 'binary', mimeType, byteLength: input.bytes.length, ...(dimensions !== undefined ? { dimensions } : {}) },
      metadata: { mimeType },
      semanticExtractionAvailable: false,
    });
  }
}
