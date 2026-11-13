/**
 * Minimal, hardened ZIP reader shared by the Office-format frontends (DOCX, XLSX). No third-party dependency.
 * Refuses: non-ZIP data, zip64, unknown compression methods, CRC mismatches, too many entries, and any entry that is (or
 * decompresses to) more than the size limit — so a decompression bomb cannot exhaust memory.
 */
import { crc32, inflateRawSync } from 'node:zlib';

export const MAX_ENTRIES = 2000;
export const MAX_ENTRY_BYTES = 50 * 1024 * 1024;

export class ZipFormatError extends Error {}

function findEndOfCentralDirectory(buf: Buffer): number {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) return i;
  return -1;
}

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

export function readCentralDirectory(buf: Buffer): Map<string, ZipEntry> {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new ZipFormatError('not a ZIP file such as .docx or .xlsx (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipFormatError('zip64 archives are not supported');
  if (count > MAX_ENTRIES) throw new ZipFormatError(`archive has too many entries (${count} > limit ${MAX_ENTRIES})`);
  const entries = new Map<string, ZipEntry>();
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipFormatError('corrupt ZIP central directory');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, {
      name,
      method: buf.readUInt16LE(p + 10),
      crc: buf.readUInt32LE(p + 16),
      compressedSize: buf.readUInt32LE(p + 20),
      uncompressedSize: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  if (entry.uncompressedSize > MAX_ENTRY_BYTES)
    throw new ZipFormatError(`entry "${entry.name}" is too large (${entry.uncompressedSize} bytes > limit ${MAX_ENTRY_BYTES})`);
  const o = entry.localOffset;
  if (o + 30 > buf.length || buf.readUInt32LE(o) !== 0x04034b50) throw new ZipFormatError(`corrupt local header for "${entry.name}"`);
  const start = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
  const body = buf.subarray(start, start + entry.compressedSize);
  if (body.length !== entry.compressedSize) throw new ZipFormatError(`truncated data for "${entry.name}"`);
  let data: Buffer;
  if (entry.method === 0) data = Buffer.from(body);
  else if (entry.method === 8) {
    try {
      data = inflateRawSync(body, { maxOutputLength: MAX_ENTRY_BYTES });
    } catch (cause) {
      const message = (cause as Error).message;
      throw new ZipFormatError(
        /maxOutputLength|larger than|limit/i.test(message)
          ? `entry "${entry.name}" is too large after decompression (limit ${MAX_ENTRY_BYTES} bytes)`
          : `could not decompress "${entry.name}": ${message}`,
      );
    }
  } else throw new ZipFormatError(`unsupported compression method ${entry.method} for "${entry.name}"`);
  if (data.length > MAX_ENTRY_BYTES)
    throw new ZipFormatError(`entry "${entry.name}" is too large after decompression (limit ${MAX_ENTRY_BYTES} bytes)`);
  if (typeof crc32 === 'function' && crc32(data) >>> 0 !== entry.crc)
    throw new ZipFormatError(`CRC mismatch in "${entry.name}" (corrupt archive)`);
  return data;
}
