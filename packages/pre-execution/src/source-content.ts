/**
 * PX-1 (ADR 0029 decision 3): what the bytes of a source actually are, decided from the bytes — never from the file name or
 * the client's declared media type alone.
 *
 * `classifySourceContent` sniffs signatures (magic bytes) and text, and checks them against the extension. A contradiction
 * is refused with a structured code, so a `.pdf` that holds HTML, a renamed executable, or an empty upload stops at the door
 * instead of failing later inside a parser. The check is cheap (it reads at most the first 64 KiB) and has no dependencies.
 *
 * `checkArchiveEntries` holds the entries of an archive (a `.zip` given to the CLI, an Office file) to one set of limits:
 * entry count, per-entry and total inflated size, compression ratio, nesting, and paths that would leave the extraction root.
 */

export type DetectedFormat = 'pdf' | 'zip' | 'png' | 'jpeg' | 'gif' | 'webp' | 'tiff' | 'bmp' | 'heic' | 'text' | 'utf16-text' | 'binary';

export type SourceRejectionCode =
  'SOURCE_EMPTY' | 'SOURCE_TOO_LARGE' | 'SOURCE_UNSUPPORTED' | 'SOURCE_SIGNATURE_MISMATCH' | 'SOURCE_ARCHIVE_UNSAFE';

export type SourceContentCheck =
  | { readonly ok: true; readonly detected: DetectedFormat; readonly expected: readonly DetectedFormat[] }
  | {
      readonly ok: false;
      readonly code: SourceRejectionCode;
      readonly message: string;
      readonly detected?: DetectedFormat;
      readonly expected?: readonly DetectedFormat[];
    };

/**
 * Any image signature is accepted under any image extension: a screenshot saved as `.jpg` is still an image, and the image
 * reader sniffs the real type. The detected format is what the record's media type follows (`MEDIA_TYPE_BY_FORMAT`).
 */
const IMAGES: readonly DetectedFormat[] = ['png', 'jpeg', 'gif', 'webp', 'tiff', 'bmp', 'heic'];

/** What each supported extension may contain. One table, published in docs/INGESTION.md. */
export const EXPECTED_CONTENT: Readonly<Record<string, readonly DetectedFormat[]>> = {
  '.pdf': ['pdf'],
  '.docx': ['zip'],
  '.xlsx': ['zip'],
  '.zip': ['zip'],
  '.png': IMAGES,
  '.jpg': IMAGES,
  '.jpeg': IMAGES,
  '.gif': IMAGES,
  '.webp': IMAGES,
  '.tif': IMAGES,
  '.tiff': IMAGES,
  '.bmp': IMAGES,
  '.heic': IMAGES,
  '.heif': IMAGES,
  '.eml': ['text'],
  '.html': ['text', 'utf16-text'],
  '.htm': ['text', 'utf16-text'],
  '.json': ['text', 'utf16-text'],
  '.csv': ['text', 'utf16-text'],
  '.txt': ['text', 'utf16-text'],
  '.md': ['text', 'utf16-text'],
  '.markdown': ['text', 'utf16-text'],
};

/** The media type a detected image format is stored under, whatever the file was named. */
export const MEDIA_TYPE_BY_FORMAT: Readonly<Partial<Record<DetectedFormat, string>>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  heic: 'image/heic',
};

const SNIFF_BYTES = 64 * 1024;

function startsWith(bytes: Uint8Array, sig: readonly number[], at = 0): boolean {
  if (bytes.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i += 1) if (bytes[at + i] !== sig[i]) return false;
  return true;
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < Math.min(to, bytes.length); i += 1) s += String.fromCharCode(bytes[i]!);
  return s;
}

/** The format the bytes are, from signatures first and a text test last. */
export function detectFormat(bytes: Uint8Array): DetectedFormat {
  // PDF allows the header anywhere in the first 1024 bytes (ISO 32000-1, 7.5.2 implementation note).
  const head = ascii(bytes, 0, 1024);
  if (head.includes('%PDF-')) return 'pdf';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) return 'zip';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp';
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff';
  if (ascii(bytes, 0, 2) === 'BM' && bytes.length > 26) return 'bmp';
  if (ascii(bytes, 4, 8) === 'ftyp' && /^(?:heic|heix|hevc|heim|heis|mif1|msf1)$/.test(ascii(bytes, 8, 12))) return 'heic';
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) return 'utf16-text';
  // Text: no NUL byte and few control characters in the sniffed prefix. Encodings are the readers' concern (UTF-8 and
  // Windows-1252 CSV both pass); only binary content is refused here.
  const n = Math.min(bytes.length, SNIFF_BYTES);
  let control = 0;
  for (let i = 0; i < n; i += 1) {
    const b = bytes[i]!;
    if (b === 0) return 'binary';
    if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b)) control += 1;
  }
  return control > n * 0.01 ? 'binary' : 'text';
}

