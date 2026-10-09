import { Readable } from 'node:stream';
import { err, ok, type Result } from '@xo/types';
import { ErrorCode, PackageError } from '@xo/errors';

export interface TarEntry {
  readonly path: string;
  readonly data: Uint8Array;
}

const BLOCK_SIZE = 512;

/**
 * Minimal, dependency-free POSIX ustar reader/writer. Sandbox note: this
 * SDK was originally written against the `tar-stream` package, but this
 * environment has no network access to install it, so the pack/extract
 * internals below are a hand-rolled ustar implementation instead —
 * everything downstream (`package-writer.ts`, `package-reader.ts`) only
 * ever calls the four functions this module exports, so the swap is
 * invisible to every other caller. Only regular files are supported
 * (sufficient for `.xo` archives, which contain no directories, symlinks,
 * or devices), and paths are limited to ustar's 100+155 byte name+prefix
 * split (~255 bytes), which every real component path in
 * SPECIFICATION.md §1.1's layout comfortably fits under.
 */

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const octal = value.toString(8).padStart(length - 1, '0');
  if (octal.length > length - 1) {
    throw new RangeError(`Value ${value} does not fit in a ${length}-byte octal tar field`);
  }
  buf.write(octal, offset, length - 1, 'ascii');
  buf[offset + length - 1] = 0;
}

function parseOctal(buf: Buffer, offset: number, length: number): number {
  const raw = buf.toString('ascii', offset, offset + length).replace(/\0/g, '').trim();
  return raw.length > 0 ? Number.parseInt(raw, 8) : 0;
}

/** Splits `path` into ustar's `name` (<=100 bytes) + `prefix` (<=155 bytes) fields, preferring the split closest to the start of the path so `name` stays as short as possible. */
function splitPath(path: string): { readonly name: string; readonly prefix: string } {
  if (Buffer.byteLength(path, 'utf8') <= 100) return { name: path, prefix: '' };

  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    const name = parts.slice(i).join('/');
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(name, 'utf8') <= 100) {
      return { name, prefix };
    }
  }
  throw new RangeError(`Path too long to represent in ustar format: "${path}"`);
}

function joinPath(name: string, prefix: string): string {
  return prefix.length > 0 ? `${prefix}/${name}` : name;
}

function buildHeader(entry: TarEntry): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE, 0);
  const { name, prefix } = splitPath(entry.path);

  header.write(name, 0, 100, 'utf8');
  writeOctal(header, 100, 8, 0o644); // mode
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, entry.data.byteLength); // size
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000)); // mtime
  header.fill(0x20, 148, 156); // chksum field, spaces, while computing the checksum below
  header[156] = 0x30; // typeflag '0' = regular file
  header.write('ustar', 257, 6, 'ascii'); // magic, NUL-terminated (fill already zeroed the 6th byte)
  header.write('00', 263, 2, 'ascii'); // version
  header.write('xo', 265, 32, 'utf8'); // uname
  header.write('xo', 297, 32, 'utf8'); // gname
  writeOctal(header, 329, 8, 0); // devmajor
  writeOctal(header, 337, 8, 0); // devminor
  header.write(prefix, 345, 155, 'utf8');

  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) sum += header[i] as number;
  header.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;

  return header;
}

function packEntries(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    blocks.push(buildHeader(entry));
    const data = Buffer.from(entry.data);
    blocks.push(data);
    const padding = (BLOCK_SIZE - (data.byteLength % BLOCK_SIZE)) % BLOCK_SIZE;
    if (padding > 0) blocks.push(Buffer.alloc(padding, 0));
  }
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2, 0)); // two-zero-block end-of-archive marker
  return Buffer.concat(blocks);
}

function parseEntries(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + BLOCK_SIZE <= buf.byteLength) {
    const header = buf.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((b) => b === 0)) break; // end-of-archive marker

    const name = header.toString('utf8', 0, 100).replace(/\0.*$/su, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/su, '');
    const size = parseOctal(header, 124, 12);
    const typeflag = header[156];
    offset += BLOCK_SIZE;

    const data = buf.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;

    if (typeflag === 0x30 || typeflag === 0) {
      entries.push({ path: joinPath(name, prefix), data: new Uint8Array(data) });
    }
  }
  return entries;
}

/**
 * Builds a tar {@link Readable} from an ordered list of entries — the
 * uncompressed half of SPECIFICATION.md §1.1's "content-addressed tarball
 * (zstd-compressed)". The whole archive is built up front rather than
 * incrementally (see the sandbox note above); the stream API is
 * preserved so callers piping this into zstd compression don't need to
 * change if a fully streaming tar writer is dropped in later.
 */
export function tarEntriesToStream(entries: readonly TarEntry[]): Readable {
  return Readable.from(packEntries(entries));
}

export async function tarEntriesToBuffer(entries: readonly TarEntry[]): Promise<Uint8Array> {
  return new Uint8Array(packEntries(entries));
}

/**
 * Extracts every entry from a tar stream/buffer. Returns a `Result`
 * because a corrupt or truncated tar (SPECIFICATION.md §1's archive
 * itself, not one of its JSON components) is exactly the "corruption
 * detection" case this SDK's validation layer is required to surface,
 * not a thing worth throwing for.
 */
export async function tarStreamToEntries(input: Readable): Promise<Result<readonly TarEntry[], PackageError>> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of input) {
      chunks.push(chunk as Buffer);
    }
  } catch (cause) {
    return err(new PackageError(ErrorCode.PACKAGE_CORRUPT, 'Corrupt archive input stream', { cause }));
  }
  try {
    return ok(parseEntries(Buffer.concat(chunks)));
  } catch (cause) {
    return err(new PackageError(ErrorCode.PACKAGE_CORRUPT, 'Corrupt tar archive', { cause }));
  }
}

export async function tarBufferToEntries(buffer: Uint8Array): Promise<Result<readonly TarEntry[], PackageError>> {
  try {
    return ok(parseEntries(Buffer.from(buffer)));
  } catch (cause) {
    return err(new PackageError(ErrorCode.PACKAGE_CORRUPT, 'Corrupt tar archive', { cause }));
  }
}
