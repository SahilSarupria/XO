/**
 * UW-12a — discovery: what the files of a source connection look like, as PROPOSALS a person confirms or rejects.
 *
 * Deterministic and local: no model is asked anything, nothing leaves the instance. Each proposal says what it is based on (the
 * columns, counts and matches it saw), so a person can judge it. A proposal is never knowledge: it stays `proposed` until a person
 * confirms it, and what is confirmed is an operational binding ("this table is the client list"), not a business fact.
 *
 * Roles:
 *   - contact_list: a table with a name column and an email column ("looks like a client list");
 *   - record_table: any other table of records;
 *   - document_collection: a folder holding several documents, named by what most of their file names say ("a folder of certificates");
 *   - per_person_documents: a contact list and a document collection whose file names carry the people's names (each client's
 *     certificate), with how many match and how many do not.
 */
import { createHash } from 'node:crypto';
import { matchPath, personName, type NameMatchKind, type PersonName } from './names.js';

export interface DiscoveryColumn {
  readonly header: string;
  /** The column's values, as stored (bounded by the caller). */
  readonly values: readonly string[];
}

export interface DiscoveryTable {
  /** Stable within the file (`Clients#1`). */
  readonly recordSetId: string;
  readonly sheet?: string;
  readonly rows: number;
  readonly columns: readonly DiscoveryColumn[];
}

export interface DiscoveryItem {
  /** Path relative to the connected folder. */
  readonly key: string;
  readonly name: string;
  readonly extension: string;
  readonly sourceId: string;
  readonly digestSha256: string;
  /** For workbooks and CSV files: the tables read from it. */
  readonly tables?: readonly DiscoveryTable[];
}

export type RoleKind = 'contact_list' | 'record_table' | 'document_collection' | 'per_person_documents';

export type RoleTarget =
  | { readonly kind: 'table'; readonly itemKey: string; readonly recordSetId: string }
  | { readonly kind: 'folder'; readonly prefix: string; readonly extensions: readonly string[] }
  | {
      readonly kind: 'pairing';
      readonly table: { readonly itemKey: string; readonly recordSetId: string };
      readonly folder: { readonly prefix: string };
      /** The table column whose values the file names carry. */
      readonly nameColumn: string;
    };

export interface RoleProposal {
  /** `rol_` + 16 hex: stable for the same role over the same target, across syncs. */
  readonly proposalId: string;
  readonly role: RoleKind;
  /** Plain words: "a client list", "a folder of certificates". */
  readonly label: string;
  readonly target: RoleTarget;
  /** What the proposal is based on, in plain words. */
  readonly basis: readonly string[];
  readonly strength: 'strong' | 'weak';
  /** Counts a screen can show. */
  readonly counts: Readonly<Record<string, number>>;
}

export const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf',
  '.docx',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.eml',
  '.html',
  '.htm',
  '.txt',
  '.md',
]);
const TABLE_EXTENSIONS = new Set(['.xlsx', '.csv']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_HEADER = /\b(?:name|client|customer|insured|member|employee|contact|person|party|holder|policyholder|student|patient)\b/;
const NOT_NAME_HEADER = /\b(?:e-?mail|phone|mobile|id|no|number|code|date|amount|address|city|status|type)\b/;

/** Lists named by what their headers, sheet or file say. */
const LIST_KINDS: readonly (readonly [RegExp, string, string])[] = [
  [/\b(?:client|customer|policyholder|insured)s?\b/, 'a client list', 'client'],
  [/\b(?:employee|staff|worker|team)s?\b/, 'a staff list', 'person on staff'],
  [/\b(?:vendor|supplier)s?\b/, 'a supplier list', 'supplier'],
  [/\b(?:member)s?\b/, 'a member list', 'member'],
  [/\b(?:student)s?\b/, 'a student list', 'student'],
  [/\b(?:patient)s?\b/, 'a patient list', 'patient'],
];
/** Document collections named by the word most of their file names share. */
const DOCUMENT_KINDS: readonly (readonly [string, string])[] = [
  ['certificate', 'certificates'],
  ['cert', 'certificates'],
  ['invoice', 'invoices'],
  ['receipt', 'receipts'],
  ['policy', 'policies'],
  ['statement', 'statements'],
  ['contract', 'contracts'],
  ['agreement', 'agreements'],
  ['payslip', 'payslips'],
  ['quote', 'quotes'],
  ['quotation', 'quotes'],
  ['report', 'reports'],
  ['letter', 'letters'],
  ['form', 'forms'],
  ['renewal', 'renewal notices'],
];

const words = (s: string): string[] =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);

