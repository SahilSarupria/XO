/**
 * UW-14c/14e — finding protected values in text, and in a whole model request.
 *
 * Detectors, in the order of the plan's priority:
 *   1. the KNOWN-VALUE DICTIONARY: values the customer already supplied (names, emails, ids in their workbooks, values they listed).
 *      Exact match on normalised words; names also match as `initial surname`, `surname first`, and with one edit per long word
 *      (misspellings, transliterations); identifiers, emails and phone numbers match with any separators. The most reliable detector;
 *      the leak guard blocks on any hit.
 *   2. PATTERN PACKS with checksums (Aadhaar, PAN, GSTIN, …).
 * Encodings people (and prompt injections) use to slip a value past a filter are opened before matching: base64 and base64url runs,
 * percent-encoding; Unicode look-alikes and zero-width characters are normalised away (see normalize.ts).
 *
 * A hit names the detector, the entity and a HASH of the value (never the value), plus its range in the scanned text for masking.
 */
import { createHash } from 'node:crypto';
import { compact, editDistanceAtMost, normalizeForMatch, originalRange, phoneticKey, tokens, type NormalizedText } from './normalize.js';
import { BUILTIN_PACKS, compilePack, validate, type CompiledRecognizer, type PatternPack } from './patterns.js';

/** Only shape symbols: every letter an A, every digit a 9 (matched on normalised, lowercased text). */
const SHAPE_NOTATION = /^[^\p{L}\p{N}]*(?:[a9][^\p{L}\p{N}]*)+$/u;

export type KnownValueKind = 'name' | 'organization' | 'email' | 'phone' | 'identifier' | 'address' | 'other';

export interface KnownValue {
  readonly value: string;
  readonly kind: KnownValueKind;
  /** Placeholder prefix for this value: `CLIENT`, `PERSON`, `EMAIL`… (default derived from the kind). */
  readonly entity?: string;
}

export interface ProtectionHit {
  readonly detector: string;
  readonly entity: string;
  /** `sha256:` (first 16 hex) of the normalised matched value: correlate without revealing. */
  readonly hash: string;
  /** Range in the scanned string (only for hits found in the text itself, not inside a decoded run). */
  readonly start: number;
  readonly end: number;
  /** Set when the value was found after decoding base64 or percent-encoding. */
  readonly encoded?: 'base64' | 'percent';
}

const ENTITY_OF: Readonly<Record<KnownValueKind, string>> = {
  name: 'PERSON',
  organization: 'ORG',
  email: 'EMAIL',
  phone: 'PHONE',
  identifier: 'ID',
  address: 'ADDRESS',
  other: 'VALUE',
};

/** Every entity name the built-in detectors and the dictionary use (a placeholder of one of these is a placeholder). */
export const PROTECTED_ENTITIES: ReadonlySet<string> = new Set([
  ...Object.values(ENTITY_OF),
  ...BUILTIN_PACKS.flatMap((p) => p.recognizers.map((r) => r.entity)),
]);

