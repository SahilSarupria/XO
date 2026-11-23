/**
 * Generates `v1-vertical-synthetic.json` (UW-13, ADR 0053): a seeded synthetic V1 set whose labels follow from how each row and document
 * was built. Run: `node --import tsx packages/evaluation/sets/generate-v1-synthetic.ts [--write]`. The labels were written with the name
 * matcher's tiers in view (`labelledWith: 'construction'`); they state who each document is for, not what XO is expected to do.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { V1SetLabels } from '../src/external-sets.js';

export const SEED = 20261123;
export interface SyntheticV1Set {
  readonly labels: V1SetLabels;
  /** The list as CSV text. */
  readonly listCsv: string;
  readonly documentNames: readonly string[];
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = [
  'Asha',
  'Vikram',
  'Zoya',
  'Imran',
  'Meera',
  'Arjun',
  'Neha',
  'Rohan',
  'Priya',
  'Karan',
  'Divya',
  'Sanjay',
  'Anita',
  'Farhan',
  'Leela',
  'Manish',
  'Pooja',
  'Rahul',
  'Sunita',
  'Tarun',
];
const NICKED: readonly (readonly [string, string])[] = [
  ['Katherine', 'Kate'],
  ['Venkatesh', 'Venky'],
  ['William', 'Bill'],
  ['Robert', 'Bob'],
  ['Catherine', 'Cathy'],
];
const SYL = [
  'ra',
  'ma',
  'ke',
  'shi',
  'lo',
  'ven',
  'dar',
  'pa',
  'nu',
  'gup',
  'sa',
  'bha',
  'tel',
  'kul',
  'jo',
  'ni',
  'cho',
  'war',
  'sin',
  'der',
];

