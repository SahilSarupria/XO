/**
 * UW-14c (2) — locale pattern packs. The FORMAT is generic (genericity class C): a pack is data — recognizers, each a pattern, an
 * entity, an optional named validator and optional context words. The CONTENT is locale-specific (class D). Validators are code,
 * named by the pack, so a pack cannot carry code. The `india/1` pack is the first content; `generic/1` holds what is not national
 * (email, payment cards).
 *
 * Facts used (re-checked 2026-11-16; sources in docs/RESIDENCY.md):
 *   Aadhaar  12 digits, first digit 2-9, last digit a Verhoeff check digit; often written 4-4-4 with spaces or dashes.
 *   PAN      5 letters, 4 digits, 1 letter; the 4th letter is the holder type (P, C, H, F, A, T, B, L, J, G).
 *   GSTIN    2-digit state code, the holder's PAN, an entity character (1-9, A-Z), 'Z', and a Luhn mod-36 check character.
 *   IFSC     4 letters (bank), '0', 6 letters or digits (branch).
 */

export interface Recognizer {
  readonly id: string;
  /** What it finds: `AADHAAR`, `PAN`, `EMAIL`, … (also the placeholder prefix). */
  readonly entity: string;
  /** Matched against the normalised (lower-case) text; write it in lower case. */
  readonly pattern: string;
  readonly validator?: ValidatorName;
  /**
   * Words that must appear within 40 characters before the match for it to count (for shapes that are common in ordinary text,
   * such as a 10-digit number). Absent: the shape and validator decide alone.
   */
  readonly context?: readonly string[];
}

export interface PatternPack {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly recognizers: readonly Recognizer[];
}

export type ValidatorName = 'verhoeff' | 'pan' | 'gstin' | 'ifsc' | 'luhn' | 'not_repeated' | 'mailbox';

// ---------------------------------------------------------------- validators

const VD = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VP = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function verhoeffValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  const rev = [...digits].reverse();
  for (let i = 0; i < rev.length; i++) c = VD[c]![VP[i % 8]![Number(rev[i])]!]!;
  return c === 0;
}

export function luhnValid(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
/** The GSTIN check character over its first 14 characters (Luhn mod 36: factors alternate 1, 2 from the left). */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = B36.indexOf(first14[i]!.toLowerCase());
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return B36[(36 - (sum % 36)) % 36]!;
}

const PAN_HOLDER = 'pchfatbljg';

const VALIDATORS: Readonly<Record<ValidatorName, (compactLower: string) => boolean>> = {
  verhoeff: (s) => /^[2-9]\d{11}$/.test(s) && verhoeffValid(s) && !/^(\d)\1+$/.test(s),
  pan: (s) => /^[a-z]{3}[a-z][a-z]\d{4}[a-z]$/.test(s) && PAN_HOLDER.includes(s[3]!),
  gstin: (s) => {
    if (!/^\d{2}[a-z]{5}\d{4}[a-z][1-9a-z]z[0-9a-z]$/.test(s)) return false;
    const state = Number(s.slice(0, 2));
    return state >= 1 && state <= 38 && PAN_HOLDER.includes(s[5]!) && gstinCheckChar(s.slice(0, 14)) === s[14];
  },
  ifsc: (s) => /^[a-z]{4}0[a-z0-9]{6}$/.test(s),
  luhn: (s) => luhnValid(s),
  not_repeated: (s) => !/^(.)\1+$/.test(s.replace(/\D/g, '')),
  mailbox: () => true, // handled in validate (it needs the dots)
};

/**
 * Domains that can hold no one's mailbox: the special-use and documentation names of RFC 2606 and RFC 6761 (`example.com`,
 * `.example`, `.invalid`, `.test`, `.localhost`). Synthetic addresses use them, so they are not personal data by format alone; a
 * workspace's own address at such a domain is still caught by its known-value dictionary.
 */
export function mailboxDomain(address: string): boolean {
  const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
  if (/^example\.(?:com|net|org)$/.test(domain)) return false;
  return !/(?:^|\.)(?:example|invalid|test|localhost)$/.test(domain);
}