export const hashOf = (normalized: string): string => `sha256:${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;

interface WordEntry {
  readonly words: readonly string[];
  readonly entity: string;
  readonly fuzzy: boolean;
  readonly hash: string;
}

/** Words too common to protect on their own, even when they are a cell value. */
const STOP = new Set([
  'the',
  'and',
  'of',
  'mr',
  'mrs',
  'ms',
  'dr',
  'shri',
  'smt',
  'kumari',
  'ltd',
  'pvt',
  'private',
  'limited',
  'co',
  'inc',
  'llp',
]);

export class KnownValueDictionary {
  private readonly byFirst = new Map<string, WordEntry[]>();
  /** First words of 5+ letters by length, for one-edit lookups (a word one edit away is at most one letter longer or shorter). */
  private readonly byLength = new Map<number, Set<string>>();
  /** First words of names and organisations by spelling key (Laxmi finds Lakshmi). */
  private readonly byPhonetic = new Map<string, string[]>();
  /** Multi-word names written as one word (`ravikumar_policy.pdf`, `KumarRavi`): matched against whole tokens only. */
  private readonly joined = new Map<string, WordEntry>();
  private readonly compactValues: { readonly compact: string; readonly entity: string; readonly digits: boolean; readonly hash: string }[] =
    [];
  private count = 0;

  get size(): number {
    return this.count;
  }

  add(v: KnownValue): void {
    const raw = v.value.trim();
    if (raw === '' || raw.length > 200) return;
    const entity = v.entity ?? ENTITY_OF[v.kind];
    const n = normalizeForMatch(raw);
    const hash = hashOf(n.text.replace(/\s+/g, ' ').trim());
    if (v.kind === 'email' || v.kind === 'phone' || v.kind === 'identifier') {
      const c = compact(n).text;
      const digits = /^\d+$/.test(c);
      // Short identifiers collide with ordinary numbers and words: at least 6 characters (5 digits for a phone extension is too few).
      if (c.length < 6) return;
      this.compactValues.push({ compact: c, entity, digits, hash });
      // A phone number is written with or without its country code: +91 98200 12345 is also 9820012345.
      if (v.kind === 'phone' && digits && c.length > 10 && /^(?:0091|91|0)/.test(c))
        this.compactValues.push({ compact: c.slice(-10), entity, digits, hash });
      this.count++;
      return;
    }
    const words = tokens(n, raw)
      .map((t) => t.text)
      .filter((w) => !STOP.has(w));
    if (words.length === 0) return;
    // A single short word ("Ram", "Sun") is too common to block on: protect it as part of longer forms only.
    if (words.length === 1 && words[0]!.length < 4) return;
    const variants: string[][] = [words];
    if (v.kind === 'name' && words.length >= 2) {
      const last = words[words.length - 1]!;
      variants.push([words[0]![0]!, last]); // R Kumar
      variants.push([last, words[0]!]); // Kumar Ravi
      variants.push([last, words[0]![0]!]); // Kumar R
    }
    if ((v.kind === 'name' || v.kind === 'organization') && words.length >= 2)
      for (const w of [words, [words[words.length - 1]!, ...words.slice(0, -1)]]) {
        const j = w.join('');
        if (j.length >= 8) this.joined.set(j, { words: [j], entity, fuzzy: false, hash });
      }
    for (const w of variants) {
      const e: WordEntry = { words: w, entity, fuzzy: v.kind === 'name' || v.kind === 'organization', hash };
      const list = this.byFirst.get(w[0]!) ?? [];
      list.push(e);
      this.byFirst.set(w[0]!, list);
      if (e.fuzzy && w[0]!.length >= 4) {
        const k = phoneticKey(w[0]!);
        const firsts = this.byPhonetic.get(k) ?? [];
        if (!firsts.includes(w[0]!)) firsts.push(w[0]!);
        this.byPhonetic.set(k, firsts);
      }
      if (w[0]!.length >= 5) {
        const b = this.byLength.get(w[0]!.length) ?? new Set<string>();
        b.add(w[0]!);
        this.byLength.set(w[0]!.length, b);
      }
    }
    this.count++;
  }

  /** First words one edit away from `t`. */
  private near(t: string): string[] {
    const out: string[] = [];
    for (const len of [t.length - 1, t.length, t.length + 1])
      for (const f of this.byLength.get(len) ?? []) if (f !== t && editDistanceAtMost(t, f, 1)) out.push(f);
    return out;
  }

  scan(n: NormalizedText, original: string): { start: number; end: number; entity: string; hash: string; detector: string }[] {
    const out: { start: number; end: number; entity: string; hash: string; detector: string }[] = [];
    const toks = tokens(n, original);
    const wordMatch = (have: string, want: string, fuzzy: boolean): boolean =>
      have === want ||
      (fuzzy &&
        ((want.length >= 5 && have.length >= 5 && editDistanceAtMost(have, want, 1)) ||
          (want.length >= 4 && have.length >= 4 && phoneticKey(have) === phoneticKey(want))));
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!.text;
      const candidates = [...(this.byFirst.get(t) ?? [])];
      const j = this.joined.get(t);
      if (j !== undefined) candidates.push(j);
      if (t.length >= 5) for (const f of this.near(t)) for (const e of this.byFirst.get(f)!) if (e.fuzzy) candidates.push(e);
      if (t.length >= 4)
        for (const f of this.byPhonetic.get(phoneticKey(t)) ?? [])
          if (f !== t) for (const e of this.byFirst.get(f)!) if (e.fuzzy && !candidates.includes(e)) candidates.push(e);
      for (const e of candidates) {
        if (i + e.words.length > toks.length) continue;
        let ok = true;
        for (let k = 0; k < e.words.length && ok; k++) ok = wordMatch(toks[i + k]!.text, e.words[k]!, e.fuzzy);
        // Initial forms ("r kumar") match only a lone letter: tokens are whole words.
        if (ok)
          out.push({
            start: toks[i]!.start,
            end: toks[i + e.words.length - 1]!.end,
            entity: e.entity,
            hash: e.hash,
            detector: 'dictionary',
          });
      }
    }
    if (this.compactValues.length > 0) {
      const c = compact(n);
      for (const v of this.compactValues) {
        let from = 0;
        for (;;) {
          const at = c.text.indexOf(v.compact, from);
          if (at === -1) break;
          from = at + 1;
          // A numeric id inside a longer run of digits is a different number.
          if (v.digits && (/\d/.test(c.text[at - 1] ?? '') || /\d/.test(c.text[at + v.compact.length] ?? ''))) continue;
          out.push({ start: c.at[at]!, end: c.at[at + v.compact.length - 1]! + 1, entity: v.entity, hash: v.hash, detector: 'dictionary' });
        }
      }
    }
    return out;
  }
}

export interface ScannerOptions {
  readonly dictionary?: KnownValueDictionary;
  /** Default: every built-in pack. */
  readonly packs?: readonly PatternPack[];
}

const B64_RUN = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
const PCT_RUN = /(?:%[0-9A-Fa-f]{2})+/g;

function decodeBase64(run: string): string | undefined {
  try {
    const buf = Buffer.from(run.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const text = buf.toString('utf8');
    // Only text: a run that decodes to binary is not a disguised value.
    if (text.length < 4 || /[\u0000-\u0008\u000e-\u001f�]/.test(text)) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

export class ProtectionScanner {
  readonly dictionary: KnownValueDictionary | undefined;
  private readonly recognizers: CompiledRecognizer[];

  constructor(o: ScannerOptions = {}) {
    this.dictionary = o.dictionary;
    this.recognizers = (o.packs ?? BUILTIN_PACKS).flatMap(compilePack);
  }

  get packIds(): readonly string[] {
    return [...new Set(this.recognizers.map((r) => r.packId))];
  }

  private scanPlain(text: string): ProtectionHit[] {
    const n = normalizeForMatch(text);
    const hits: ProtectionHit[] = [];
    for (const r of this.recognizers) {
      r.re.lastIndex = 0;
      for (const m of n.text.matchAll(r.re)) {
        if (r.validator !== undefined && !validate(r.validator, m[0])) continue;
        // A schema's shape notation (`AAAAA9999A`: A = letter, 9 = digit) is a format, not a value, even when it is well-formed.
        if (SHAPE_NOTATION.test(m[0])) continue;
        if (r.context !== undefined) {
          const before = n.text.slice(Math.max(0, m.index - 40), m.index);
          if (!r.context.some((w) => before.includes(w))) continue;
        }
        const span = originalRange(n, m.index, m.index + m[0].length);
        hits.push({ detector: `${r.packId}/${r.id}`, entity: r.entity, hash: hashOf(m[0].replace(/[\s.-]/g, '')), ...span });
      }
    }
    if (this.dictionary !== undefined)
      for (const h of this.dictionary.scan(n, text)) {
        const span = originalRange(n, h.start, h.end);
        hits.push({ detector: h.detector, entity: h.entity, hash: h.hash, ...span });
      }
    return dedupe(hits);
  }

  /** Every protected value in `text`, including inside base64 and percent-encoded runs. */
  scan(text: string): ProtectionHit[] {
    const hits = this.scanPlain(text);
    for (const m of text.matchAll(B64_RUN)) {
      // `/` is in the base64 alphabet and is also a path separator (`/share/<base64url>`): try the run whole and in its segments.
      let offset = 0;
      const parts = [{ run: m[0], at: 0 }];
      if (m[0].includes('/'))
        for (const seg of m[0].split('/')) {
          if (seg.length >= 16) parts.push({ run: seg, at: offset });
          offset += seg.length + 1;
        }
      for (const p of parts) {
        const decoded = decodeBase64(p.run);
        if (decoded === undefined) continue;
        const start = m.index + p.at;
        for (const h of this.scanPlain(decoded)) hits.push({ ...h, start, end: start + p.run.length, encoded: 'base64' });
      }
    }
    for (const m of text.matchAll(PCT_RUN)) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(m[0]);
      } catch {
        continue;
      }
      for (const h of this.scanPlain(decoded)) hits.push({ ...h, start: m.index, end: m.index + m[0].length, encoded: 'percent' });
    }
    // Percent-encoding often wraps whole phrases ("Ravi%20Kumar"): scan the decoded whole string too.
    if (/%[0-9A-Fa-f]{2}/.test(text)) {
      try {
        const whole = decodeURIComponent(text);
        if (whole !== text) for (const h of this.scanPlain(whole)) hits.push({ ...h, start: 0, end: text.length, encoded: 'percent' });
      } catch {
        /* not decodable as a whole */
      }
    }
    return dedupe(hits);
  }

  /**
   * Replaces each hit with a placeholder: `[PERSON]` by default, or what `placeholder` returns (the token vault's reversible
   * tokens). Overlapping hits are merged; the longest wins.
   */
  mask(
    text: string,
    placeholder: (hit: ProtectionHit, original: string) => string = (h) => `[${h.entity}]`,
  ): { text: string; hits: ProtectionHit[] } {
    const hits = this.scan(text).sort((a, b) => a.start - b.start || b.end - a.end);
    let out = '';
    let at = 0;
    const used: ProtectionHit[] = [];
    for (const h of hits) {
      if (h.start < at) continue;
      out += text.slice(at, h.start) + placeholder(h, text.slice(h.start, h.end));
      at = h.end;
      used.push(h);
    }
    return { text: out + text.slice(at), hits: used };
  }
}

function dedupe(hits: ProtectionHit[]): ProtectionHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => {
    const k = `${h.start}:${h.end}:${h.hash}:${h.detector}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Every string in a model request (message text, response schema, anything a provider would serialise), with where it was. */
