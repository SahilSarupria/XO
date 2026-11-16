import { KnownValueDictionary, ProtectionScanner } from '@xo/ai-core';
import { contentHash, type Suite, type SuiteResult } from '../src/index.js';

/**
 * UW-14c (UAC-27) — the local detectors on a labelled, synthetic Indian-PII set: a client register (the known values) and texts
 * that carry those values in the forms people and systems write them (exact, misspelt, transliterated, as initials, inside file
 * names, in look-alike letters, base64), identifiers with valid check digits, and texts that must NOT be blocked.
 *
 * Every person, number and address here is invented. Valid check digits are computed by this file's own Verhoeff and GSTIN
 * implementations (independent of @xo/ai-core's), and two published vectors anchor them.
 */

// ------------------------------------------------------------------------------------------------ independent check digits

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
const VINV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];
function verhoeffDigit(digits: string): string {
  let c = 0;
  [...digits].reverse().forEach((d, i) => (c = VD[c]![VP[(i + 1) % 8]![Number(d)]!]!));
  return String(VINV[c]);
}
const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function gstinCheck(first14: string): string {
  let sum = 0;
  [...first14].forEach((ch, i) => {
    const p = B36.indexOf(ch) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  });
  return B36[(36 - (sum % 36)) % 36]!;
}
// Anchors: python-stdnum's valid Aadhaar example and the GSTIN worked example.
if (verhoeffDigit('23412341234') !== '6' || gstinCheck('27AAPFU0939F1Z') !== 'V')
  throw new Error('the pii-detection suite’s own check-digit code disagrees with the published vectors');

const aadhaar = (first11: string) => `${first11}${verhoeffDigit(first11)}`;
const spaced = (a: string) => `${a.slice(0, 4)} ${a.slice(4, 8)} ${a.slice(8)}`;
const gstin = (first14: string) => `${first14}${gstinCheck(first14)}`;

// ------------------------------------------------------------------------------------------------ the labelled set

/** The client register the dictionary is built from (as a workspace's spreadsheet would give it). */
const REGISTER: readonly { readonly value: string; readonly kind: 'name' | 'organization' | 'email' | 'phone' | 'identifier' }[] = [
  { value: 'Lakshmi Srivastava', kind: 'name' },
  { value: 'Venkatesh Iyengar', kind: 'name' },
  { value: 'Farhan Siddiqui', kind: 'name' },
  { value: 'Gurpreet Kaur Dhillon', kind: 'name' },
  { value: 'Anirudh Chaudhary', kind: 'name' },
  { value: 'Meenakshi Sundaram', kind: 'name' },
  { value: 'Joseph Fernandes', kind: 'name' },
  { value: 'Bhavana Kulkarni', kind: 'name' },
  { value: 'Shree Balaji Textiles Pvt Ltd', kind: 'organization' },
  { value: 'Konkan Agro Exports', kind: 'organization' },
  { value: 'lakshmi.s@registermail.in', kind: 'email' },
  { value: 'farhan.siddiqui@registermail.in', kind: 'email' },
  { value: '+91 98201 44556', kind: 'phone' },
  { value: '070 2233 4455', kind: 'phone' },
  { value: 'CUST-2024-00917', kind: 'identifier' },
  { value: 'LIC/88/440213', kind: 'identifier' },
];

type Form =
  | 'exact'
  | 'case'
  | 'misspelt'
  | 'transliterated'
  | 'initials'
  | 'reordered'
  | 'file-name'
  | 'look-alike'
  | 'encoded'
  | 'identifier'
  | 'nickname'
  | 'spelt-out'
  | 'clean';
interface Case {
  readonly id: string;
  readonly text: string;
  /** The entities the text carries (empty: nothing should be found). */
  readonly expect: readonly string[];
  readonly form: Form;
  /** Exact known values: these must always be blocked (UAC-27). */
  readonly known?: true;
}
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

