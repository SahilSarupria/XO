import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { ErrorCode, PdfError } from '@xo/errors';
import { isArray, isDictionary, isName, isPdfString, isStream, type PdfDictionary, type PdfValue } from './types.js';

/**
 * Standard security handler decryption (ISO 32000-1 §7.6, ISO 32000-2 §7.6): RC4 40/128-bit, AES-128 (V4, AESV2) and
 * AES-256 (V5, R5/R6, AESV3). Only the EMPTY user password is tried: this opens the common "owner password set to
 * restrict printing/copying" documents, and refuses (PDF_ENCRYPTED) anything that genuinely needs a password. No password
 * is ever guessed beyond the empty one, and nothing here touches the network.
 */
export interface Decryptor {
  decryptString(bytes: Uint8Array, objectNumber: number, generation: number): Uint8Array;
  decryptStream(bytes: Uint8Array, objectNumber: number, generation: number, streamDict: PdfDictionary): Uint8Array;
  /** Object number of the /Encrypt dictionary, which is never itself encrypted. */
  readonly encryptObjectNumber: number | undefined;
}

const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');
const md5 = (...p: Uint8Array[]): Buffer => createHash('md5').update(Buffer.concat(p)).digest();

export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 255;
    const t = s[i]!;
    s[i] = s[j]!;
    s[j] = t;
  }
  const out = new Uint8Array(data.length);
  let a = 0;
  let b = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 255;
    b = (b + s[a]!) & 255;
    const t = s[a]!;
    s[a] = s[b]!;
    s[b] = t;
    out[k] = data[k]! ^ s[(s[a]! + s[b]!) & 255]!;
  }
  return out;
}

function aesCbcDecrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  // First 16 bytes are the IV. Anything not a whole number of blocks after it is damaged: return nothing rather than guess.
  if (data.length < 32 || (data.length - 16) % 16 !== 0) return new Uint8Array(0);
  const d = createDecipheriv(key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc', key, data.subarray(0, 16));
  d.setAutoPadding(false);
  const out = Buffer.concat([d.update(data.subarray(16)), d.final()]);
  const pad = out[out.length - 1]!;
  return pad >= 1 && pad <= 16 && pad <= out.length ? out.subarray(0, out.length - pad) : out;
}

const padPassword = (pw: string): Buffer => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);
const xorKey = (key: Uint8Array, i: number): Uint8Array => Uint8Array.from(key, (b) => b ^ i);

function num(d: PdfDictionary, k: string, fallback: number): number {
  const v = d.entries.get(k);
  return typeof v === 'number' ? v : fallback;
}
function bytesOf(d: PdfDictionary, k: string): Uint8Array | undefined {
  const v = d.entries.get(k);
  return v !== undefined && isPdfString(v) ? v.bytes : undefined;
}
function nameOf(d: PdfDictionary, k: string): string | undefined {
  const v = d.entries.get(k);
  return v !== undefined && isName(v) ? v.name : undefined;
}

type Method = 'none' | 'rc4' | 'aesv2' | 'aesv3';

function methodFor(encrypt: PdfDictionary, filterName: string | undefined, v: number, resolve: (x: PdfValue) => PdfValue): Method {
  if (v < 4) return 'rc4';
  if (filterName === undefined || filterName === 'Identity') return 'none';
  const cfRaw = encrypt.entries.get('CF');
  const cf = cfRaw !== undefined ? resolve(cfRaw) : undefined;
  if (cf === undefined || !isDictionary(cf)) return 'none';
  const fRaw = cf.entries.get(filterName);
  const f = fRaw !== undefined ? resolve(fRaw) : undefined;
  if (f === undefined || !isDictionary(f)) return 'none';
  switch (nameOf(f, 'CFM')) {
    case 'V2':
      return 'rc4';
    case 'AESV2':
      return 'aesv2';
    case 'AESV3':
      return 'aesv3';
    default:
      return 'none';
  }
}