export function generateV1Set(): SyntheticV1Set {
  const rand = rng(SEED);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const used = new Set<string>();
  const surname = (): string => {
    for (;;) {
      const s = pick(SYL) + pick(SYL) + pick(SYL) + (rand() < 0.5 ? 'kar' : 'ani');
      const name = s[0]!.toUpperCase() + s.slice(1);
      if (!used.has(name)) {
        used.add(name);
        return name;
      }
    }
  };
  type Kind =
    | 'exact'
    | 'underscore'
    | 'hyphen'
    | 'case'
    | 'certificate'
    | 'reordered'
    | 'nickname'
    | 'initials'
    | 'none'
    | 'dup'
    | 'blank'
    | 'twodocs'
    | 'spelling';
  const plan: Kind[] = [];
  const add = (k: Kind, n: number): void => {
    for (let i = 0; i < n; i++) plan.push(k);
  };
  add('underscore', 10);
  add('hyphen', 10);
  add('case', 10);
  add('certificate', 20);
  add('reordered', 10);
  add('nickname', 10);
  add('initials', 10);
  add('none', 10);
  add('dup', 6);
  add('blank', 4);
  add('twodocs', 3);
  add('spelling', 6);
  add('exact', 240 - plan.length);
  // A seeded shuffle, so the kinds are spread through the list.
  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [plan[i], plan[j]] = [plan[j]!, plan[i]!];
  }
  const rows: V1SetLabels['rows'][number][] = [];
  const documentsExpected: V1SetLabels['documentsExpected'][number][] = [];
  const csv: string[] = ['Client name,Email'];
  let dupNames: string[] = [];
  let nick = 0;
  let sp = 0;
  const email = (first: string, last: string, n: number): string =>
    `${first}.${last}${n}@example.test`.toLowerCase().replace(/[^a-z0-9.@]/g, '');
  const doc = (name: string, expected: V1SetLabels['documentsExpected'][number]['expected']): void => {
    documentsExpected.push({ name, expected });
  };
  plan.forEach((kind, i) => {
    const row = i + 1;
    let first = pick(FIRST);
    const last = surname();
    let name = `${first} ${last}`;
    const push = (nm: string, expected: V1SetLabels['rows'][number]['expected']): void => {
      rows.push({ row, name: nm, email: email(nm.split(' ')[0]!, nm.split(' ').slice(1).join(''), row), expected });
      csv.push(`${nm},${rows.at(-1)!.email}`);
    };
    switch (kind) {
      case 'exact':
        push(name, { document: `${name}.pdf` });
        doc(`${name}.pdf`, { row });
        break;
      case 'underscore':
        push(name, { document: `${first}_${last}.pdf` });
        doc(`${first}_${last}.pdf`, { row });
        break;
      case 'hyphen':
        push(name, { document: `${first.toLowerCase()}-${last.toLowerCase()}.pdf` });
        doc(`${first.toLowerCase()}-${last.toLowerCase()}.pdf`, { row });
        break;
      case 'case':
        push(name, { document: `${name.toUpperCase()}.pdf` });
        doc(`${name.toUpperCase()}.pdf`, { row });
        break;
      case 'certificate':
        push(name, { document: `Certificate - ${name}.pdf` });
        doc(`Certificate - ${name}.pdf`, { row });
        break;
      case 'reordered':
        push(name, { document: `${last} ${first}.pdf` });
        doc(`${last} ${first}.pdf`, { row });
        break;
      case 'nickname': {
        const [full, short] = NICKED[nick++ % NICKED.length]!;
        first = full;
        name = `${full} ${last}`;
        push(name, { document: `${short} ${last}.pdf` });
        doc(`${short} ${last}.pdf`, { row });
        break;
      }
      case 'initials':
        push(name, { document: `${first[0]} ${last}.pdf` });
        doc(`${first[0]} ${last}.pdf`, { row });
        break;
      case 'none':
        push(name, { excluded: 'no_document' });
        break;
      case 'dup': {
        // The same name on two rows: the first of a pair is built now, the second repeats it.
        if (dupNames.length % 2 === 0) {
          dupNames = [...dupNames, name];
          push(name, { excluded: 'name_on_several_rows' });
          doc(`${name}.pdf`, { excluded: 'matches_several' });
        } else {
          const again = dupNames.at(-1)!;
          dupNames = [...dupNames, again];
          push(again, { excluded: 'name_on_several_rows' });
        }
        break;
      }
      case 'blank':
        rows.push({ row, name: '', email: '', expected: { excluded: 'blank' } });
        csv.push(',');
        break;
      case 'twodocs':
        push(name, { excluded: 'several_documents' });
        doc(`${name}.pdf`, { row });
        doc(`Certificate - ${name}.pdf`, { row });
        break;
      case 'spelling': {
        const pairs: readonly (readonly [string, string, string])[] = [
          ['José', 'Jose', 'Fernandes'],
          ['Sreenivasan', 'Srinivasan', 'Iyer'],
          ['Mohammed', 'Mohamed', 'Siddiqui'],
          ['Zoë', 'Zoe', 'Menezes'],
          ['Venkatesh', 'Venkatesh', 'Reddy'],
          ['Rajesh', 'Rajeshh', 'Nair'],
        ];
        const [a, b, l] = pairs[sp++ % pairs.length]!;
        const full = `${a} ${l}${sp}`;
        push(full, { document: `${b} ${l}${sp}.pdf` });
        doc(`${b} ${l}${sp}.pdf`, { row });
        break;
      }
    }
  });
  // Documents that name no client, and a pair of dup rows whose document was recorded once per pair.
  for (let i = 0; i < 8; i++) doc(`Annual report ${i + 1}.pdf`, { excluded: 'matches_no_one' });
  const names = [...new Set(documentsExpected.map((d) => d.name))].sort();
  const unique = names.map((n) => documentsExpected.find((d) => d.name === n)!);
  return {
    labels: {
      format: 'xo-v1-set/1',
      provenance: 'synthetic',
      labelledBy: 'engineering (generator)',
      labelledWith: 'construction',
      list: 'list.csv',
      nameColumn: 'Client name',
      emailColumn: 'Email',
      documents: 'documents',
      rows,
      documentsExpected: unique,
    },
    listCsv: `${csv.join('\n')}\n`,
    documentNames: names,
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes('--write')) {
  const out = fileURLToPath(new URL('./v1-vertical-synthetic.json', import.meta.url));
  writeFileSync(out, `${JSON.stringify(generateV1Set(), null, 1)}\n`);
  process.stderr.write(`wrote ${out}\n`);
}