export const PII_CASES: readonly Case[] = [
  // Exact known values, in sentences, cells, paths and error text.
  { id: 'k1', form: 'exact', known: true, text: 'Please renew the policy for Lakshmi Srivastava.', expect: ['PERSON'] },
  { id: 'k2', form: 'exact', known: true, text: 'Venkatesh Iyengar,Bengaluru,renewal due', expect: ['PERSON'] },
  { id: 'k3', form: 'exact', known: true, text: 'Invoice raised on Shree Balaji Textiles Pvt Ltd', expect: ['ORG'] },
  { id: 'k4', form: 'exact', known: true, text: 'reply to farhan.siddiqui@registermail.in', expect: ['EMAIL', 'PERSON'] },
  { id: 'k5', form: 'exact', known: true, text: 'Customer CUST-2024-00917 has two claims', expect: ['ID'] },
  { id: 'k6', form: 'exact', known: true, text: 'Call +91 98201 44556 after 5', expect: ['PHONE'] },
  { id: 'k7', form: 'exact', known: true, text: "Error: cannot open '/srv/data/Konkan Agro Exports/ledger.xlsx'", expect: ['ORG'] },
  { id: 'k8', form: 'exact', known: true, text: 'Policy LIC/88/440213 lapsed', expect: ['ID'] },
  { id: 'k9', form: 'case', known: true, text: 'MEENAKSHI SUNDARAM — KYC pending', expect: ['PERSON'] },
  { id: 'k10', form: 'exact', known: true, text: 'landline 070 2233 4455', expect: ['PHONE'] },
  // Variants of known values.
  { id: 'v1', form: 'misspelt', text: 'Draft a letter to Laksmi Srivastava', expect: ['PERSON'] },
  { id: 'v2', form: 'misspelt', text: 'Venkatesh Iyenger called', expect: ['PERSON'] },
  { id: 'v3', form: 'misspelt', text: 'Farhan Sidiqui wants a callback', expect: ['PERSON'] },
  { id: 'v4', form: 'transliterated', text: 'Laxmi Shrivastav signed the form', expect: ['PERSON'] },
  { id: 'v5', form: 'transliterated', text: 'Aniruddh Choudhari is the nominee', expect: ['PERSON'] },
  { id: 'v6', form: 'transliterated', text: 'Bhawana Kulkarni, Pune', expect: ['PERSON'] },
  { id: 'v7', form: 'initials', text: 'Signed: J. Fernandes', expect: ['PERSON'] },
  { id: 'v8', form: 'initials', text: 'cc: Kulkarni B', expect: ['PERSON'] },
  { id: 'v9', form: 'reordered', text: 'Siddiqui, Farhan (proposer)', expect: ['PERSON'] },
  { id: 'v10', form: 'file-name', text: 'attached lakshmi_srivastava_kyc.pdf', expect: ['PERSON'] },
  { id: 'v11', form: 'file-name', text: 'uploads/VenkateshIyengar/2026/form16.pdf', expect: ['PERSON'] },
  { id: 'v12', form: 'file-name', text: 'statement-josephfernandes-march.xlsx', expect: ['PERSON'] },
  { id: 'v13', form: 'look-alike', text: 'Dear Јоseph Fеrnandes,', expect: ['PERSON'] }, // Cyrillic Ј, о, е
  { id: 'v14', form: 'look-alike', text: 'Meenakshi​ Sundaram', expect: ['PERSON'] },
  { id: 'v15', form: 'encoded', text: `data=${b64('{"name":"Anirudh Chaudhary"}')}`, expect: ['PERSON'] },
  { id: 'v16', form: 'encoded', text: '/share?to=Bhavana%20Kulkarni', expect: ['PERSON'] },
  { id: 'v17', form: 'misspelt', text: 'Gurpreet Kaur Dhilon joined', expect: ['PERSON'] },
  { id: 'v18', form: 'case', text: 'konkan agro exports — outstanding', expect: ['ORG'] },
  { id: 'v19', form: 'exact', text: 'whatsapp 9820144556', expect: ['PHONE'] },
  { id: 'v20', form: 'exact', text: 'cust 2024 00917', expect: ['ID'] },
  // Forms the detectors are known not to handle (kept in the set so the recall figure is honest about them).
  { id: 'v21', form: 'nickname', text: 'Venky Iyengar from Chennai', expect: ['PERSON'] },
  { id: 'v22', form: 'spelt-out', text: 'mail lakshmi dot s at registermail dot in', expect: ['EMAIL'] },
  // Identifiers with valid check digits (not in the register: the pattern packs).
  { id: 'p1', form: 'identifier', text: `Aadhaar ${spaced(aadhaar('49870213551'))}`, expect: ['AADHAAR'] },
  { id: 'p2', form: 'identifier', text: `UID: ${aadhaar('76511290034')}`, expect: ['AADHAAR'] },
  { id: 'p3', form: 'identifier', text: 'PAN BQKPS4471M on the form', expect: ['PAN'] },
  { id: 'p4', form: 'identifier', text: 'firm PAN AAEFK2210R', expect: ['PAN'] },
  { id: 'p5', form: 'identifier', text: `GSTIN ${gstin('29AAEFK2210R1Z')}`, expect: ['GSTIN'] },
  { id: 'p6', form: 'identifier', text: `gst no ${gstin('27BQKPS4471M2Z').toLowerCase()}`, expect: ['GSTIN'] },
  { id: 'p7', form: 'identifier', text: 'IFSC SBIN0004021, a/c below', expect: ['IFSC'] },
  { id: 'p8', form: 'identifier', text: 'mobile 7738012345', expect: ['PHONE'] },
  { id: 'p9', form: 'identifier', text: 'pay to rohit88@okicici', expect: ['UPI'] },
  { id: 'p10', form: 'identifier', text: 'passport no. M4417602', expect: ['PASSPORT'] },
  { id: 'p11', form: 'identifier', text: 'Voter ID (EPIC) RJX4471023', expect: ['VOTER_ID'] },
  { id: 'p12', form: 'identifier', text: 'card 4111 1111 1111 1111', expect: ['CARD'] },
  { id: 'p13', form: 'encoded', text: `blob ${b64('pan=BQKPS4471M')}`, expect: ['PAN'] },
  { id: 'p14', form: 'identifier', text: 'write to ops@konkanclients.co.in', expect: ['EMAIL'] },
  // Must not be blocked: ordinary business text, numbers, common words, identifier look-alikes that fail their checks.
  { id: 'n1', form: 'clean', text: 'Which renewals are due this month?', expect: [] },
  { id: 'n2', form: 'clean', text: 'Total premium collected: 4,47,102 across 213 policies.', expect: [] },
  { id: 'n3', form: 'clean', text: 'Send the reminder on the 15th at 10:30 IST.', expect: [] },
  { id: 'n4', form: 'clean', text: 'Lakshmi Puja holiday on Friday', expect: [] },
  { id: 'n5', form: 'clean', text: 'The Joseph Conrad novel is on the shelf', expect: [] },
  {
    id: 'n6',
    form: 'clean',
    text: `Aadhaar ${aadhaar('49870213551').slice(0, 11)}${(Number(verhoeffDigit('49870213551')) + 1) % 10}`,
    expect: [],
  },
  { id: 'n7', form: 'clean', text: 'code BQKXS4471M (not a PAN: X is no holder type)', expect: [] },
  { id: 'n8', form: 'clean', text: 'GSTIN 29AAEFK2210R1ZZ (wrong check character)', expect: [] },
  { id: 'n9', form: 'clean', text: 'order number 9999999999', expect: [] },
  { id: 'n10', form: 'clean', text: 'Order 1234 5678 9012 shipped', expect: [] },
  { id: 'n11', form: 'clean', text: 'Shape of the PAN column: AAAAA9999A', expect: [] },
  { id: 'n12', form: 'clean', text: 'Use test@example.com for the demo', expect: [] },
  { id: 'n13', form: 'clean', text: 'Balaji temple trip planned', expect: [] },
  { id: 'n14', form: 'clean', text: 'Kaur and Singh are common surnames', expect: [] },
  { id: 'n15', form: 'clean', text: 'Exports grew in the Konkan region', expect: [] },
  { id: 'n16', form: 'clean', text: 'Invoice INV-2024-00918 approved', expect: [] },
  { id: 'n17', form: 'clean', text: 'ref 0702233445 is a different number', expect: [] },
  { id: 'n18', form: 'clean', text: `checksum ${b64('nothing personal in here at all')}`, expect: [] },
  { id: 'n19', form: 'clean', text: 'Meeting with the Sundaram Finance team', expect: [] },
  { id: 'n20', form: 'clean', text: 'Draft the KYC checklist for new clients', expect: [] },
];

