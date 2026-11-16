import { redactSecrets } from '../redaction.js';
import type { ProviderMessage, ProviderRequest } from '../provider-types.js';

/**
 * UW-14b — the typed egress boundary. What a hosted model may be sent is built from four closed kinds only:
 *
 *   SchemaDescriptor   column names, declared types, counts and value SHAPES of a table (`AAAAA9999A`), never a value
 *   SyntheticRecordSet example records generated from a descriptor with a seeded generator, never from real values
 *   IntentText         the person's own request after an intent filter
 *   FixedTemplate      text written in XO's code and registered at load time (`defineTemplate`), sealed before serving
 *
 * Each is minted by a constructor in this module and recorded in a private registry; anything else (a string from a document, a
 * look-alike object, a copy of a minted request with one message changed) is refused by `buildEgressRequest`, and a request that did
 * not come out of `buildEgressRequest` is refused by the provider guard in `masked_hosted` residency. The control is not sending,
 * not detecting: there is no way to put a cell value into a descriptor.
 */
export class EgressBoundaryError extends Error {}

const PARTS = new WeakSet<object>();
const REQUESTS = new WeakSet<object>();

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

function mint<T extends object>(part: T): T {
  deepFreeze(part);
  PARTS.add(part);
  return part;
}

// ------------------------------------------------------------------------------------------------ schema descriptors

/** The column types the descriptor may carry (the tabular reader's declared types). Anything else becomes `unknown`. */
export const SCHEMA_COLUMN_TYPES = ['string', 'integer', 'decimal', 'boolean', 'date', 'mixed', 'empty', 'error', 'unknown'] as const;
export type SchemaColumnType = (typeof SCHEMA_COLUMN_TYPES)[number];

export interface SchemaColumn {
  /** The header, or `column_<n>` when withheld (asked for, or the header itself looks like a value). */
  readonly name: string;
  readonly withheld: boolean;
  readonly type: SchemaColumnType;
  readonly nonEmpty: number;
  readonly distinct: number;
  readonly length: { readonly min: number; readonly max: number };
  /**
   * The commonest character-class shape (A upper, a lower, 9 digit, kept punctuation) when at least two values and at least half the
   * column share it, so a shape describes a format (`AAAAA9999A`) and never one person's value.
   */
  readonly shape?: string;
}

export interface SchemaDescriptor {
  readonly kind: 'schema';
  readonly name: string;
  readonly recordCount: number;
  readonly columns: readonly SchemaColumn[];
}

/** What a descriptor is computed from: a table as the tabular reader produces it (adapters live with the readers). */
export interface SchemaSource {
  readonly name: string;
  readonly columns: readonly { readonly header: string; readonly type: string }[];
  readonly rows: readonly (readonly (string | number | boolean | null | undefined)[])[];
}

export interface DescribeSchemaOptions {
  /** Headers not to disclose (a column named for a medical condition, say), or `all` to withhold every name. */
  readonly withhold?: readonly string[] | 'all';
}

const SAFE_PUNCT = new Set([...'-_./@:,()+&#% ']);
const MAX_SHAPE = 24;

/** `PAN: ABCDE1234F` → `AAAAA9999A`. Letters and digits never survive; only the safe punctuation set does. */
export function valueShape(value: string): string | undefined {
  if (value.length === 0 || value.length > MAX_SHAPE) return undefined;
  let out = '';
  for (const ch of value) {
    if (/\p{Lu}/u.test(ch)) out += 'A';
    else if (/\p{L}/u.test(ch)) out += 'a';
    else if (/\p{N}/u.test(ch)) out += '9';
    else out += SAFE_PUNCT.has(ch) ? ch : '?';
  }
  return out;
}