export interface ContentCheckOptions {
  /** The largest accepted source, in bytes. */
  readonly maxBytes?: number;
}

export const DEFAULT_MAX_SOURCE_BYTES = 64 * 1024 * 1024;

/**
 * Checks `bytes` against the file's `extension` (lowercased, with the dot). Refuses: empty content, content over
 * `maxBytes`, an extension outside `EXPECTED_CONTENT`, and content whose detected format the extension does not allow.
 */
export function classifySourceContent(bytes: Uint8Array, extension: string, options: ContentCheckOptions = {}): SourceContentCheck {
  const ext = extension.toLowerCase();
  const expected = EXPECTED_CONTENT[ext];
  if (expected === undefined) return { ok: false, code: 'SOURCE_UNSUPPORTED', message: `"${ext}" is not a supported source type` };
  if (bytes.length === 0) return { ok: false, code: 'SOURCE_EMPTY', message: 'the source is empty', expected };
  const max = options.maxBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  if (bytes.length > max) {
    return { ok: false, code: 'SOURCE_TOO_LARGE', message: `the source is ${bytes.length} bytes; the limit is ${max}`, expected };
  }
  const detected = detectFormat(bytes);
  if (!expected.includes(detected)) {
    return {
      ok: false,
      code: 'SOURCE_SIGNATURE_MISMATCH',
      message: `the content is ${describe(detected)}, not what a "${ext}" file holds (${expected.map(describe).join(' or ')})`,
      detected,
      expected,
    };
  }
  return { ok: true, detected, expected };
}

function describe(format: DetectedFormat): string {
  switch (format) {
    case 'pdf':
      return 'a PDF';
    case 'zip':
      return 'a ZIP container';
    case 'text':
      return 'text';
    case 'utf16-text':
      return 'UTF-16 text';
    case 'binary':
      return 'binary data';
    default:
      return `a ${format.toUpperCase()} image`;
  }
}

// ── archives ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ArchiveLimits {
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxTotalBytes: number;
  /** Inflated size over compressed size, per entry; a ratio this high on a large entry is a decompression bomb. */
  readonly maxCompressionRatio: number;
  /** Archives inside archives, counting the outermost as depth 1. */
  readonly maxDepth: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 2000,
  maxEntryBytes: 50 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxDepth: 2,
};

export interface ArchiveEntryInfo {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

export type ArchiveCheck = { readonly ok: true } | { readonly ok: false; readonly code: 'SOURCE_ARCHIVE_UNSAFE'; readonly message: string };

/** A path that stays inside the extraction root: relative, no `..` segment, no drive letter, no NUL. */
export function isSafeArchivePath(name: string): boolean {
  if (name.length === 0 || name.includes('\0')) return false;
  const normal = name.replace(/\\/g, '/');
  if (normal.startsWith('/') || /^[a-zA-Z]:/.test(normal)) return false;
  return !normal.split('/').some((seg) => seg === '..');
}

/** Holds an archive's declared entries to `limits`; `depth` is this archive's nesting depth (1 for a top-level archive). */
export function checkArchiveEntries(
  entries: readonly ArchiveEntryInfo[],
  depth = 1,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): ArchiveCheck {
  const refuse = (message: string): ArchiveCheck => ({ ok: false, code: 'SOURCE_ARCHIVE_UNSAFE', message });
  if (depth > limits.maxDepth) return refuse(`archives are nested more than ${limits.maxDepth} deep`);
  if (entries.length > limits.maxEntries) return refuse(`the archive has ${entries.length} entries; the limit is ${limits.maxEntries}`);
  let total = 0;
  for (const e of entries) {
    if (!isSafeArchivePath(e.name)) return refuse(`entry "${e.name}" would be written outside the extraction root`);
    if (e.uncompressedSize > limits.maxEntryBytes) return refuse(`entry "${e.name}" inflates to more than ${limits.maxEntryBytes} bytes`);
    if (e.uncompressedSize > 1024 * 1024 && e.uncompressedSize > e.compressedSize * limits.maxCompressionRatio)
      return refuse(`entry "${e.name}" has a compression ratio above ${limits.maxCompressionRatio} (a decompression bomb)`);
    total += e.uncompressedSize;
    if (total > limits.maxTotalBytes) return refuse(`the archive inflates to more than ${limits.maxTotalBytes} bytes in total`);
  }
  return { ok: true };
}
