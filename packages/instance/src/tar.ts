/**
 * A small, streaming POSIX tar (ustar + PAX long names and sizes) for instance backups. Only regular files and directories are written
 * or accepted: links, devices and anything else are refused when reading, so a crafted archive cannot plant a link that a later file
 * is written through. Standard tools (`tar -tzf`) can list and extract what this writes.
 */
const BLOCK = 512;

export interface TarEntryHeader {
  readonly path: string;
  readonly type: 'file' | 'directory';
  readonly size: number;
  readonly mode: number;
  readonly mtime: Date;
}

export class TarError extends Error {}

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return `${len}${body}`;
}

function header(name: string, size: number, mode: number, mtime: Date, typeflag: string): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode & 0o7777, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(Math.floor(mtime.getTime() / 1000), 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write(typeflag, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148, 8, 'ascii');
  return h;
}

const MAX_OCTAL_SIZE = 8 ** 11 - 1;

/** Header block(s) for one entry: a PAX record first when the path or size does not fit the classic fields. */
export function entryHeader(e: TarEntryHeader): Buffer {
  const name = e.type === 'directory' && !e.path.endsWith('/') ? `${e.path}/` : e.path;
  const blocks: Buffer[] = [];
  const pax: string[] = [];
  if (Buffer.byteLength(name) > 99) pax.push(paxRecord('path', name));
  if (e.size > MAX_OCTAL_SIZE) pax.push(paxRecord('size', String(e.size)));
  if (pax.length > 0) {
    const body = Buffer.from(pax.join(''), 'utf8');
    blocks.push(header('PaxHeader', body.length, 0o644, e.mtime, 'x'), body, Buffer.alloc(padding(body.length)));
  }
  const shortName = Buffer.byteLength(name) > 99 ? name.slice(-99) : name;
  blocks.push(header(shortName, Math.min(e.size, MAX_OCTAL_SIZE), e.mode, e.mtime, e.type === 'directory' ? '5' : '0'));
  return Buffer.concat(blocks);
}

export function padding(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

export const END_OF_ARCHIVE = Buffer.alloc(BLOCK * 2, 0);

export interface TarEntrySink {
  write(chunk: Buffer): void | Promise<void>;
  end(): void | Promise<void>;
}

function readString(b: Buffer, off: number, len: number): string {
  const s = b.subarray(off, off + len);
  const z = s.indexOf(0);
  return (z === -1 ? s : s.subarray(0, z)).toString('utf8');
}

function readOctal(b: Buffer, off: number, len: number): number {
  const s = readString(b, off, len).trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw new TarError('a header field is not a number');
  return parseInt(s, 8);
}

function parsePax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  const text = body.toString('utf8');
  while (i < text.length) {
    const sp = text.indexOf(' ', i);
    if (sp === -1) break;
    const len = Number(text.slice(i, sp));
    if (!Number.isInteger(len) || len <= 0) throw new TarError('a PAX record is malformed');
    const record = text.slice(sp + 1, i + len - 1);
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * Reads an archive as it streams in. For each entry the visitor returns a sink for its content (or undefined to skip it). Content is
 * delivered in order with backpressure: the next chunk is not read until the previous `write` has resolved.
 */
export async function readTar(
  source: AsyncIterable<Uint8Array>,
  visit: (entry: TarEntryHeader) => Promise<TarEntrySink | undefined> | TarEntrySink | undefined,
): Promise<void> {
  let buf: Buffer = Buffer.alloc(0);
  let state: 'header' | 'content' | 'pad' | 'pax' | 'done' = 'header';
  let remaining = 0;
  let pad = 0;
  let sink: TarEntrySink | undefined;
  let paxBody: Buffer[] = [];
  let pending: Record<string, string> = {};
  let zeroBlocks = 0;

  const finishEntry = async () => {
    if (sink !== undefined) await sink.end();
    sink = undefined;
  };

  for await (const chunk of source) {
    buf = buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([buf, chunk]);
    for (;;) {
      if (state === 'done') break;
      if (state === 'header') {
        if (buf.length < BLOCK) break;
        const h = buf.subarray(0, BLOCK);
        buf = buf.subarray(BLOCK);
        if (h.every((b) => b === 0)) {
          if (++zeroBlocks === 2) state = 'done';
          continue;
        }
        zeroBlocks = 0;
        let sum = 0;
        for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
        if (sum !== readOctal(h, 148, 8)) throw new TarError('a header checksum does not match (the archive is damaged)');
        const flag = String.fromCharCode(h[156]!);
        const headerSize = readOctal(h, 124, 12);
        const size = flag !== 'x' && flag !== 'g' && pending['size'] !== undefined ? Number(pending['size']) : headerSize;
        if (!Number.isSafeInteger(size) || size < 0) throw new TarError('an entry size is invalid');
        if (flag === 'x' || flag === 'g') {
          remaining = size;
          pad = padding(size);
          paxBody = [];
          state = flag === 'x' ? 'pax' : 'content';
          sink = undefined;
          continue;
        }
        if (flag !== '0' && flag !== '\0' && flag !== '5') {
          throw new TarError(`the archive contains a ${flag === '1' || flag === '2' ? 'link' : 'special file'}, which backups never hold`);
        }
        const prefix = readString(h, 345, 155);
        const base = readString(h, 0, 100);
        const path = pending['path'] ?? (prefix !== '' ? `${prefix}/${base}` : base);
        pending = {};
        const entry: TarEntryHeader = {
          path: path.replace(/\/$/, ''),
          type: flag === '5' ? 'directory' : 'file',
          size: flag === '5' ? 0 : size,
          mode: readOctal(h, 100, 8),
          mtime: new Date(readOctal(h, 136, 12) * 1000),
        };
        sink = await visit(entry);
        remaining = entry.size;
        pad = padding(entry.size);
        state = 'content';
        if (remaining === 0) {
          await finishEntry();
          state = pad > 0 ? 'pad' : 'header';
        }
        continue;
      }
      if (state === 'content' || state === 'pax') {
        if (remaining === 0) {
          if (state === 'pax') pending = parsePax(Buffer.concat(paxBody));
          else await finishEntry();
          state = pad > 0 ? 'pad' : 'header';
          continue;
        }
        if (buf.length === 0) break;
        const take = Math.min(remaining, buf.length);
        const piece = buf.subarray(0, take);
        buf = buf.subarray(take);
        remaining -= take;
        if (state === 'pax') paxBody.push(Buffer.from(piece));
        else if (sink !== undefined) await sink.write(Buffer.from(piece));
        continue;
      }
      if (state === 'pad') {
        if (buf.length < pad) break;
        buf = buf.subarray(pad);
        pad = 0;
        state = 'header';
      }
    }
  }
  if (state !== 'done' && !(state === 'header' && zeroBlocks > 0)) throw new TarError('the archive ends early (it is truncated)');
}