const NAME_SHAPE = /^[\p{L}][\p{L}\p{N} _.\-/()&%#']{0,63}$/u;

/** A header is disclosed only when it reads like a name: no run of 4+ digits, no `@`, at most 64 characters, starting with a letter. */
export function disclosableName(raw: string): boolean {
  const s = raw.trim();
  return NAME_SHAPE.test(s) && !/\d{4,}/.test(s) && !s.includes('@');
}

export function describeSchema(source: SchemaSource, options: DescribeSchemaOptions = {}): SchemaDescriptor {
  const withholdAll = options.withhold === 'all';
  const withhold = new Set(Array.isArray(options.withhold) ? options.withhold.map((h) => h.trim()) : []);
  const columns: SchemaColumn[] = source.columns.map((c, i) => {
    const header = c.header.trim();
    const withheld = withholdAll || withhold.has(header) || !disclosableName(header);
    const values = source.rows
      .map((r) => r[i])
      .filter((v) => v !== null && v !== undefined && String(v) !== '')
      .map((v) => String(v));
    const lengths = values.map((v) => [...v].length);
    const shapes = new Map<string, number>();
    for (const v of values) {
      const s = valueShape(v);
      if (s !== undefined) shapes.set(s, (shapes.get(s) ?? 0) + 1);
    }
    const top = [...shapes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const type = (SCHEMA_COLUMN_TYPES as readonly string[]).includes(c.type) ? (c.type as SchemaColumnType) : 'unknown';
    return {
      name: withheld ? `column_${i + 1}` : header,
      withheld,
      type,
      nonEmpty: values.length,
      distinct: new Set(values).size,
      length: { min: lengths.length > 0 ? Math.min(...lengths) : 0, max: lengths.length > 0 ? Math.max(...lengths) : 0 },
      // A shape is disclosed only when it describes a pattern, not a person: shared by at least two values and half the column.
      ...(top !== undefined && top[1] >= 2 && top[1] * 2 >= values.length ? { shape: top[0] } : {}),
    };
  });
  const name = disclosableName(source.name) ? source.name.trim() : 'table';
  return mint({ kind: 'schema', name, recordCount: source.rows.length, columns });
}

// ------------------------------------------------------------------------------------------------ synthetic records

export interface SyntheticRecordSet {
  readonly kind: 'synthetic';
  readonly schema: string;
  readonly seed: string;
  readonly records: readonly Readonly<Record<string, string | number | boolean | null>>[];
}

function prng(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UPPER = 'BCDFGHJKLMNPQRSTVWXZ';
const LOWER = 'bcdfghjklmnpqrstvwxz';
const WORDS = ['Sample', 'Example', 'Placeholder', 'Synthetic', 'Fixture', 'Demo'];

/** Records generated from the descriptor alone (it holds no values), so no real value can appear except by coincidence of form. */
export function synthesizeRecords(
  descriptor: SchemaDescriptor,
  opts: { readonly count: number; readonly seed: string },
): SyntheticRecordSet {
  if (!PARTS.has(descriptor))
    throw new EgressBoundaryError('synthetic records are generated only from a schema descriptor made by describeSchema');
  if (!Number.isInteger(opts.count) || opts.count < 1 || opts.count > 50) throw new EgressBoundaryError('count must be 1 to 50');
  const rand = prng(`${opts.seed}|${descriptor.name}`);
  const pick = (s: string) => s[Math.floor(rand() * s.length)]!;
  const digits = (n: number) =>
    Array.from({ length: n }, (_, i) => (i === 0 ? String(1 + Math.floor(rand() * 9)) : String(Math.floor(rand() * 10)))).join('');
  const records: Record<string, string | number | boolean | null>[] = [];
  for (let r = 0; r < opts.count; r++) {
    const rec: Record<string, string | number | boolean | null> = {};
    for (const c of descriptor.columns) {
      const lo = Math.max(1, Math.min(c.length.min, 12));
      const hi = Math.max(lo, Math.min(c.length.max, 12));
      const len = lo + Math.floor(rand() * (hi - lo + 1));
      switch (c.type) {
        case 'integer':
          rec[c.name] = Number(digits(Math.min(len, 9)));
          break;
        case 'decimal':
          rec[c.name] = Number(`${digits(Math.max(1, Math.min(len, 7) - 3))}.${digits(2)}`);
          break;
        case 'boolean':
          rec[c.name] = rand() < 0.5;
          break;
        case 'date': {
          const d = new Date(Date.UTC(2000 + Math.floor(rand() * 31), Math.floor(rand() * 12), 1 + Math.floor(rand() * 28)));
          rec[c.name] = d.toISOString().slice(0, 10);
          break;
        }
        case 'empty':
          rec[c.name] = null;
          break;
        default:
          rec[c.name] =
            c.shape !== undefined
              ? [...c.shape]
                  .map((ch) => (ch === 'A' ? pick(UPPER) : ch === 'a' ? pick(LOWER) : ch === '9' ? String(Math.floor(rand() * 10)) : ch))
                  .join('')
              : `${WORDS[Math.floor(rand() * WORDS.length)]} ${r + 1}`;
      }
    }
    records.push(rec);
  }
  return mint({ kind: 'synthetic', schema: descriptor.name, seed: opts.seed, records });
}

// ------------------------------------------------------------------------------------------------ intent text

export interface IntentFilter {
  readonly name: string;
  apply(text: string): { readonly text: string; readonly replaced: number };
}

const INTENT_PATTERNS: readonly [RegExp, string][] = [
  [/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu, '[EMAIL]'],
  [/\bhttps?:\/\/\S+/gi, '[URL]'],
  // Phone numbers, identifiers, account numbers, amounts: any run of 5+ digits, with the separators people type between them.
  [/(?:\+?\d[\d\s().-]{3,}\d)/g, '[NUMBER]'],
];

/**
 * W1 intent filter: credentials, emails, links and digit runs. It cannot know the customer's names; the known-value dictionary and the
 * full-request leak guard (UW-14c to 14e) tighten it. Until they land, prefer schema descriptors and templates over intent text.
 */
export const BASELINE_INTENT_FILTER: IntentFilter = {
  name: 'baseline-patterns/1',
  apply(text) {
    let replaced = 0;
    let out = redactSecrets(text);
    if (out !== text) replaced++;
    for (const [re, label] of INTENT_PATTERNS) {
      out = out.replace(re, (m) => {
        if (label === '[NUMBER]' && m.replace(/\D/g, '').length < 5) return m;
        replaced++;
        return label;
      });
    }
    return { text: out, replaced };
  },
};

export interface IntentText {
  readonly kind: 'intent';
  readonly text: string;
  readonly filteredBy: string;
  readonly replaced: number;
}

export const MAX_INTENT_CHARS = 4000;

export function filterIntent(text: string, filter: IntentFilter = BASELINE_INTENT_FILTER): IntentText {
  if (typeof text !== 'string' || text.trim() === '') throw new EgressBoundaryError('intent text is empty');
  if (text.length > MAX_INTENT_CHARS) throw new EgressBoundaryError(`intent text is longer than ${MAX_INTENT_CHARS} characters`);
  const r = filter.apply(text.normalize('NFKC'));
  return mint({ kind: 'intent', text: r.text, filteredBy: filter.name, replaced: r.replaced });
}

// ------------------------------------------------------------------------------------------------ fixed templates

export interface FixedTemplate {
  readonly kind: 'template';
  readonly id: string;
  readonly text: string;
}

export interface ResponseSchemaTemplate {
  readonly kind: 'response-schema';
  readonly id: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

const TEMPLATE_IDS = new Set<string>();
let sealed = false;

function register(id: string): void {
  if (sealed) throw new EgressBoundaryError(`templates are sealed: "${id}" must be defined when its module loads, not while serving`);
  if (!/^[a-z0-9][a-z0-9._/-]{2,80}$/.test(id)) throw new EgressBoundaryError(`template id "${id.slice(0, 40)}" is not valid`);
  if (TEMPLATE_IDS.has(id)) throw new EgressBoundaryError(`template "${id}" is defined twice`);
  TEMPLATE_IDS.add(id);
}

/**
 * Text written in XO's own code. Call it at module top level with a literal (a test checks every call site); the instance seals the
 * registry at start-up, after which no template can be added, so text arriving while serving can never become one.
 */
export function defineTemplate(id: string, text: string): FixedTemplate {
  register(id);
  if (text.trim() === '' || text.length > 20_000) throw new EgressBoundaryError(`template "${id}" must be 1 to 20000 characters`);
  return mint({ kind: 'template', id, text });
}

export function defineResponseSchema(id: string, schema: Readonly<Record<string, unknown>>): ResponseSchemaTemplate {
  register(id);
  return mint({ kind: 'response-schema', id, schema: JSON.parse(JSON.stringify(schema)) as Record<string, unknown> });
}

/** Called once by the instance after its modules have loaded. Irreversible for the life of the process. */
export function sealTemplates(): void {
  sealed = true;
}

export function templatesSealed(): boolean {
  return sealed;
}

// ------------------------------------------------------------------------------------------------ requests

export type EgressPart = FixedTemplate | SchemaDescriptor | SyntheticRecordSet | IntentText;

export interface EgressRequestSpec {
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  readonly responseSchema?: ResponseSchemaTemplate;
  readonly messages: readonly { readonly role: 'system' | 'user'; readonly parts: readonly EgressPart[] }[];
  readonly requestId?: string;
  readonly signal?: AbortSignal;
}

function render(part: EgressPart): string {
  switch (part.kind) {
    case 'template':
      return part.text;
    case 'intent':
      return part.text;
    case 'schema':
      return `Schema of "${part.name}" (${part.recordCount} records):\n${JSON.stringify(part.columns)}`;
    case 'synthetic':
      return `Synthetic example records for "${part.schema}" (generated from the schema, not real data):\n${part.records.map((r) => JSON.stringify(r)).join('\n')}`;
  }
}

/** The only way to make a request a hosted model receives in `masked_hosted` residency. Images and tools are never part of one. */
export function buildEgressRequest(spec: EgressRequestSpec): ProviderRequest {
  if (!/^[\w.:/@-]{1,120}$/.test(spec.model)) throw new EgressBoundaryError('model id is not valid');
  if (!Number.isInteger(spec.maxOutputTokens) || spec.maxOutputTokens < 1)
    throw new EgressBoundaryError('maxOutputTokens must be a positive integer');
  if (spec.responseSchema !== undefined && !PARTS.has(spec.responseSchema))
    throw new EgressBoundaryError('responseSchema must come from defineResponseSchema');
  if (spec.messages.length === 0) throw new EgressBoundaryError('a request needs at least one message');
  const messages: ProviderMessage[] = spec.messages.map((m, i) => {
    if (m.role !== 'system' && m.role !== 'user') throw new EgressBoundaryError(`message ${i + 1}: role must be system or user`);
    if (m.parts.length === 0) throw new EgressBoundaryError(`message ${i + 1} has no parts`);
    for (const p of m.parts) {
      if (p === null || typeof p !== 'object' || !PARTS.has(p)) {
        throw new EgressBoundaryError(
          `message ${i + 1}: a part did not come from the egress boundary (only schema descriptors, synthetic records, filtered intent and templates may be sent)`,
        );
      }
    }
    return Object.freeze({ role: m.role, content: m.parts.map(render).join('\n\n') });
  });
  const request: ProviderRequest = {
    model: spec.model,
    messages: Object.freeze(messages),
    maxOutputTokens: spec.maxOutputTokens,
    ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
    ...(spec.responseSchema !== undefined ? { responseSchema: spec.responseSchema.schema } : {}),
    ...(spec.requestId !== undefined ? { requestId: spec.requestId } : {}),
    ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
  };
  Object.freeze(request);
  REQUESTS.add(request);
  return request;
}

/** True only for the very object `buildEgressRequest` returned (a copy, however faithful, is not typed). */
export function isTypedEgressRequest(request: ProviderRequest): boolean {
  return REQUESTS.has(request);
}

/** True for a part minted by this module. */
export function isEgressPart(value: unknown): value is EgressPart {
  return value !== null && typeof value === 'object' && PARTS.has(value);
}