const idOf = (role: RoleKind, target: RoleTarget): string =>
  `rol_${createHash('sha256')
    .update(JSON.stringify([role, target]))
    .digest('hex')
    .slice(0, 16)}`;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function emailColumn(t: DiscoveryTable): { column: DiscoveryColumn; share: number; filled: number } | undefined {
  let best: { column: DiscoveryColumn; share: number; filled: number } | undefined;
  for (const c of t.columns) {
    const filled = c.values.filter((v) => v.trim() !== '');
    if (filled.length === 0) continue;
    const share = filled.filter((v) => EMAIL.test(v.trim())).length / filled.length;
    if (share >= 0.6 && (best === undefined || share > best.share)) best = { column: c, share, filled: filled.length };
  }
  return best;
}

function nameColumn(t: DiscoveryTable, exclude: DiscoveryColumn): DiscoveryColumn | undefined {
  const textual = (c: DiscoveryColumn): boolean => {
    const filled = c.values.filter((v) => v.trim() !== '');
    return (
      filled.length > 0 && filled.filter((v) => /\p{L}/u.test(v) && !EMAIL.test(v.trim()) && !/\d{3}/.test(v)).length / filled.length >= 0.8
    );
  };
  const byHeader = t.columns.find(
    (c) => c !== exclude && NAME_HEADER.test(c.header.toLowerCase()) && !NOT_NAME_HEADER.test(c.header.toLowerCase()) && textual(c),
  );
  return byHeader ?? t.columns.find((c) => c !== exclude && textual(c));
}

function listKind(item: DiscoveryItem, t: DiscoveryTable): { label: string; singular: string } {
  const hay = [item.name, t.sheet ?? '', ...t.columns.map((c) => c.header)].join(' ').toLowerCase();
  for (const [re, label, singular] of LIST_KINDS) if (re.test(hay)) return { label, singular };
  return { label: 'a contact list', singular: 'contact' };
}

const parentOf = (key: string): string => (key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '');