export function requestStrings(
  request: unknown,
  path = '$',
  out: { path: string; text: string }[] = [],
  seen = new Set<object>(),
): { path: string; text: string }[] {
  if (typeof request === 'string') out.push({ path, text: request });
  else if (request !== null && typeof request === 'object') {
    if (seen.has(request) || request instanceof AbortSignal) return out;
    seen.add(request);
    if (Array.isArray(request)) request.forEach((v, i) => requestStrings(v, `${path}[${i}]`, out, seen));
    else
      for (const [k, v] of Object.entries(request)) {
        // Keys are serialised too (a response schema's property names).
        out.push({ path: `${path}#key`, text: k });
        requestStrings(v, `${path}.${k}`, out, seen);
      }
  }
  return out;
}

export interface LeakVerdict {
  readonly blocked: boolean;
  readonly hits: readonly (Omit<ProtectionHit, 'start' | 'end'> & { readonly path: string })[];
}

/** UW-14e: the leak guard's check of a whole request. Any hit blocks. */
export function scanRequest(scanner: ProtectionScanner, request: unknown): LeakVerdict {
  const hits: (Omit<ProtectionHit, 'start' | 'end'> & { path: string })[] = [];
  for (const s of requestStrings(request)) {
    if (s.path === '$.model' || s.path === '$.requestId') continue; // XO's own identifiers
    for (const { start: _s, end: _e, ...h } of scanner.scan(s.text)) hits.push({ ...h, path: s.path });
  }
  return { blocked: hits.length > 0, hits };
}