// ------------------------------------------------------------------------------------------------ the suite

export const piiDetectionSuite: Suite = {
  id: 'pii-detection',
  title: 'Finding protected values before a model request leaves',
  async run(): Promise<SuiteResult> {
    const dictionary = new KnownValueDictionary();
    for (const v of REGISTER) dictionary.add(v);
    const scanner = new ProtectionScanner({ dictionary });
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let knownTotal = 0;
    let knownBlocked = 0;
    let positives = 0;
    let caught = 0;
    let negatives = 0;
    let falseBlocks = 0;
    const missed: string[] = [];
    const wrong: string[] = [];
    const byForm = new Map<Form, { cases: number; caught: number }>();
    for (const c of PII_CASES) {
      const found = new Set(scanner.scan(c.text).map((h) => h.entity));
      const want = new Set(c.expect);
      for (const e of found) if (want.has(e)) tp++;
      for (const e of found) if (!want.has(e)) fp++;
      for (const e of want) if (!found.has(e)) fn++;
      const blocked = found.size > 0;
      if (c.expect.length > 0) {
        positives++;
        const hit = c.expect.some((e) => found.has(e));
        if (hit) caught++;
        else missed.push(`${c.id} (${c.form})`);
        const f = byForm.get(c.form) ?? { cases: 0, caught: 0 };
        byForm.set(c.form, { cases: f.cases + 1, caught: f.caught + (hit ? 1 : 0) });
        if (c.known === true) {
          knownTotal++;
          if (blocked) knownBlocked++;
        }
      } else {
        negatives++;
        if (blocked) {
          falseBlocks++;
          wrong.push(c.id);
        }
      }
    }
    return {
      suite: 'pii-detection',
      title: 'Finding protected values before a model request leaves',
      uac: ['UAC-27'],
      mode: 'deterministic',
      sets: [
        {
          id: 'pii-india-synthetic',
          version: '1',
          provenance: 'synthetic',
          cases: PII_CASES.length,
          contentHash: contentHash({ register: REGISTER, cases: PII_CASES }),
          description: `An invented client register (${REGISTER.length} values) and ${PII_CASES.length} labelled texts: known values exact and varied (misspelt, transliterated, initials, reordered, in file names, look-alike letters, base64 and percent-encoding), Indian identifiers with valid check digits, and ${negatives} texts that must not be blocked.`,
        },
      ],
      measures: [
        {
          id: 'pii-detection/known-value-block-rate',
          title: 'Exact known values blocked',
          unit: 'ratio',
          better: 'higher',
          value: knownTotal === 0 ? 0 : knownBlocked / knownTotal,
          numerator: knownBlocked,
          denominator: knownTotal,
        },
        {
          id: 'pii-detection/recall',
          title: 'Texts carrying a protected value that were caught',
          unit: 'ratio',
          better: 'higher',
          value: positives === 0 ? 0 : caught / positives,
          numerator: caught,
          denominator: positives,
        },
        {
          id: 'pii-detection/precision',
          title: 'Entities found that were really there',
          unit: 'ratio',
          better: 'higher',
          value: tp + fp === 0 ? 0 : tp / (tp + fp),
          numerator: tp,
          denominator: tp + fp,
        },
        {
          id: 'pii-detection/false-block-rate',
          title: 'Clean texts that would have been blocked',
          unit: 'ratio',
          better: 'lower',
          value: negatives === 0 ? 0 : falseBlocks / negatives,
          numerator: falseBlocks,
          denominator: negatives,
        },
      ],
      notes: [
        `By form: ${[...byForm.entries()].map(([f, v]) => `${f} ${v.caught}/${v.cases}`).join(', ')}.`,
        ...(missed.length > 0 ? [`Missed: ${missed.join(', ')}.`] : []),
        ...(wrong.length > 0 ? [`Wrongly blocked: ${wrong.join(', ')}.`] : []),
        `Entity-level: ${tp} found correctly, ${fp} extra, ${fn} not found.`,
      ],
      limits: [
        'Synthetic and small: it shows which forms the detectors handle, not their rate on real customer text. Measuring on real (consented, local) data is an owner decision.',
        'Written by the engineer who wrote the detectors, so it is not blind (compare ADR 0030): a held-out set written by someone else is needed before a threshold is ratified.',
        'Names that are in no spreadsheet and no setting are not detected: that needs the NER sidecar (14c-3), deferred until a vertical must send free text.',
        'Transliteration coverage is a fixed spelling key (ksh/x, aspirates, sh/s, w/v, z/j, doubled letters, vowel runs), not a learned model.',
      ],
    };
  },
};
