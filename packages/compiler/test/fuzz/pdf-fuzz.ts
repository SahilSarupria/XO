import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NodePdfLoader } from '../../src/pdf/pdf-loader.js';
import { decodeStream } from '../../src/pdf/filters.js';
import { extractTextRuns } from '../../src/pdf/content-stream.js';
import { buildCases } from '../taxonomy/cases.js';

/** Small deterministic PRNG (mulberry32): the same seed always produces the same mutations. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NASTY_NUMBERS = ['0', '-1', '99999999999', '2147483648', '4294967296', '1e9', '-0', '65535', '0.0000001'];
const KEYWORDS = [
  'obj',
  'endobj',
  'stream',
  'endstream',
  'xref',
  'trailer',
  'startxref',
  '/Kids',
  '/Count',
  '/Length',
  '/Filter',
  '/FlateDecode',
  '/Parent',
  '/Contents',
  '/Type',
  '/Root',
  '/Encrypt',
  '/W',
  '/Index',
  '/N',
  '/First',
  '/Prev',
];

/** One structure-aware mutation of a PDF byte buffer. */
export function mutate(input: Uint8Array, rand: () => number): Buffer {
  const b = Buffer.from(input);
  const pick = (n: number): number => Math.floor(rand() * n);
  const kind = pick(12);
  switch (kind) {
    case 0: // flip a few bytes
      for (let i = 0, n = 1 + pick(8); i < n && b.length > 0; i++) b[pick(b.length)] = pick(256);
      return b;
    case 1: // truncate
      return b.subarray(0, pick(b.length + 1));
    case 2: {
      // delete a chunk
      const s = pick(b.length + 1);
      return Buffer.concat([b.subarray(0, s), b.subarray(Math.min(b.length, s + pick(400)))]);
    }
    case 3: {
      // duplicate a chunk
      const s = pick(b.length + 1);
      const e = Math.min(b.length, s + pick(600));
      return Buffer.concat([b.subarray(0, e), b.subarray(s, e), b.subarray(e)]);
    }
    case 4: {
      // replace a number token with a hostile one
      const text = b.toString('latin1');
      const matches = [...text.matchAll(/\b\d+\b/g)];
      if (matches.length === 0) return b;
      const m = matches[pick(matches.length)]!;
      return Buffer.from(text.slice(0, m.index) + NASTY_NUMBERS[pick(NASTY_NUMBERS.length)] + text.slice(m.index! + m[0].length), 'latin1');
    }
    case 5: {
      // replace a keyword/name with another
      const text = b.toString('latin1');
      const from = KEYWORDS[pick(KEYWORDS.length)]!;
      const idx = text.indexOf(from, pick(Math.max(1, text.length)));
      const at = idx >= 0 ? idx : text.indexOf(from);
      if (at < 0) return b;
      return Buffer.from(text.slice(0, at) + KEYWORDS[pick(KEYWORDS.length)] + text.slice(at + from.length), 'latin1');
    }
    case 6: {
      // insert deep nesting or a huge array at a random spot
      const s = pick(b.length + 1);
      const ins = pick(2) === 0 ? '['.repeat(1 + pick(5000)) : '<< /A '.repeat(1 + pick(3000));
      return Buffer.concat([b.subarray(0, s), Buffer.from(ins, 'latin1'), b.subarray(s)]);
    }
    case 7: {
      // swap two chunks
      const s1 = pick(b.length + 1);
      const s2 = pick(b.length + 1);
      const [lo, hi] = s1 < s2 ? [s1, s2] : [s2, s1];
      const len = Math.min(pick(200), hi - lo);
      return Buffer.concat([
        b.subarray(0, lo),
        b.subarray(hi, hi + len),
        b.subarray(lo + len, hi),
        b.subarray(lo, lo + len),
        b.subarray(hi + len),
      ]);
    }
    case 9: {
      // hostile nesting directly after a dictionary key (inside parsed structure, not a stream body)
      const text = b.toString('latin1');
      const keys = [...text.matchAll(/\/[A-Za-z]+ /g)];
      if (keys.length === 0) return b;
      const m = keys[pick(keys.length)]!;
      const at = m.index! + m[0].length;
      const depth = 1 + pick(20000);
      const ins = pick(2) === 0 ? '['.repeat(depth) + ']'.repeat(depth) : '<< /K '.repeat(depth) + '>>'.repeat(depth);
      return Buffer.from(text.slice(0, at) + ins + ' ' + text.slice(at), 'latin1');
    }
    case 10: {
      // rewire an indirect reference to another object (cycles, self references, long chains)
      const text = b.toString('latin1');
      const refs = [...text.matchAll(/\b(\d+) 0 R\b/g)];
      if (refs.length === 0) return b;
      const m = refs[pick(refs.length)]!;
      const nums = [...text.matchAll(/\b(\d+) 0 obj\b/g)].map((x) => x[1]!);
      const to = nums.length > 0 ? nums[pick(nums.length)]! : '1';
      return Buffer.from(text.slice(0, m.index) + to + ' 0 R' + text.slice(m.index! + m[0].length), 'latin1');
    }
    case 11: {
      // make a /Kids array reference the page-tree root or itself many times
      const text = b.toString('latin1');
      const at = text.indexOf('/Kids [');
      if (at < 0) return b;
      const ref = `${1 + pick(8)} 0 R `;
      return Buffer.from(text.slice(0, at + 7) + ref.repeat(1 + pick(2000)) + text.slice(at + 7), 'latin1');
    }
    default: {
      // corrupt inside a stream body (after a 'stream' keyword)
      const text = b.toString('latin1');
      const at = text.indexOf('stream\n', pick(Math.max(1, text.length)));
      if (at < 0) return b;
      const p = at + 7 + pick(64);
      if (p < b.length) b[p] = pick(256);
      return b;
    }
  }
}

