import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

/**
 * Deterministic raw-PDF writer used by the failure-taxonomy generators and the hardening tests. Unlike `buildTestPdf`
 * it lets a case control every structural detail (xref style, stream filters, trailer entries, raw object bodies), which
 * is what hostile and degenerate documents need. No clock, no randomness: the same call always yields the same bytes.
 */
export type StreamEncoding = 'flate' | 'none' | 'ascii85' | 'runlength' | { readonly raw: Buffer; readonly filter: string };

export interface ForgeObject {
  readonly num: number;
  /** Dictionary body without the surrounding `<< >>` when `stream` is set; the full object body otherwise. */
  readonly body: string;
  readonly stream?: Buffer;
}

export function encodeStream(data: Buffer, enc: StreamEncoding): { bytes: Buffer; filter?: string } {
  if (typeof enc === 'object') return { bytes: enc.raw, filter: enc.filter };
  switch (enc) {
    case 'flate':
      return { bytes: deflateSync(data, { level: 9 }), filter: '/FlateDecode' };
    case 'none':
      return { bytes: data };
    case 'runlength': {
      const out: number[] = [];
      for (let i = 0; i < data.length; i += 128) {
        const chunk = data.subarray(i, Math.min(data.length, i + 128));
        out.push(chunk.length - 1, ...chunk);
      }
      out.push(128);
      return { bytes: Buffer.from(out), filter: '/RunLengthDecode' };
    }
    case 'ascii85': {
      let s = '';
      for (let i = 0; i < data.length; i += 4) {
        const n = Math.min(4, data.length - i);
        let v = 0;
        for (let k = 0; k < 4; k++) v = v * 256 + (k < n ? data[i + k]! : 0);
        if (n === 4 && v === 0) {
          s += 'z';
          continue;
        }
        const d: number[] = [];
        for (let k = 0; k < 5; k++) {
          d.unshift((v % 85) + 33);
          v = Math.floor(v / 85);
        }
        s += String.fromCharCode(...d.slice(0, n + 1));
      }
      return { bytes: Buffer.from(s + '~>', 'latin1'), filter: '/ASCII85Decode' };
    }
  }
}

export interface BuildOptions {
  /** `classic` writes a normal xref table; `none` omits xref/trailer entirely (forces the rebuild scan); `badOffsets` writes wrong offsets. */
  readonly xref?: 'classic' | 'none' | 'badOffsets';
  readonly trailerExtra?: string;
  readonly truncateAt?: number;
  readonly header?: string;
}

export class PdfForge {
  private readonly objects: ForgeObject[] = [];
  private next = 1;
  alloc(): number {
    return this.next++;
  }
  /** Adds a whole object (dictionary/array/primitive). */
  obj(num: number, body: string): number {
    this.objects.push({ num, body });
    return num;
  }
  /** Adds a stream object. `dictExtra` is appended inside the stream dictionary (e.g. `/Type /XObject`). */
  stream(num: number, data: Buffer | string, enc: StreamEncoding = 'flate', dictExtra = ''): number {
    const buf = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
    const { bytes, filter } = encodeStream(buf, enc);
    this.objects.push({ num, body: `${filter ? `/Filter ${filter} ` : ''}${dictExtra}`, stream: bytes });
    return num;
  }
  build(rootNum: number, options: BuildOptions = {}): Buffer {
    const parts: Buffer[] = [];
    let len = 0;
    const push = (b: Buffer | string): void => {
      const x = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
      parts.push(x);
      len += x.length;
    };
    push((options.header ?? '%PDF-1.7') + '\n%\xE2\xE3\xCF\xD3\n');
    const offsets = new Map<number, number>();
    for (const o of this.objects) {
      offsets.set(o.num, len);
      if (o.stream !== undefined) {
        push(`${o.num} 0 obj\n<< ${o.body}/Length ${o.stream.length} >>\nstream\n`);
        push(o.stream);
        push('\nendstream\nendobj\n');
      } else push(`${o.num} 0 obj\n${o.body}\nendobj\n`);
    }
    const size = Math.max(...this.objects.map((o) => o.num), 0) + 1;
    if (options.xref !== 'none') {
      const xrefAt = len;
      let t = `xref\n0 ${size}\n0000000000 65535 f \n`;
      for (let i = 1; i < size; i++) {
        const off = offsets.get(i);
        const shown = options.xref === 'badOffsets' && off !== undefined ? off + 7 : off;
        t += shown === undefined ? '0000000000 65535 f \n' : `${String(shown).padStart(10, '0')} 00000 n \n`;
      }
      t += `trailer\n<< /Size ${size} /Root ${rootNum} 0 R ${options.trailerExtra ?? ''}>>\nstartxref\n${xrefAt}\n%%EOF\n`;
      push(t);
    }
    const all = Buffer.concat(parts);
    return options.truncateAt !== undefined ? all.subarray(0, options.truncateAt) : all;
  }
}

export const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** Escapes a JS string for a PDF literal string `( ... )`. */
export function pdfLiteral(text: string): string {
  return '(' + text.replace(/[\\()]/g, (c) => `\\${c}`) + ')';
}
