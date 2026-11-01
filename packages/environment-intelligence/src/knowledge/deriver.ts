import { err, ok, type Result } from '@xo/types';
import type { Evidence, JsonValue } from '../evidence.js';
import { stableDigest } from '../ids.js';
import { MAX_IDENTIFIERS_PER_REF, validIdentifier } from './identifiers.js';
import {
  ENTITY_KINDS,
  KNOWLEDGE_KINDS,
  type Candidate,
  type ClaimOrigin,
  type EntityKind,
  type EntityRef,
  type Identifier,
  type KnowledgeKind,
  type Scalar,
} from './types.js';

/**
 * A deriver turns ONE evidence item into candidate statements. The contract is deliberately small so a model-backed deriver can be
 * plugged in later WITHOUT touching anything that enforces eligibility, access, provenance or conflicts:
 *  - PURE and DETERMINISTIC: the same evidence always yields the same candidates (this is what makes derivation idempotent);
 *  - no I/O, no clock, no network, no model call (the shipped deriver is fully deterministic and offline);
 *  - it sees only the evidence handed to it, which the service has already proven eligible and authorized for derivation;
 *  - its output is untrusted until the service has bounded and validated it (a deriver cannot invent provenance, principals or ids).
 */
export interface Deriver {
  readonly id: string;
  readonly version: string;
  derive(evidence: Evidence): Result<readonly Candidate[], DeriverRefusal>;
}

export type DeriverRefusal = 'unsupported_schema' | 'malformed' | 'limit_exceeded';

export const MAX_CANDIDATES_PER_EVIDENCE = 64;
const MAX_TEXT = 256;
const MAX_STEPS = 32;
const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z)?$/;

/** The payload convention the shipped deriver understands. Connectors that surface structured organizational records use it. */
export const STRUCTURED_RECORD_SCHEMA = 'ei.org-record.v1';

type Obj = { readonly [key: string]: JsonValue };
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = MAX_TEXT): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v : undefined;
const date = (v: unknown): string | undefined => (typeof v === 'string' && DATE.test(v) && Number.isFinite(Date.parse(v)) ? v : undefined);
const scalar = (v: unknown): Scalar | undefined =>
  typeof v === 'string' ? str(v) : typeof v === 'number' ? (Number.isFinite(v) ? v : undefined) : typeof v === 'boolean' ? v : undefined;

class Refuse extends Error {
  constructor(readonly reason: DeriverRefusal) {
    super(reason);
  }
}
const bad = (): never => {
  throw new Refuse('malformed');
};

/** `{ kind: 'person', ids: { email: 'a@x', employee_id: 'E1' } }` -> EntityRef. Anything else is malformed. */
function ref(v: unknown, expect?: EntityKind): EntityRef {
  if (!isObj(v)) return bad();
  const kind = v['kind'];
  const ids = v['ids'];
  if (typeof kind !== 'string' || !(ENTITY_KINDS as readonly string[]).includes(kind) || !isObj(ids)) return bad();
  if (expect !== undefined && kind !== expect) return bad();
  const identifiers: Identifier[] = Object.entries(ids)
    .map(([scheme, value]) => ({ scheme, value }))
    .filter((i): i is Identifier => typeof i.value === 'string');
  if (identifiers.length === 0 || identifiers.length > MAX_IDENTIFIERS_PER_REF || identifiers.length !== Object.keys(ids).length)
    return bad();
  if (!identifiers.every(validIdentifier)) return bad();
  return { kind: kind as EntityKind, identifiers };
}

const origin = (v: unknown, fallback: ClaimOrigin): ClaimOrigin => {
  if (v === undefined) return fallback;
  if (v === 'observed' || v === 'stated' || v === 'inferred') return v;
  return bad();
};

function validity(r: Obj): { validFrom?: string; validTo?: string } {
  const from = r['valid_from'];
  const to = r['valid_to'];
  if (from !== undefined && date(from) === undefined) bad();
  if (to !== undefined && date(to) === undefined) bad();
  if (typeof from === 'string' && typeof to === 'string' && Date.parse(to) < Date.parse(from)) bad();
  return { ...(typeof from === 'string' ? { validFrom: from } : {}), ...(typeof to === 'string' ? { validTo: to } : {}) };
}

function directoryEntry(r: Obj, out: Candidate[]): void {
  const person = ref(r['person'], 'person');
  const v = validity(r);
  out.push({ type: 'entity', ref: person });
  const title = r['title'];
  if (title !== undefined)
    out.push({ type: 'claim', kind: 'fact', subject: person, predicate: 'title', value: str(title) ?? bad(), origin: 'observed', ...v });
  if (r['team'] !== undefined) {
    const team = ref(r['team'], 'team');
    out.push(
      { type: 'entity', ref: team },
      { type: 'relationship', relation: 'belongs_to', from: person, to: team, origin: 'observed', ...v },
    );
  }
  if (r['manager'] !== undefined) {
    const manager = ref(r['manager'], 'person');
    out.push(
      { type: 'entity', ref: manager },
      { type: 'relationship', relation: 'manages', from: manager, to: person, origin: 'observed', ...v },
    );
  }
}