export function seedCorpus(): { name: string; bytes: Uint8Array }[] {
  const wanted = new Set([
    'control-text-3p',
    'table-wrapped',
    'script-cyrillic-tounicode',
    'form-acroform-text-fields',
    'enc-owner-only-aes-128',
    'enc-owner-only-rc4-128',
    'font-ligatures',
    'layout-2-column',
    'corrupt-no-xref',
    'inert-embedded-file',
  ]);
  const out = buildCases()
    .filter((c) => wanted.has(c.id))
    .map((c) => ({ name: c.id, bytes: c.build() }));
  const read = (rel: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(rel, import.meta.url))));
  out.push({ name: 'qpdf-objstm-xrefstream', bytes: read('../fixtures/objstm-xrefstream.pdf') });
  out.push({ name: 'qpdf-aes256-r6', bytes: read('../fixtures/encrypted/q-owner-aes-256-r6.pdf') });
  out.push({ name: 'scanned-and-mixed', bytes: read('../fixtures/scanned-and-mixed.pdf') });
  return out;
}

export interface FuzzFailure {
  readonly seed: number;
  readonly iteration: number;
  readonly corpus: string;
  readonly problem: string;
}

/** Runs `iterations` mutations; returns every property violation (throw, slow, nondeterministic). */
export function fuzzLoader(seed: number, iterations: number, maxMsPerInput = 5000): FuzzFailure[] {
  const rand = rng(seed);
  const corpus = seedCorpus();
  const loader = new NodePdfLoader();
  const failures: FuzzFailure[] = [];
  const summary = (r: ReturnType<NodePdfLoader['load']>): string =>
    r.ok
      ? JSON.stringify([r.value.pageCount, r.value.pages.map((p) => [p.plainText.length, p.requiresOcr, p.loadFailure?.code ?? ''])])
      : `ERR:${String(r.error.code)}`;
  for (let it = 0; it < iterations; it++) {
    const seedDoc = corpus[Math.floor(rand() * corpus.length)]!;
    let bytes: Buffer = Buffer.from(seedDoc.bytes);
    for (let m = 0, n = 1 + Math.floor(rand() * 3); m < n; m++) bytes = mutate(bytes, rand);
    const t0 = Date.now();
    try {
      const a = loader.load(bytes, 'fuzz.pdf');
      const ms = Date.now() - t0;
      if (ms > maxMsPerInput) failures.push({ seed, iteration: it, corpus: seedDoc.name, problem: `took ${ms} ms` });
      if (summary(a) !== summary(loader.load(bytes, 'fuzz.pdf')))
        failures.push({ seed, iteration: it, corpus: seedDoc.name, problem: 'nondeterministic result for identical bytes' });
    } catch (e) {
      failures.push({
        seed,
        iteration: it,
        corpus: seedDoc.name,
        problem: `threw ${(e as Error).constructor.name}: ${(e as Error).message.slice(0, 120)}`,
      });
    }
  }
  return failures;
}

/** Random bytes through every filter and the content-stream parser: they may reject, never hang or crash. */
export function fuzzParsers(seed: number, iterations: number): FuzzFailure[] {
  const rand = rng(seed);
  const failures: FuzzFailure[] = [];
  const filters = ['FlateDecode', 'ASCII85Decode', 'ASCIIHexDecode', 'RunLengthDecode', 'LZWDecode', 'Crypt'];
  for (let it = 0; it < iterations; it++) {
    const len = Math.floor(rand() * 2000);
    const data = Buffer.alloc(len);
    for (let i = 0; i < len; i++) data[i] = Math.floor(rand() * 256);
    const f = filters[Math.floor(rand() * filters.length)]!;
    const t0 = Date.now();
    try {
      try {
        decodeStream({
          kind: 'stream',
          dictionary: { kind: 'dictionary', entries: new Map([['Filter', { kind: 'name', name: f }]]) },
          rawBytes: data,
        });
      } catch (e) {
        if ((e as { name?: string }).name === 'RangeError') throw e;
      }
      try {
        extractTextRuns(data);
      } catch (e) {
        if ((e as { name?: string }).name === 'RangeError') throw e;
      }
      if (Date.now() - t0 > 3000) failures.push({ seed, iteration: it, corpus: f, problem: 'slow' });
    } catch (e) {
      failures.push({
        seed,
        iteration: it,
        corpus: f,
        problem: `unexpected ${(e as Error).constructor.name}: ${(e as Error).message.slice(0, 100)}`,
      });
    }
  }
  return failures;
}