export function validate(name: ValidatorName, matched: string): boolean {
  if (name === 'mailbox') return mailboxDomain(matched);
  return VALIDATORS[name](matched.replace(/[\s.-]/g, '').toLowerCase());
}

// ---------------------------------------------------------------- packs

const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';

export const GENERIC_PACK: PatternPack = {
  id: 'generic',
  version: '1',
  description: 'Identifiers that are not national: email addresses and payment card numbers.',
  recognizers: [
    {
      id: 'email',
      entity: 'EMAIL',
      pattern: `${B}[\\p{L}\\p{N}._%+-]+@[\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)*\\.\\p{L}{2,}${E}`,
      validator: 'mailbox',
    },
    { id: 'card', entity: 'CARD', pattern: `${B}(?:\\d[ -]?){12,18}\\d${E}`, validator: 'luhn' },
  ],
};

export const INDIA_PACK: PatternPack = {
  id: 'india',
  version: '1',
  description: 'Indian identifiers: Aadhaar, PAN, GSTIN, IFSC, mobile numbers, passports, voter ids, UPI ids.',
  recognizers: [
    { id: 'aadhaar', entity: 'AADHAAR', pattern: `${B}[2-9]\\d{3}[ -]?\\d{4}[ -]?\\d{4}${E}`, validator: 'verhoeff' },
    { id: 'pan', entity: 'PAN', pattern: `${B}[a-z]{5}\\d{4}[a-z]${E}`, validator: 'pan' },
    { id: 'gstin', entity: 'GSTIN', pattern: `${B}\\d{2}[a-z]{5}\\d{4}[a-z][1-9a-z]z[0-9a-z]${E}`, validator: 'gstin' },
    { id: 'ifsc', entity: 'IFSC', pattern: `${B}[a-z]{4}0[a-z0-9]{6}${E}`, validator: 'ifsc' },
    // +91 / 0 / none, then a 10-digit mobile number starting 6-9, with the separators people type.
    { id: 'mobile', entity: 'PHONE', pattern: `${B}(?:(?:\\+|00)?91[ -]?|0)?[6-9]\\d{4}[ -]?\\d{5}${E}`, validator: 'not_repeated' },
    { id: 'passport', entity: 'PASSPORT', pattern: `${B}[a-pr-wy][1-9]\\d ?\\d{4}[1-9]${E}`, context: ['passport'] },
    { id: 'voter', entity: 'VOTER_ID', pattern: `${B}[a-z]{3}\\d{7}${E}`, context: ['voter', 'epic', 'election'] },
    {
      id: 'upi',
      entity: 'UPI',
      pattern: `${B}[a-z0-9._-]{2,256}@(?:ok)?(?:axl|ybl|ibl|paytm|upi|apl|sbi|icici|hdfcbank|axisbank|okhdfcbank|okicici|oksbi|okaxis)${E}`,
    },
  ],
};

export const BUILTIN_PACKS: readonly PatternPack[] = [GENERIC_PACK, INDIA_PACK];

export interface CompiledRecognizer extends Recognizer {
  readonly re: RegExp;
  readonly packId: string;
}

/** Checks and compiles a pack (patterns must compile, ids be unique, validators exist). */
export function compilePack(pack: PatternPack): CompiledRecognizer[] {
  const seen = new Set<string>();
  return pack.recognizers.map((r) => {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(r.id) || seen.has(r.id))
      throw new Error(`pack ${pack.id}: recognizer id "${r.id}" is invalid or repeated`);
    seen.add(r.id);
    if (!/^[A-Z][A-Z0-9_]{1,30}$/.test(r.entity)) throw new Error(`pack ${pack.id}: entity "${r.entity}" is invalid`);
    if (r.validator !== undefined && !(r.validator in VALIDATORS)) throw new Error(`pack ${pack.id}: unknown validator "${r.validator}"`);
    return { ...r, packId: pack.id, re: new RegExp(r.pattern, 'gu') };
  });
}