export function proposeRoles(items: readonly DiscoveryItem[]): RoleProposal[] {
  const out: RoleProposal[] = [];
  const contactLists: { item: DiscoveryItem; table: DiscoveryTable; names: DiscoveryColumn; singular: string; label: string }[] = [];

  for (const item of items) {
    if (!TABLE_EXTENSIONS.has(item.extension)) continue;
    for (const t of item.tables ?? []) {
      if (t.rows < 1) continue;
      const email = emailColumn(t);
      const names = email !== undefined ? nameColumn(t, email.column) : undefined;
      const target: RoleTarget = { kind: 'table', itemKey: item.key, recordSetId: t.recordSetId };
      if (email !== undefined && names !== undefined) {
        const kind = listKind(item, t);
        contactLists.push({ item, table: t, names, ...kind });
        out.push({
          proposalId: idOf('contact_list', target),
          role: 'contact_list',
          label: kind.label,
          target,
          basis: [
            `${t.rows === 1 ? 'one row' : `${t.rows} rows`}, each a ${kind.singular}`,
            `column "${names.header}" holds names`,
            `column "${email.column.header}" holds email addresses (${Math.round(email.share * 100)}% of ${email.filled} filled cells)`,
          ],
          strength: email.share >= 0.9 && NAME_HEADER.test(names.header.toLowerCase()) ? 'strong' : 'weak',
          counts: { rows: t.rows, withEmail: Math.round(email.share * email.filled) },
        });
      } else if (t.rows >= 2) {
        out.push({
          proposalId: idOf('record_table', target),
          role: 'record_table',
          label: `a table of ${t.rows} records`,
          target,
          basis: [
            `columns: ${t.columns
              .slice(0, 6)
              .map((c) => `"${c.header}"`)
              .join(', ')}${t.columns.length > 6 ? ', …' : ''}`,
          ],
          strength: 'weak',
          counts: { rows: t.rows, columns: t.columns.length },
        });
      }
    }
  }

  // Document collections: documents grouped by the folder they are in.
  const folders = new Map<string, DiscoveryItem[]>();
  for (const item of items) {
    if (!DOCUMENT_EXTENSIONS.has(item.extension)) continue;
    const p = parentOf(item.key);
    folders.set(p, [...(folders.get(p) ?? []), item]);
  }
  const collections: { prefix: string; docs: DiscoveryItem[]; noun: string; label: string }[] = [];
  for (const [prefix, docs] of [...folders.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (docs.length < 2) continue;
    const counts = new Map<string, number>();
    for (const d of docs) {
      const ws = new Set(words(d.name.slice(0, d.name.length - d.extension.length)));
      for (const [w, noun] of DOCUMENT_KINDS) if (ws.has(w) || ws.has(`${w}s`)) counts.set(noun, (counts.get(noun) ?? 0) + 1);
    }
    if (prefix !== '')
      for (const [w, noun] of DOCUMENT_KINDS)
        if (words(prefix.split('/').at(-1) ?? '').some((x) => x === w || x === `${w}s`)) counts.set(noun, docs.length);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const noun = top !== undefined && top[1] / docs.length >= 0.5 ? top[0] : 'documents';
    const extensions = [...new Set(docs.map((d) => d.extension))].sort();
    const where = prefix === '' ? 'the connected folder' : `folder "${prefix.split('/').at(-1)}"`;
    const label = `a folder of ${noun}`;
    collections.push({ prefix, docs, noun, label });
    const target: RoleTarget = { kind: 'folder', prefix, extensions };
    out.push({
      proposalId: idOf('document_collection', target),
      role: 'document_collection',
      label,
      target,
      basis: [
        `${where} holds ${plural(docs.length, 'document')} (${extensions.join(', ')})`,
        ...(noun !== 'documents' ? [`${top![1]} of their names say "${noun}"`] : []),
      ],
      strength: noun !== 'documents' ? 'strong' : 'weak',
      counts: { documents: docs.length },
    });
  }

  // Each person's document: file names carrying the names in a contact list.
  for (const list of contactLists) {
    const people = list.names.values.map((v, i) => personName(i, v)).filter((p): p is PersonName => p !== undefined);
    const distinctPeople = new Set(people.map((p) => p.words.join(' '))).size;
    for (const c of collections) {
      let matchedDocs = 0;
      let ambiguous = 0;
      const perPerson = new Map<string, number>();
      const byKind: Partial<Record<NameMatchKind, number>> = {};
      for (const d of c.docs) {
        const m = matchPath(d.key, people);
        if (m.outcome === 'matched') {
          matchedDocs++;
          byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
          const who = people.find((p) => p.index === m.person)!.words.join(' ');
          perPerson.set(who, (perPerson.get(who) ?? 0) + 1);
        } else if (m.outcome === 'ambiguous') ambiguous++;
      }
      const loose = (byKind.spelling ?? 0) + (byKind.nickname ?? 0) + (byKind.initials ?? 0);
      const several = [...perPerson.values()].filter((n) => n > 1).length;
      const without = distinctPeople - perPerson.size;
      if (matchedDocs === 0 || matchedDocs / c.docs.length < 0.5) continue;
      const target: RoleTarget = {
        kind: 'pairing',
        table: { itemKey: list.item.key, recordSetId: list.table.recordSetId },
        folder: { prefix: c.prefix },
        nameColumn: list.names.header,
      };
      const singular = list.singular;
      const docNoun = c.noun === 'documents' ? 'document' : c.noun.replace(/ies$/, 'y').replace(/s$/, '');
      out.push({
        proposalId: idOf('per_person_documents', target),
        role: 'per_person_documents',
        label: `each ${singular}'s ${docNoun}`,
        target,
        basis: [
          `${matchedDocs} of ${plural(c.docs.length, docNoun, c.noun === 'documents' ? 'documents' : c.noun)} are named after one ${singular} in ${list.label.replace(/^a /, 'the ')} (column "${list.names.header}")`,
          ...(loose > 0
            ? [
                `${loose} of these only by ${[
                  ...(byKind.spelling !== undefined ? ['another spelling'] : []),
                  ...(byKind.nickname !== undefined ? ['a short form of the first name'] : []),
                  ...(byKind.initials !== undefined ? ['initials'] : []),
                ].join(', or ')} (worth a look)`,
              ]
            : []),
          ...(c.docs.length - matchedDocs - ambiguous > 0 ? [`${c.docs.length - matchedDocs - ambiguous} match no one`] : []),
          ...(ambiguous > 0 ? [`${ambiguous} match more than one ${singular}`] : []),
          ...(several > 0 ? [`${several} ${several === 1 ? 'has' : 'have'} more than one`] : []),
          ...(without > 0 ? [`${without} ${singular === 'person on staff' ? 'people' : `${singular}s`} have none`] : []),
        ],
        strength: matchedDocs === c.docs.length && ambiguous === 0 && loose === 0 ? 'strong' : 'weak',
        counts: {
          documents: c.docs.length,
          matched: matchedDocs,
          ambiguous,
          unmatchedDocuments: c.docs.length - matchedDocs - ambiguous,
          peopleWithout: without,
          ...Object.fromEntries(Object.entries(byKind).map(([k, v]) => [`by_${k}`, v])),
          ...(several > 0 ? { peopleWithSeveral: several } : {}),
        },
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the chat message

export interface DiscoveryMessageInput {
  readonly connections: readonly { readonly displayName: string; readonly items: readonly DiscoveryItem[] }[];
  readonly proposals: readonly (RoleProposal & { readonly status: 'proposed' | 'confirmed' | 'rejected' })[];
}

const listWords = (xs: readonly string[]): string =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/**
 * The message XO opens a conversation with after reading a connection: what it found, what it thinks each thing is, and the question
 * "What would you like to do?". Plain text, no model. Names files and folders the person connected; never a cell value.
 */
export function discoveryMessage(input: DiscoveryMessageInput): string {
  const items = input.connections.flatMap((c) => c.items);
  if (items.length === 0)
    return `I looked in ${listWords(input.connections.map((c) => `"${c.displayName}"`))} and found nothing I can read yet. Add files there, or tell me what you would like to do.`;
  const workbooks = items.filter((i) => TABLE_EXTENSIONS.has(i.extension));
  const found: string[] = [];
  if (workbooks.length > 0)
    found.push(
      workbooks.length === 1
        ? `a ${workbooks[0]!.extension === '.csv' ? 'spreadsheet' : 'workbook'} (${workbooks[0]!.name})`
        : `${workbooks.length} spreadsheets`,
    );
  const collections = input.proposals.filter((p) => p.role === 'document_collection' && p.status !== 'rejected');
  for (const c of collections) found.push(`${c.label.replace(/^a folder of /, 'a folder of ')} (${c.counts['documents']})`);
  const loose =
    items.filter((i) => DOCUMENT_EXTENSIONS.has(i.extension)).length - collections.reduce((n, c) => n + (c.counts['documents'] ?? 0), 0);
  if (loose > 0) found.push(plural(loose, 'other document'));
  const lines = [`I found ${listWords(found)}.`];
  const shown = input.proposals.filter((p) => p.status !== 'rejected' && (p.role === 'contact_list' || p.role === 'per_person_documents'));
  for (const p of shown) {
    const what = p.target.kind === 'table' ? items.find((i) => i.key === (p.target as { itemKey: string }).itemKey)?.name : undefined;
    lines.push(
      p.role === 'contact_list'
        ? `${what ?? 'A table'} looks like ${p.label} (${p.basis[0]}).${p.status === 'confirmed' ? '' : ' Is that right?'}`
        : `${p.basis[0]![0]!.toUpperCase()}${p.basis[0]!.slice(1)}${p.status === 'confirmed' ? '.' : ', so these look like ' + p.label + '. Is that right?'}`,
    );
  }
  lines.push('What would you like to do?');
  return lines.join(' ');
}
