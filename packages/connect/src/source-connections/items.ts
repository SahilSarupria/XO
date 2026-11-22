/**
 * V1-1 (ADR 0049, V1-G2) — the items of a batch, built from a source a person confirmed: one item per row of a table, and, for
 * "each person's document", the one document whose file name carries that row's name.
 *
 * Deterministic and local. Nothing is guessed: a row XO cannot pair with exactly one document is left out and reported, with why,
 * never matched to the nearest candidate. Values are the cells as stored (text); field names come from the column headers.
 */
import { matchPath, personName, type NameMatchKind, type PersonName } from './names.js';

/** The fields an item gets for its document (the arguments `message.send` reads for a flat attachment). */
export const DOCUMENT_FIELDS = ['document_sha256', 'document_name', 'document_type'] as const;
export const MAX_SOURCE_ITEMS = 10_000;
const FIELD = /^[a-z][a-z0-9_]{0,63}$/;

/** A column header as a field name: `Client name` → `client_name`, `E-mail` → `e_mail`; never one of the document fields. */
export function fieldNames(headers: readonly string[]): string[] {
  const taken = new Set<string>(DOCUMENT_FIELDS);
  return headers.map((h, i) => {
    let base = h
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 56);
    if (base === '') base = `column_${i + 1}`;
    if (!/^[a-z]/.test(base)) base = `c_${base}`;
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
    taken.add(name);
    if (!FIELD.test(name)) throw new Error(`internal: field name "${name}"`);
    return name;
  });
}

export interface SourceDocument {
  /** Path relative to the connected folder (what the name is matched against). */
  readonly key: string;
  readonly name: string;
  readonly digestSha256: string;
  readonly contentType: string;
}

export type ExcludedRowReason = 'no_name' | 'no_document' | 'several_documents' | 'name_on_several_rows' | 'blank';
export type ExcludedDocumentReason = 'matches_no_one' | 'matches_several';

export interface SourceItems {
  readonly fields: readonly string[];
  readonly items: readonly Readonly<Record<string, string>>[];
  /** For each item, the row of the table it came from (1 = the first row under the headers). */
  readonly rows: readonly number[];
  readonly excludedRows: readonly { readonly row: number; readonly reason: ExcludedRowReason }[];
  readonly excludedDocuments: readonly { readonly name: string; readonly reason: ExcludedDocumentReason }[];
  /** Rows paired only by another spelling, a short form of the first name, or initials (worth a look in the preview). */
  readonly looseRows: readonly { readonly row: number; readonly kind: NameMatchKind }[];
}

export interface BuildItemsInput {
  readonly headers: readonly string[];
  /** Each row's cells, in header order. */
  readonly rows: readonly (readonly string[])[];
  /** "Each person's document": the column holding the names, and the documents of the folder. */
  readonly pairing?: { readonly nameColumn: string; readonly documents: readonly SourceDocument[] };
}

const LOOSE: ReadonlySet<NameMatchKind> = new Set<NameMatchKind>(['spelling', 'nickname', 'initials']);

export function buildSourceItems(input: BuildItemsInput): SourceItems {
  const fields = fieldNames(input.headers);
  const excludedRows: { row: number; reason: ExcludedRowReason }[] = [];
  const excludedDocuments: { name: string; reason: ExcludedDocumentReason }[] = [];
  const looseRows: { row: number; kind: NameMatchKind }[] = [];
  const record = (cells: readonly string[]): Record<string, string> =>
    Object.fromEntries(fields.map((f, i) => [f, (cells[i] ?? '').trim()]));
  const blank = (cells: readonly string[]) => cells.every((c) => c.trim() === '');

  let docOf: Map<number, { doc: SourceDocument; kind: NameMatchKind }[]> | undefined;
  const reasonOf = new Map<number, ExcludedRowReason>();
  if (input.pairing !== undefined) {
    const col = input.headers.indexOf(input.pairing.nameColumn);
    if (col < 0) throw new SourceItemsError('name_column_missing', `the table no longer has the column "${input.pairing.nameColumn}"`);
    const people: PersonName[] = [];
    const byName = new Map<string, number[]>();
    for (const [i, cells] of input.rows.entries()) {
      if (blank(cells)) continue;
      const p = personName(i, cells[col] ?? '');
      if (p === undefined) {
        reasonOf.set(i, 'no_name');
        continue;
      }
      people.push(p);
      const k = p.words.join(' ');
      byName.set(k, [...(byName.get(k) ?? []), i]);
    }
    // The same name on two rows: XO cannot tell which row a document is for, so neither row gets one.
    for (const rows of byName.values()) if (rows.length > 1) for (const i of rows) reasonOf.set(i, 'name_on_several_rows');
    docOf = new Map();
    for (const doc of input.pairing.documents) {
      const m = matchPath(doc.key, people);
      if (m.outcome === 'none') excludedDocuments.push({ name: doc.name, reason: 'matches_no_one' });
      else if (m.outcome === 'ambiguous') excludedDocuments.push({ name: doc.name, reason: 'matches_several' });
      else docOf.set(m.person, [...(docOf.get(m.person) ?? []), { doc, kind: m.kind }]);
    }
  }

  const items: Record<string, string>[] = [];
  const rows: number[] = [];
  for (const [i, cells] of input.rows.entries()) {
    const row = i + 1;
    const docs = docOf?.get(i) ?? [];
    const why: ExcludedRowReason | undefined = blank(cells)
      ? 'blank'
      : docOf === undefined
        ? undefined
        : (reasonOf.get(i) ?? (docs.length === 0 ? 'no_document' : docs.length > 1 ? 'several_documents' : undefined));
    if (why !== undefined) {
      excludedRows.push({ row, reason: why });
      continue;
    }
    rows.push(row);
    if (docOf === undefined) {
      items.push(record(cells));
      continue;
    }
    const { doc, kind } = docs[0]!;
    if (LOOSE.has(kind)) looseRows.push({ row, kind });
    items.push({ ...record(cells), document_sha256: doc.digestSha256, document_name: doc.name, document_type: doc.contentType });
  }
  if (items.length > MAX_SOURCE_ITEMS)
    throw new SourceItemsError('too_many', `the source has ${items.length} items; a batch holds at most ${MAX_SOURCE_ITEMS}`);
  return {
    fields: docOf !== undefined ? [...fields, ...DOCUMENT_FIELDS] : fields,
    items,
    rows,
    excludedRows,
    excludedDocuments,
    looseRows,
  };
}

export class SourceItemsError extends Error {
  constructor(
    readonly code: 'name_column_missing' | 'too_many',
    message: string,
  ) {
    super(message);
    this.name = 'SourceItemsError';
  }
}
