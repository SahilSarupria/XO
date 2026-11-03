import type { Question } from './clarify.js';
import { identifiersIn, type FactType, type PolicyProgram } from './program.js';

/**
 * How a compiled tree's inputs are filled at run time. Replaces guesswork with two explicit, inspectable things:
 *  - an INPUT CONTRACT: for every input the tree reads, its type, allowed values, plain description, the manual's
 *    sentences that use it, and how it is expected to be obtained;
 *  - a FIELD MAPPING the operator owns: which field of THEIR case record (or which text extraction) supplies each input,
 *    with a small declarative transform. A mapping is data, never code, because an XO is untrusted content.
 * An input that is not mapped is never invented: the tree reports a missing fact and the case escalates.
 */
export type InputHow = 'case_field' | 'derived_from_text' | 'classified';

export interface InputSpec {
  readonly name: string;
  readonly type: FactType;
  readonly enum?: readonly string[];
  readonly description: string;
  readonly how: InputHow;
  /** manual sentences whose rules read this input — what a person checks the mapping against */
  readonly usedBy: readonly string[];
  /** words from the manual's own phrasing, for suggesting a field */
  readonly aliases: readonly string[];
}
export interface InputContract {
  readonly title: string;
  readonly inputs: readonly InputSpec[];
}

export function buildInputContract(program: PolicyProgram): InputContract {
  const defined = new Set(program.steps.flatMap((s) => (s.kind === 'assign' ? Object.keys(s.set) : [])));
  const reads = new Map<string, Set<string>>();
  for (const s of program.steps) {
    const exprs =
      s.kind === 'gate' ? [s.when] : s.kind === 'assign' ? Object.values(s.set) : [s.when ?? '', (s.amount ?? '').replace(/^=/, '')];
    for (const e of exprs) for (const id of identifiersIn(e)) reads.set(id, (reads.get(id) ?? new Set()).add(s.source.sentence));
    if (s.scope !== undefined) reads.set(s.scope.var, (reads.get(s.scope.var) ?? new Set()).add(s.source.sentence));
  }
  const inputs: InputSpec[] = program.facts
    .filter((f) => !defined.has(f.name) && reads.has(f.name))
    .map((f) => ({
      name: f.name,
      type: f.type,
      ...(f.enum !== undefined ? { enum: f.enum } : {}),
      description: f.description,
      how: f.derivable === true ? 'derived_from_text' : f.enum !== undefined ? 'classified' : 'case_field',
      usedBy: [...(reads.get(f.name) ?? [])],
      aliases: f.name.split('_').filter((w) => w.length > 2),
    }));
  return { title: program.title, inputs };
}

export type Transform =
  | 'as_is'
  | 'number'
  | 'yes_no'
  | 'negate'
  | 'lowercase'
  | { readonly atLeast: number }
  | { readonly greaterThan: number }
  | { readonly valueMap: Readonly<Record<string, string | number | boolean>> };

export type FieldSource = { readonly field: string; readonly transform?: Transform } | { readonly constant: string | number | boolean };
export type FieldMapping = Readonly<Record<string, FieldSource>>;

type Fact = string | number | boolean;

function applyTransform(value: unknown, t: Transform | undefined): Fact | undefined {
  if (value === undefined || value === null) return undefined;
  const tr = t ?? 'as_is';
  if (tr === 'as_is') return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : undefined;
  if (tr === 'number') {
    const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,]/g, ''));
    return Number.isFinite(n) ? n : undefined;
  }
  if (tr === 'yes_no') {
    const s = String(value).trim().toLowerCase();
    if (['yes', 'y', 'true', '1'].includes(s)) return true;
    if (['no', 'n', 'false', '0'].includes(s)) return false;
    return undefined;
  }
  if (tr === 'negate') return typeof value === 'boolean' ? !value : undefined;
  if (tr === 'lowercase') return String(value).trim().toLowerCase();
  if ('atLeast' in tr) return Number.isFinite(Number(value)) ? Number(value) >= tr.atLeast : undefined;
  if ('greaterThan' in tr) return Number.isFinite(Number(value)) ? Number(value) > tr.greaterThan : undefined;
  const v = tr.valueMap[String(value)];
  return v;
}

export interface BindResult {
  readonly facts: Record<string, Fact>;
  /** inputs with no usable value: the tree will report them missing and the case escalates */
  readonly missing: readonly string[];
  /** inputs whose value was present but outside the contract (wrong type / not an allowed value) */
  readonly invalid: readonly { readonly input: string; readonly reason: string }[];
}

/** Fills the contract's inputs from one case record through the operator's mapping. Never guesses. */
export function bindWithMapping(contract: InputContract, mapping: FieldMapping, record: Readonly<Record<string, unknown>>): BindResult {
  const facts: Record<string, Fact> = {};
  const missing: string[] = [];
  const invalid: { input: string; reason: string }[] = [];
  for (const spec of contract.inputs) {
    const src = mapping[spec.name];
    if (src === undefined) {
      missing.push(spec.name);
      continue;
    }
    const v = 'constant' in src ? src.constant : applyTransform(record[src.field], src.transform);
    if (v === undefined) {
      missing.push(spec.name);
      continue;
    }
    if (typeof v !== spec.type) {
      invalid.push({ input: spec.name, reason: `expected ${spec.type}, got ${typeof v}` });
      continue;
    }
    if (spec.enum !== undefined && !spec.enum.includes(String(v))) {
      invalid.push({ input: spec.name, reason: `“${String(v)}” is not one of ${spec.enum.join(', ')}` });
      continue;
    }
    facts[spec.name] = v;
  }
  return { facts, missing, invalid };
}

const tok = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );

export interface MappingSuggestion {
  readonly input: string;
  readonly field: string;
  readonly score: number;
}
/** Suggests (never applies) a field for each unmapped input by word overlap with the manual's phrasing. A person confirms. */
export function suggestMapping(contract: InputContract, fieldNames: readonly string[], mapping: FieldMapping = {}): MappingSuggestion[] {
  const out: MappingSuggestion[] = [];
  for (const spec of contract.inputs) {
    if (mapping[spec.name] !== undefined) continue;
    const want = new Set([...tok(spec.name), ...tok(spec.description)]);
    let best: MappingSuggestion | undefined;
    for (const f of fieldNames) {
      const have = tok(f);
      let shared = 0;
      for (const w of have) if (want.has(w)) shared++;
      const score = have.size === 0 ? 0 : shared / have.size;
      if (score > 0 && (best === undefined || score > best.score))
        best = { input: spec.name, field: f, score: Math.round(score * 100) / 100 };
    }
    if (best !== undefined) out.push(best);
  }
  return out;
}

/** One question per input that has no source yet — asked in the owner's words, with the manual sentences that use it. */
export function mappingQuestions(
  contract: InputContract,
  mapping: FieldMapping,
  suggestions: readonly MappingSuggestion[] = [],
): Question[] {
  return contract.inputs
    .filter((i) => mapping[i.name] === undefined)
    .map((i, n) => {
      const sug = suggestions.find((s) => s.input === i.name);
      return {
        id: `map-${n + 1}`,
        kind: 'map_input' as const,
        prompt: `Where does “${i.description}” come from in your systems? Name the field, or say it must be read from the case text.${i.enum ? ` It must be one of: ${i.enum.join(', ')}.` : ''}`,
        evidence: i.usedBy.slice(0, 2),
        ...(sug !== undefined ? { suggestion: sug.field } : {}),
        blocking: true,
        subject: i.name,
      };
    });
}
