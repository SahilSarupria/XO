import { createCipheriv, createHash } from 'node:crypto';
import { PdfForge } from './pdf-forge.js';

/**
 * Writes PDFs protected with the Standard security handler (ISO 32000-1 §7.6: RC4 40/128-bit, AES-128), so the reader's
 * decryption can be tested against documents built exactly the way a real writer builds them. Deterministic: the file ID
 * and every AES IV are derived from fixed inputs. Test-only; nothing here ships.
 */
export interface EncryptionSpec {
  readonly cipher: 'rc4-40' | 'rc4-128' | 'aes-128';
  readonly userPassword: string;
  readonly ownerPassword: string;
}

const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');
const md5 = (...parts: Buffer[]): Buffer => createHash('md5').update(Buffer.concat(parts)).digest();

export function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = Buffer.alloc(data.length);
  let a = 0;
  let b = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 255;
    b = (b + s[a]!) & 255;
    [s[a], s[b]] = [s[b]!, s[a]!];
    out[k] = data[k]! ^ s[(s[a]! + s[b]!) & 255]!;
  }
  return out;
}

const padPassword = (pw: string): Buffer => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);
const xorKey = (key: Buffer, i: number): Buffer => Buffer.from(key.map((b) => b ^ i));

export function computeO(ownerPw: string, userPw: string, r: number, n: number): Buffer {
  let h = md5(padPassword(ownerPw === '' ? userPw : ownerPw));
  if (r >= 3) for (let i = 0; i < 50; i++) h = md5(h);
  const key = h.subarray(0, n);
  let o = rc4(key, padPassword(userPw));
  if (r >= 3) for (let i = 1; i <= 19; i++) o = rc4(xorKey(key, i), o);
  return o;
}

export function computeKey(userPw: string, o: Buffer, p: number, id0: Buffer, r: number, n: number): Buffer {
  const pBytes = Buffer.alloc(4);
  pBytes.writeInt32LE(p);
  let h = md5(padPassword(userPw), o, pBytes, id0);
  if (r >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
  return h.subarray(0, n);
}

export function computeU(key: Buffer, id0: Buffer, r: number): Buffer {
  if (r === 2) return rc4(key, PAD);
  let u = rc4(key, md5(PAD, id0));
  for (let i = 1; i <= 19; i++) u = rc4(xorKey(key, i), u);
  return Buffer.concat([u, Buffer.alloc(16)]);
}

export function objectKey(key: Buffer, objNum: number, gen: number, aes: boolean): Buffer {
  const ext = Buffer.from([objNum & 255, (objNum >> 8) & 255, (objNum >> 16) & 255, gen & 255, (gen >> 8) & 255]);
  const parts = aes ? [key, ext, Buffer.from('sAlT', 'latin1')] : [key, ext];
  return md5(...parts).subarray(0, Math.min(key.length + 5, 16));
}

const ID0 = Buffer.from('0123456789abcdeffedcba9876543210', 'hex');
const PERMISSIONS = -3904;

export function buildEncrypted(pageContents: readonly string[], spec: EncryptionSpec): Buffer {
  const aes = spec.cipher === 'aes-128';
  const n = spec.cipher === 'rc4-40' ? 5 : 16;
  const r = spec.cipher === 'rc4-40' ? 2 : aes ? 4 : 3;
  const v = spec.cipher === 'rc4-40' ? 1 : aes ? 4 : 2;
  const o = computeO(spec.ownerPassword, spec.userPassword, r, n);
  const key = computeKey(spec.userPassword, o, PERMISSIONS, ID0, r, n);
  const u = computeU(key, ID0, r);

  const f = new PdfForge();
  const catalog = f.alloc();
  const pagesNode = f.alloc();
  const font = f.alloc();
  const encObj = f.alloc();
  f.obj(font, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const pageNums: number[] = [];
  for (const content of pageContents) {
    const page = f.alloc();
    const cs = f.alloc();
    pageNums.push(page);
    f.obj(page, `<< /Type /Page /Parent ${pagesNode} 0 R /Contents ${cs} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
    // Compress first, then encrypt: the filter chain is applied to the plaintext, encryption wraps the encoded bytes.
    const encoded = f.encode(Buffer.from(content, 'latin1'), 'flate').bytes;
    const k = objectKey(key, cs, 0, aes);
    let cipherBytes: Buffer;
    if (aes) {
      const iv = md5(Buffer.from(`iv-${cs}`, 'latin1'));
      const c = createCipheriv('aes-128-cbc', k, iv);
      cipherBytes = Buffer.concat([iv, c.update(encoded), c.final()]);
    } else cipherBytes = rc4(k, encoded);
    f.stream(cs, Buffer.alloc(0), { raw: cipherBytes, filter: '/FlateDecode' });
  }
  f.obj(
    pagesNode,
    `<< /Type /Pages /Kids [${pageNums.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageNums.length} /MediaBox [0 0 612 792] >>`,
  );
  f.obj(catalog, `<< /Type /Catalog /Pages ${pagesNode} 0 R >>`);
  const hex = (b: Buffer): string => `<${b.toString('hex')}>`;
  f.obj(
    encObj,
    `<< /Filter /Standard /V ${v} /R ${r} /Length ${n * 8} /O ${hex(o)} /U ${hex(u)} /P ${PERMISSIONS}` +
      `${aes ? ' /CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >> /StmF /StdCF /StrF /StdCF' : ''} >>`,
  );
  return f.build(catalog, { trailerExtra: `/Encrypt ${encObj} 0 R /ID [${hex(ID0)} ${hex(ID0)}] ` });
}