function message(r: Obj, out: Candidate[]): void {
  const from = ref(r['from'], 'person');
  const to = Array.isArray(r['to']) ? r['to'].map((t) => ref(t, 'person')) : [];
  out.push({ type: 'entity', ref: from }, ...to.map((t): Candidate => ({ type: 'entity', ref: t })));
  if (r['project'] !== undefined) {
    const project = ref(r['project'], 'project');
    out.push({ type: 'entity', ref: project });
    // A co-mention is an INFERENCE (candidate hypothesis), never an observed relationship, until independent sources corroborate it.
    for (const p of [from, ...to])
      out.push({ type: 'relationship', relation: 'associated_with', from: p, to: project, origin: 'inferred' });
  }
  const statements = r['statements'];
  if (statements !== undefined) {
    if (!Array.isArray(statements)) bad();
    for (const s of statements as readonly JsonValue[]) statement(s, out, 'stated');
  }
}

function workItem(r: Obj, out: Candidate[]): void {
  const project = ref(r['project'], 'project');
  const owner = ref(r['owner'], 'person');
  const v = validity(r);
  out.push(
    { type: 'entity', ref: project },
    { type: 'entity', ref: owner },
    { type: 'relationship', relation: 'owns', from: owner, to: project, origin: 'observed', ...v },
  );
  if (Array.isArray(r['depends_on']))
    for (const d of r['depends_on']) {
      const dep = ref(d, 'project');
      out.push(
        { type: 'entity', ref: dep },
        { type: 'relationship', relation: 'depends_on', from: project, to: dep, origin: 'observed', ...v },
      );
    }
  if (r['status'] !== undefined)
    out.push({
      type: 'claim',
      kind: 'fact',
      subject: project,
      predicate: 'status',
      value: str(r['status']) ?? bad(),
      origin: 'observed',
      ...v,
    });
}

function policyClause(r: Obj, out: Candidate[]): void {
  const subject = ref(r['subject']);
  const attribute = str(r['attribute']) ?? bad();
  const value = scalar(r['value']) ?? bad();
  const v = {
    ...(date(r['effective_from']) !== undefined ? { validFrom: r['effective_from'] as string } : {}),
    ...(date(r['effective_to']) !== undefined ? { validTo: r['effective_to'] as string } : {}),
  };
  if ((r['effective_from'] !== undefined && v.validFrom === undefined) || (r['effective_to'] !== undefined && v.validTo === undefined))
    bad();
  out.push(
    { type: 'entity', ref: subject },
    { type: 'claim', kind: 'policy', subject, predicate: attribute, value, origin: 'stated', ...v },
  );
  if (r['governs'] !== undefined) {
    const target = ref(r['governs']);
    out.push(
      { type: 'entity', ref: target },
      { type: 'relationship', relation: 'governs', from: subject, to: target, origin: 'stated', ...v },
    );
  }
}

function statement(s: JsonValue | undefined, out: Candidate[], fallback: ClaimOrigin): void {
  if (!isObj(s)) return bad();
  const kind = s['kind'];
  if (typeof kind !== 'string' || !(KNOWLEDGE_KINDS as readonly string[]).includes(kind)) return bad();
  const subject = ref(s['subject']);
  const predicate = str(s['predicate']) ?? bad();
  let value = scalar(s['value']);
  if (kind === 'procedure' && Array.isArray(s['steps'])) {
    const steps = s['steps'];
    if (steps.length === 0 || steps.length > MAX_STEPS || !steps.every((x) => str(x) !== undefined)) bad();
    value = stableDigest(['ei-procedure', ...(steps as readonly string[])]).slice(0, 24);
  }
  if (value === undefined) return bad();
  out.push(
    { type: 'entity', ref: subject },
    { type: 'claim', kind: kind as KnowledgeKind, subject, predicate, value, origin: origin(s['origin'], fallback), ...validity(s) },
  );
}

/** Shipped, deterministic, offline deriver for the `ei.org-record.v1` payload convention (directory / message / work item / policy clause / statement). */
export class StructuredRecordDeriver implements Deriver {
  readonly id = 'xo.ei.structured-record';
  readonly version = '1';

  derive(evidence: Evidence): Result<readonly Candidate[], DeriverRefusal> {
    const payload = evidence.payload;
    if (payload['schema'] !== STRUCTURED_RECORD_SCHEMA) return err('unsupported_schema');
    const record = payload['record'];
    if (!isObj(record)) return err('malformed');
    const out: Candidate[] = [];
    try {
      switch (record['type']) {
        case 'directory_entry':
          directoryEntry(record, out);
          break;
        case 'message':
          message(record, out);
          break;
        case 'work_item':
          workItem(record, out);
          break;
        case 'policy_clause':
          policyClause(record, out);
          break;
        case 'statement':
          statement(record, out, 'stated');
          break;
        default:
          return err('malformed');
      }
    } catch (e) {
      if (e instanceof Refuse) return err(e.reason);
      return err('malformed');
    }
    if (out.length > MAX_CANDIDATES_PER_EVIDENCE) return err('limit_exceeded');
    return ok(out);
  }
}