/** ISO 32000-2 algorithm 2.B (hash for revision 6). */
function hashR6(password: Buffer, salt: Buffer, udata: Buffer): Buffer {
  let k = createHash('sha256')
    .update(Buffer.concat([password, salt, udata]))
    .digest();
  for (let i = 0; ;) {
    const k1 = Buffer.concat(Array.from({ length: 64 }, () => Buffer.concat([password, k, udata])));
    const c = createCipheriv('aes-128-cbc', k.subarray(0, 16), k.subarray(16, 32));
    c.setAutoPadding(false);
    const e = Buffer.concat([c.update(k1), c.final()]);
    let mod = 0;
    for (let j = 0; j < 16; j++) mod += e[j]!;
    k = createHash(['sha256', 'sha384', 'sha512'][mod % 3]!)
      .update(e)
      .digest();
    i += 1;
    if (i >= 64 && e[e.length - 1]! <= i - 32) break;
  }
  return k.subarray(0, 32);
}

/**
 * Builds a decryptor for the document, or throws `PdfError(PDF_ENCRYPTED)` if it needs a password or uses an
 * unsupported handler. `resolve` follows references (the /Encrypt dictionary may be indirect).
 */
export function createDecryptor(
  encryptValue: PdfValue,
  encryptObjectNumber: number | undefined,
  id0: Uint8Array,
  resolve: (v: PdfValue) => PdfValue,
): Decryptor {
  const enc = resolve(encryptValue);
  if (!isDictionary(enc)) throw new PdfError(ErrorCode.PDF_ENCRYPTED, 'Unreadable /Encrypt dictionary');
  if (nameOf(enc, 'Filter') !== 'Standard')
    throw new PdfError(ErrorCode.PDF_ENCRYPTED, `Unsupported security handler "${nameOf(enc, 'Filter') ?? 'unknown'}"`);
  const v = num(enc, 'V', 0);
  const r = num(enc, 'R', 2);
  const o = bytesOf(enc, 'O');
  const u = bytesOf(enc, 'U');
  if (o === undefined || u === undefined) throw new PdfError(ErrorCode.PDF_ENCRYPTED, 'Encryption dictionary lacks /O or /U');
  const needsPassword = (): PdfError =>
    new PdfError(ErrorCode.PDF_ENCRYPTED, 'This PDF requires a password to open; only documents with an empty user password can be read');

  let fileKey: Buffer;
  if (r >= 5) {
    if (u.length < 48) throw new PdfError(ErrorCode.PDF_ENCRYPTED, 'Malformed /U for AES-256');
    const ue = bytesOf(enc, 'UE');
    if (ue === undefined || ue.length < 32) throw new PdfError(ErrorCode.PDF_ENCRYPTED, 'Missing /UE for AES-256');
    const pw = Buffer.alloc(0);
    const valSalt = Buffer.from(u.subarray(32, 40));
    const keySalt = Buffer.from(u.subarray(40, 48));
    const hash = (salt: Buffer): Buffer =>
      r === 5
        ? createHash('sha256')
            .update(Buffer.concat([pw, salt]))
            .digest()
        : hashR6(pw, salt, Buffer.alloc(0));
    if (!hash(valSalt).equals(Buffer.from(u.subarray(0, 32)))) throw needsPassword();
    const d = createDecipheriv('aes-256-cbc', hash(keySalt), Buffer.alloc(16));
    d.setAutoPadding(false);
    fileKey = Buffer.concat([d.update(ue.subarray(0, 32)), d.final()]);
  } else {
    const keyLen = v === 1 ? 5 : Math.max(5, Math.min(16, Math.floor(num(enc, 'Length', 40) / 8)));
    const p = num(enc, 'P', 0);
    const pBytes = Buffer.alloc(4);
    pBytes.writeInt32LE(p | 0);
    const parts: Uint8Array[] = [padPassword(''), o.subarray(0, 32), pBytes, id0];
    if (r >= 4 && enc.entries.get('EncryptMetadata') === false) parts.push(Buffer.from([255, 255, 255, 255]));
    let h = md5(...parts);
    if (r >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, keyLen));
    fileKey = Buffer.from(h.subarray(0, keyLen));
    // Authenticate: recompute /U from the key and compare (first 16 bytes from R3 on).
    let expected: Uint8Array;
    if (r === 2) expected = rc4(fileKey, PAD);
    else {
      let x = rc4(fileKey, md5(PAD, id0));
      for (let i = 1; i <= 19; i++) x = rc4(xorKey(fileKey, i), x);
      expected = x;
    }
    const n = r === 2 ? 32 : 16;
    if (!Buffer.from(expected.subarray(0, n)).equals(Buffer.from(u.subarray(0, n)))) throw needsPassword();
  }

  const stmMethod = methodFor(enc, nameOf(enc, 'StmF'), v, resolve);
  const strMethod = methodFor(enc, nameOf(enc, 'StrF'), v, resolve);
  const encryptMetadata = enc.entries.get('EncryptMetadata') !== false;

  const objKey = (objNum: number, gen: number, aes: boolean): Buffer => {
    const ext = Buffer.from([objNum & 255, (objNum >> 8) & 255, (objNum >> 16) & 255, gen & 255, (gen >> 8) & 255]);
    return md5(fileKey, ext, ...(aes ? [Buffer.from('sAlT', 'latin1')] : [])).subarray(0, Math.min(fileKey.length + 5, 16));
  };
  const apply = (method: Method, data: Uint8Array, objNum: number, gen: number): Uint8Array => {
    switch (method) {
      case 'none':
        return data;
      case 'rc4':
        return rc4(objKey(objNum, gen, false), data);
      case 'aesv2':
        return aesCbcDecrypt(objKey(objNum, gen, true), data);
      case 'aesv3':
        return aesCbcDecrypt(fileKey, data);
    }
  };

  return {
    encryptObjectNumber,
    decryptString: (bytes, objNum, gen) => apply(strMethod, bytes, objNum, gen),
    decryptStream: (bytes, objNum, gen, dict) => {
      const type = nameOf(dict, 'Type');
      if (type === 'XRef') return bytes;
      if (type === 'Metadata' && !encryptMetadata) return bytes;
      // A stream that names the Identity crypt filter is stored in the clear.
      const filter = dict.entries.get('Filter');
      const hasCrypt =
        filter !== undefined &&
        (isName(filter) ? filter.name === 'Crypt' : isArray(filter) && filter.items.some((f) => isName(f) && f.name === 'Crypt'));
      if (hasCrypt) {
        const parms = dict.entries.get('DecodeParms');
        const first =
          parms !== undefined && isDictionary(parms)
            ? parms
            : parms !== undefined && isArray(parms)
              ? parms.items.find(isDictionary)
              : undefined;
        const nm = first !== undefined && isDictionary(first) ? nameOf(first, 'Name') : undefined;
        if (nm === undefined || nm === 'Identity') return bytes;
      }
      return apply(stmMethod, bytes, objNum, gen);
    },
  };
}

/** Rebuilds a parsed value with every string (and stream body) decrypted. Pure: the input is never mutated. */
export function decryptValue(value: PdfValue, objNum: number, gen: number, dec: Decryptor, depth = 0): PdfValue {
  if (depth > 64 || value === null || typeof value !== 'object') return value;
  if (isPdfString(value)) return { kind: 'string', bytes: dec.decryptString(value.bytes, objNum, gen) };
  if (isArray(value)) return { kind: 'array', items: value.items.map((x) => decryptValue(x, objNum, gen, dec, depth + 1)) };
  if (isStream(value)) {
    const dictionary = decryptValue(value.dictionary, objNum, gen, dec, depth + 1) as PdfDictionary;
    return { kind: 'stream', dictionary, rawBytes: dec.decryptStream(value.rawBytes, objNum, gen, value.dictionary) };
  }
  if (isDictionary(value)) {
    const entries = new Map<string, PdfValue>();
    for (const [k, x] of value.entries) entries.set(k, decryptValue(x, objNum, gen, dec, depth + 1));
    return { kind: 'dictionary', entries };
  }
  return value;
}
