import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encodes an 8-bit grayscale bitmap as PNG. Deterministic; no dependencies. */
export function encodeGrayPng(width: number, height: number, gray: Uint8Array): Buffer {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(gray.buffer, gray.byteOffset + y * width, width).copy(raw, y * (width + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface GrayImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Rotates by a multiple of 90 degrees clockwise. */
export function rotateGray(img: GrayImage, degrees: 0 | 90 | 180 | 270): GrayImage {
  if (degrees === 0) return img;
  const { width: w, height: h, data } = img;
  if (degrees === 180) {
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) out[data.length - 1 - i] = data[i]!;
    return { width: w, height: h, data: out };
  }
  const out = new Uint8Array(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x]!;
      if (degrees === 90) out[x * h + (h - 1 - y)] = v;
      else out[(w - 1 - x) * h + y] = v;
    }
  }
  return { width: h, height: w, data: out };
}

/** Crops blank margins (pixels lighter than `threshold`), keeping `pad` pixels. Fewer pixels sent to any engine, same content. */
export function cropToContent(img: GrayImage, threshold = 245, pad = 12): GrayImage {
  const { width: w, height: h, data } = img;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (data[row + x]! < threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        maxY = y;
      }
    }
  }
  if (maxX < 0) return img; // blank: nothing to crop to
  const x0 = Math.max(0, minX - pad);
  const y0 = Math.max(0, minY - pad);
  const x1 = Math.min(w - 1, maxX + pad);
  const y1 = Math.min(h - 1, maxY + pad);
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  if (cw === w && ch === h) return img;
  const out = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) out.set(data.subarray((y0 + y) * w + x0, (y0 + y) * w + x0 + cw), y * cw);
  return { width: cw, height: ch, data: out };
}
