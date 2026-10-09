import type { BenchmarkCaseDefinition, BenchmarkSuiteDefinition } from './definition.js';
import { compareStrings, fingerprintOf } from './json.js';
import { matchesName, normalizeText, type NameMatcher } from './match.js';
import { KNOWN_PRODUCER_VALUES } from './producer.js';

/**
 * P0.9C Step 3 — GOLDEN EXPECTATION PROVENANCE.
 *
 * The suites (`suites/*.suite.json`) are the golden expectations. They are
 * strict (unknown fields are rejected by `validateSuiteDefinition`) and are
 * deliberately NOT extended here: a register that lives NEXT to a suite says
 * why each expectation is believed, without touching what is evaluated.
 *
 * This is BENCHMARK ground-truth provenance, not runtime/XOIR provenance:
 * it never reads or writes a `ProvenanceRecord`, a source reference or a
 * node, and nothing in `evaluate.ts`, `metrics.ts`, `report.ts`,
 * `compare.ts` or `attribution.ts` imports it. It cannot change a metric,
 * an item, a fingerprint of any report, or a verdict.
 *
 * What it provides (all pure):
 *   - `parseGroundTruth`            strict structural validation of a register file;
 *   - `expectationsFingerprint`     a stable hash of a case's golden expectations, so an edit to ground truth is
 *                                   impossible to make silently (the register must be updated together with CHANGELOG.md);
 *   - `auditGroundTruth`            register <-> suite consistency (coverage, orphans, world model, fingerprint, forbidden evidence);
 *   - `auditExpectationIntegrity`   static lint of the suite itself (duplicate/contradictory/unsatisfiable expectations).
 */

export const GROUND_TRUTH_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type ExpectationCategory = 'fact' | 'forbidden_fact' | 'capability' | 'forbidden_capability' | 'workflow' | 'execution';
export const EXPECTATION_CATEGORIES: readonly ExpectationCategory[] = ['fact', 'forbidden_fact', 'capability', 'forbidden_capability', 'workflow', 'execution'];

/**
 * How firmly the FIXTURE (or existing documented benchmark evidence) supports an expectation. Descriptive, never numeric.
 *
 *   explicit            the source states it (a verbatim clause / declaration / hand-built graph definition).
 *   strongly_evidenced  the source clearly supports it, but its wording, name or shape is a normalisation of the source.
 *   derived             follows from the source only through a documented system rule (naming convention, execution-class
 *                       semantics, runtime input contract). Supportable, but not stated by the source.
 *   ambiguous           the fixture supports more than one reading; kept because removing it would be a judgment, flagged so.
 *   not_established     the fixture does not support it. Never valid on an expectation that is in the suite (it belongs in `unestablished`).
 */
export type EvidenceBasis = 'explicit' | 'strongly_evidenced' | 'derived' | 'ambiguous' | 'not_established';
export const EVIDENCE_BASES: readonly EvidenceBasis[] = ['explicit', 'strongly_evidenced', 'derived', 'ambiguous', 'not_established'];

export type GroundTruthWorldScope = 'facts' | 'capabilities' | 'workflows';
export type WorldDeclaration = 'open' | 'closed';
/**
 * Whether the fixture supports the world-model DECLARATION:
 *   supported                  the golden list is demonstrably complete for the closed scope (or the open scope is demonstrably partial).
 *   supported_by_construction  hand-built fixture: the author defined the whole population.
 *   questionable               a closed declaration the fixture does not fully support. REPORTED, never silently changed.
 *   not_declared               the suite makes no claim for this scope.
 */
export type WorldSupport = 'supported' | 'supported_by_construction' | 'questionable' | 'not_declared';
export const WORLD_SUPPORTS: readonly WorldSupport[] = ['supported', 'supported_by_construction', 'questionable', 'not_declared'];

/** Why something is NOT in the golden set. Never a failure and never a success. */
export type UnestablishedStatus = 'ambiguous' | 'not_established' | 'not_measurable' | 'open_world';
export const UNESTABLISHED_STATUSES: readonly UnestablishedStatus[] = ['ambiguous', 'not_established', 'not_measurable', 'open_world'];

export interface GroundTruthEntry {
  readonly category: ExpectationCategory;
  /** The expectation's own `id` in the suite. */
  readonly id: string;
  /** Basis of the expectation's IDENTITY (that the item exists / is forbidden / is requested). */
  readonly identity: EvidenceBasis;
  /** Basis of the ASSERTED properties (class, resolution, inputs, outputs, outcome …), when they differ from identity. */
  readonly assertions?: EvidenceBasis;
  /** Where in the fixture it comes from (clause / section / line / declaration). Must be a real locator, never invented. */
  readonly source: string;
  readonly note?: string;
}

export interface WorldAssessment {
  readonly scope: GroundTruthWorldScope;
  readonly declared: WorldDeclaration;
  /** For `facts`: the declared `closedWorldKinds`. */
  readonly kinds?: readonly string[];
  readonly support: WorldSupport;
  readonly justification: string;
}

export interface UnestablishedItem {
  readonly status: UnestablishedStatus;
  readonly topic: string;
  readonly note: string;
}

export interface GroundTruthCase {
  readonly caseId: string;
  /** How the golden expectations of this case were authored (from the suite description / CHANGELOG, not re-invented). */
  readonly authoring: string;
  /** `expectationsFingerprint(case)` at the time of the last audit. */
  readonly expectationsFingerprint: string;
  readonly world: readonly WorldAssessment[];
  readonly entries: readonly GroundTruthEntry[];
  readonly unestablished: readonly UnestablishedItem[];
}

export interface GroundTruthRegister {
  readonly schemaVersion: typeof GROUND_TRUTH_SCHEMA_VERSION;
  readonly suiteId: string;
  readonly cases: readonly GroundTruthCase[];
}

export interface GroundTruthIssue {
  readonly path: string;
  readonly message: string;
}
export type GroundTruthParseResult = { readonly ok: true; readonly value: GroundTruthRegister } | { readonly ok: false; readonly issues: readonly GroundTruthIssue[] };

// ---------------------------------------------------------------------------
// Strict parser (rejects unknown fields, wrong types, bad enums, duplicates)
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

class Checker {
  readonly issues: GroundTruthIssue[] = [];
  fail(path: string, message: string): void {
    this.issues.push({ path, message });
  }
  obj(v: unknown, path: string, allowed: readonly string[], required: readonly string[]): Obj | undefined {
    if (!isObj(v)) return void this.fail(path, 'must be an object');
    for (const k of Object.keys(v)) if (!allowed.includes(k)) this.fail(`${path}.${k}`, 'unknown field');
    for (const k of required) if (!(k in v)) this.fail(`${path}.${k}`, 'required');
    return v;
  }
  str(v: unknown, path: string, optional = false): string | undefined {
    if (v === undefined && optional) return undefined;
    if (typeof v !== 'string' || v.trim() === '') return void this.fail(path, 'must be a non-empty string');
    return v;
  }
  enm<T extends string>(v: unknown, path: string, allowed: readonly T[], optional = false): T | undefined {
    if (v === undefined && optional) return undefined;
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) return void this.fail(path, `must be one of ${allowed.join(' | ')}`);
    return v as T;
  }
  arr(v: unknown, path: string): unknown[] | undefined {
    if (!Array.isArray(v)) return void this.fail(path, 'must be an array');
    return v;
  }
}

export function parseGroundTruth(raw: unknown): GroundTruthParseResult {
  const c = new Checker();
  const root = c.obj(raw, '$', ['schemaVersion', 'suiteId', 'cases'], ['schemaVersion', 'suiteId', 'cases']);
  if (root === undefined) return { ok: false, issues: c.issues };
  if (root['schemaVersion'] !== GROUND_TRUTH_SCHEMA_VERSION) c.fail('$.schemaVersion', `must be ${GROUND_TRUTH_SCHEMA_VERSION}`);
  c.str(root['suiteId'], '$.suiteId');
  const caseIds = new Set<string>();
  c.arr(root['cases'], '$.cases')?.forEach((rc, i) => {
    const p = `$.cases[${i}]`;
    const o = c.obj(rc, p, ['caseId', 'authoring', 'expectationsFingerprint', 'world', 'entries', 'unestablished'], ['caseId', 'authoring', 'expectationsFingerprint', 'world', 'entries', 'unestablished']);
    if (o === undefined) return;
    const caseId = c.str(o['caseId'], `${p}.caseId`);
    if (caseId !== undefined) {
      if (caseIds.has(caseId)) c.fail(`${p}.caseId`, `duplicate caseId "${caseId}"`);
      caseIds.add(caseId);
    }
    c.str(o['authoring'], `${p}.authoring`);
    const fp = c.str(o['expectationsFingerprint'], `${p}.expectationsFingerprint`);
    if (fp !== undefined && !/^[0-9a-f]{16}$/.test(fp)) c.fail(`${p}.expectationsFingerprint`, 'must be 16 lowercase hex characters');

    const scopes = new Set<string>();
    c.arr(o['world'], `${p}.world`)?.forEach((rw, j) => {
      const wp = `${p}.world[${j}]`;
      const w = c.obj(rw, wp, ['scope', 'declared', 'kinds', 'support', 'justification'], ['scope', 'declared', 'support', 'justification']);
      if (w === undefined) return;
      const scope = c.enm<GroundTruthWorldScope>(w['scope'], `${wp}.scope`, ['facts', 'capabilities', 'workflows']);
      if (scope !== undefined) {
        if (scopes.has(scope)) c.fail(`${wp}.scope`, `duplicate world scope "${scope}"`);
        scopes.add(scope);
      }
      const declared = c.enm<WorldDeclaration>(w['declared'], `${wp}.declared`, ['open', 'closed']);
      const support = c.enm<WorldSupport>(w['support'], `${wp}.support`, WORLD_SUPPORTS);
      c.str(w['justification'], `${wp}.justification`);
      if (w['kinds'] !== undefined) {
        const ks = c.arr(w['kinds'], `${wp}.kinds`);
        ks?.forEach((k, n) => c.str(k, `${wp}.kinds[${n}]`));
        if (scope !== 'facts') c.fail(`${wp}.kinds`, 'only valid for scope "facts"');
      }
      if (declared === 'open' && support === 'supported_by_construction') c.fail(`${wp}.support`, 'an open scope cannot be "supported_by_construction"');
    });

    const seen = new Set<string>();
    c.arr(o['entries'], `${p}.entries`)?.forEach((re, j) => {
      const ep = `${p}.entries[${j}]`;
      const e = c.obj(re, ep, ['category', 'id', 'identity', 'assertions', 'source', 'note'], ['category', 'id', 'identity', 'source']);
      if (e === undefined) return;
      const category = c.enm<ExpectationCategory>(e['category'], `${ep}.category`, EXPECTATION_CATEGORIES);
      const id = c.str(e['id'], `${ep}.id`);
      const identity = c.enm<EvidenceBasis>(e['identity'], `${ep}.identity`, EVIDENCE_BASES);
      c.enm<EvidenceBasis>(e['assertions'], `${ep}.assertions`, EVIDENCE_BASES, true);
      c.str(e['source'], `${ep}.source`);
      c.str(e['note'], `${ep}.note`, true);
      if (identity === 'not_established') c.fail(`${ep}.identity`, '"not_established" cannot be the basis of an expectation that is in the suite — list it under "unestablished" instead');
      if (category !== undefined && id !== undefined) {
        const key = `${category}:${id}`;
        if (seen.has(key)) c.fail(ep, `duplicate entry for ${key}`);
        seen.add(key);
      }
    });

    c.arr(o['unestablished'], `${p}.unestablished`)?.forEach((ru, j) => {
      const up = `${p}.unestablished[${j}]`;
      const u = c.obj(ru, up, ['status', 'topic', 'note'], ['status', 'topic', 'note']);
      if (u === undefined) return;
      c.enm<UnestablishedStatus>(u['status'], `${up}.status`, UNESTABLISHED_STATUSES);
      c.str(u['topic'], `${up}.topic`);
      c.str(u['note'], `${up}.note`);
    });
  });
  return c.issues.length > 0 ? { ok: false, issues: c.issues } : { ok: true, value: root as unknown as GroundTruthRegister };
}

// ---------------------------------------------------------------------------
// Reading a suite's golden expectations
// ---------------------------------------------------------------------------

export interface ExpectationRef {
  readonly category: ExpectationCategory;
  readonly id: string;
}

/** Every golden expectation a case declares, sorted `(category, id)`. */
export function listExpectations(def: BenchmarkCaseDefinition): readonly ExpectationRef[] {
  const out: ExpectationRef[] = [];
  const e = def.expect;
  for (const f of e.semantics?.facts ?? []) out.push({ category: 'fact', id: f.id });
  for (const f of e.semantics?.forbidden ?? []) out.push({ category: 'forbidden_fact', id: f.id });
  for (const k of e.capabilities?.items ?? []) out.push({ category: 'capability', id: k.id });
  for (const k of e.capabilities?.forbidden ?? []) out.push({ category: 'forbidden_capability', id: k.id });
  for (const w of e.workflows?.items ?? []) out.push({ category: 'workflow', id: w.id });
  for (const x of def.execution ?? []) out.push({ category: 'execution', id: x.id });
  return out.sort((a, b) => compareStrings(`${a.category}|${a.id}`, `${b.category}|${b.id}`));
}

/** What the SUITE actually declares for each world scope (never inferred from the register). */
export function declaredWorld(def: BenchmarkCaseDefinition): { readonly facts: { readonly declared: WorldDeclaration; readonly kinds: readonly string[] }; readonly capabilities: WorldDeclaration; readonly workflows: WorldDeclaration } {
  const kinds = [...(def.expect.semantics?.closedWorldKinds ?? [])].sort(compareStrings);
  return {
    facts: { declared: kinds.length > 0 ? 'closed' : 'open', kinds },
    capabilities: def.expect.capabilities?.closedWorld === true ? 'closed' : 'open',
    workflows: def.expect.workflows?.closedWorld === true ? 'closed' : 'open',
  };
}

/**
 * Stable hash of a case's golden expectations (`expect` + `execution`). Sources, descriptions and ids of the case are excluded:
 * this pins WHAT IS EXPECTED, so changing an expectation cannot happen without also updating the register (and CHANGELOG.md).
 */
export function expectationsFingerprint(def: BenchmarkCaseDefinition): string {
  return fingerprintOf({ expect: def.expect, execution: def.execution ?? [] });
}

// ---------------------------------------------------------------------------
// Register <-> suite audit
// ---------------------------------------------------------------------------

export type GroundTruthFindingCode =
  | 'suite_id_mismatch'
  | 'case_missing_in_register'
  | 'case_orphan_in_register'
  | 'expectation_missing_in_register'
  | 'entry_orphan'
  | 'fingerprint_mismatch'
  | 'world_not_assessed'
  | 'world_mismatch'
  | 'questionable_world_without_note'
  | 'forbidden_without_evidence'
  | 'forbidden_without_reason';

export interface GroundTruthFinding {
  readonly code: GroundTruthFindingCode;
  readonly caseId?: string;
  readonly message: string;
}

export function auditGroundTruth(suite: BenchmarkSuiteDefinition, register: GroundTruthRegister): readonly GroundTruthFinding[] {
  const out: GroundTruthFinding[] = [];
  const add = (code: GroundTruthFindingCode, message: string, caseId?: string): void => void out.push(caseId === undefined ? { code, message } : { code, caseId, message });
  if (register.suiteId !== suite.suiteId) add('suite_id_mismatch', `register is for "${register.suiteId}", suite is "${suite.suiteId}"`);
  const registered = new Map(register.cases.map((c) => [c.caseId, c]));
  for (const def of suite.cases) if (!registered.has(def.caseId)) add('case_missing_in_register', `case "${def.caseId}" has no ground-truth register`, def.caseId);
  const suiteCases = new Map(suite.cases.map((c) => [c.caseId, c]));
  for (const rc of register.cases) if (!suiteCases.has(rc.caseId)) add('case_orphan_in_register', `register case "${rc.caseId}" is not in the suite`, rc.caseId);

  for (const def of suite.cases) {
    const rc = registered.get(def.caseId);
    if (rc === undefined) continue;
    const actual = listExpectations(def);
    const entries = new Map(rc.entries.map((e) => [`${e.category}|${e.id}`, e]));
    const actualKeys = new Set(actual.map((a) => `${a.category}|${a.id}`));
    for (const a of actual) if (!entries.has(`${a.category}|${a.id}`)) add('expectation_missing_in_register', `${a.category} "${a.id}" has no ground-truth entry`, def.caseId);
    for (const e of rc.entries) if (!actualKeys.has(`${e.category}|${e.id}`)) add('entry_orphan', `entry ${e.category} "${e.id}" matches no expectation in the suite`, def.caseId);

    const fp = expectationsFingerprint(def);
    if (fp !== rc.expectationsFingerprint) add('fingerprint_mismatch', `golden expectations changed (register ${rc.expectationsFingerprint}, suite ${fp}); re-audit the case, update the register and record the change in CHANGELOG.md`, def.caseId);

    // World model: the register must describe exactly what the suite declares, for every scope.
    const dw = declaredWorld(def);
    const wm = new Map(rc.world.map((w) => [w.scope, w]));
    for (const scope of ['facts', 'capabilities', 'workflows'] as const) {
      const w = wm.get(scope);
      if (w === undefined) {
        add('world_not_assessed', `world scope "${scope}" is not assessed`, def.caseId);
        continue;
      }
      const wantDeclared = scope === 'facts' ? dw.facts.declared : dw[scope];
      if (w.declared !== wantDeclared) add('world_mismatch', `${scope}: register says ${w.declared}, suite declares ${wantDeclared}`, def.caseId);
      if (scope === 'facts' && JSON.stringify([...(w.kinds ?? [])].sort(compareStrings)) !== JSON.stringify(dw.facts.kinds)) add('world_mismatch', `facts: register kinds ${JSON.stringify(w.kinds ?? [])}, suite closedWorldKinds ${JSON.stringify(dw.facts.kinds)}`, def.caseId);
      if (w.support === 'questionable' && w.justification.trim().length < 40) add('questionable_world_without_note', `${scope}: a questionable world declaration needs a substantive justification`, def.caseId);
    }

    // A forbidden expectation must be evidence-based: a stated reason in the suite and firm support in the register.
    for (const f of def.expect.semantics?.forbidden ?? []) if (f.reason === undefined || f.reason.trim() === '') add('forbidden_without_reason', `forbidden fact "${f.id}" states no reason`, def.caseId);
    for (const f of def.expect.capabilities?.forbidden ?? []) if (f.reason === undefined || f.reason.trim() === '') add('forbidden_without_reason', `forbidden capability "${f.id}" states no reason`, def.caseId);
    for (const e of rc.entries) {
      if ((e.category === 'forbidden_fact' || e.category === 'forbidden_capability') && e.identity !== 'explicit' && e.identity !== 'strongly_evidenced') add('forbidden_without_evidence', `${e.category} "${e.id}" has identity basis "${e.identity}"; a forbidden expectation must be explicit or strongly evidenced`, def.caseId);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Static integrity lint of the suite itself
// ---------------------------------------------------------------------------

export type IntegrityCode = 'duplicate_matcher' | 'forbidden_contradicts_expected' | 'name_matcher_punctuation' | 'unknown_expected_producer';

export interface IntegrityFinding {
  readonly code: IntegrityCode;
  readonly caseId: string;
  readonly message: string;
}

const matcherText = (m: NameMatcher): string => ('equals' in m ? m.equals : m.contains);

/**
 * Characters capability names never contain when they are derived from document text: `rule-based-extractor` strips punctuation from
 * object words (documented in CHANGELOG.md, Layer 1B). A name matcher containing one can never match any implementation — the defect
 * fixed in the `t3.4-reconcile-invoice-vs-receipt` expectation and, in Step 3, in the `wf-reconciliation-tasks` step. Structured /
 * OpenAPI sources keep their own identifiers verbatim and are not linted.
 */
const NAME_STRIPPED_CHARS = /[.,:;()"'!?]/;
const TEXT_SOURCE_KINDS = new Set(['pdf', 'document', 'html', 'image']);

export function auditExpectationIntegrity(suite: BenchmarkSuiteDefinition): readonly IntegrityFinding[] {
  const out: IntegrityFinding[] = [];
  for (const def of suite.cases) {
    const add = (code: IntegrityCode, message: string): void => void out.push({ code, caseId: def.caseId, message });
    const e = def.expect;

    // Two expectations of one category with the same identity would double-claim one observed item.
    const dup = <T>(items: readonly T[], key: (t: T) => string, idOf: (t: T) => string, label: string): void => {
      const by = new Map<string, string[]>();
      for (const it of items) by.set(key(it), [...(by.get(key(it)) ?? []), idOf(it)]);
      for (const [k, ids] of by) if (ids.length > 1) add('duplicate_matcher', `${label} ${ids.map((i) => `"${i}"`).join(', ')} share the identical matcher ${k}`);
    };
    dup(e.capabilities?.items ?? [], (k) => JSON.stringify(normalizeMatcher(k.name)), (k) => k.id, 'capabilities');
    dup(e.capabilities?.forbidden ?? [], (k) => JSON.stringify(normalizeMatcher(k.name)), (k) => k.id, 'forbidden capabilities');
    dup(e.semantics?.facts ?? [], (f) => JSON.stringify([f.kind, f.identify.map((p) => [p.path, normalizeDeepText(p)]).sort()]), (f) => f.id, 'facts');
    dup(e.semantics?.forbidden ?? [], (f) => JSON.stringify([f.kind, f.identify.map((p) => [p.path, normalizeDeepText(p)]).sort()]), (f) => f.id, 'forbidden facts');
    dup(e.workflows?.items ?? [], (w) => JSON.stringify(w.steps.map(normalizeMatcher).map((m) => JSON.stringify(m)).sort()), (w) => w.id, 'workflows');

    // A forbidden trap that an expected item's matcher would also accept makes the two contradict each other.
    for (const trap of e.capabilities?.forbidden ?? []) {
      for (const exp of e.capabilities?.items ?? []) {
        if (matchesName(matcherText(trap.name), exp.name)) add('forbidden_contradicts_expected', `forbidden capability "${trap.id}" (${JSON.stringify(matcherText(trap.name))}) would satisfy expected capability "${exp.id}"`);
      }
    }

    // P0.9C Step 4: an expected producer must be a value the pipeline can actually stamp (`producer.ts` taxonomy). `ai` is stampable but
    // AI is never exercised, so an `ai` expectation could only ever be outside the assertion; it is still a real producer value.
    for (const k of e.capabilities?.items ?? []) {
      if (k.producedBy !== undefined && !KNOWN_PRODUCER_VALUES.includes(k.producedBy)) add('unknown_expected_producer', `capability "${k.id}" expects producedBy ${JSON.stringify(k.producedBy)}, which is not a producer value the pipeline stamps (${KNOWN_PRODUCER_VALUES.join(', ')})`);
    }

    // Unsatisfiable name matchers (text sources only).
    if ((def.sources ?? []).length > 0 && (def.sources ?? []).every((s) => TEXT_SOURCE_KINDS.has(s.kind))) {
      const check = (where: string, m: NameMatcher): void => {
        const text = matcherText(m);
        if (NAME_STRIPPED_CHARS.test(text)) add('name_matcher_punctuation', `${where} matcher ${JSON.stringify(text)} contains punctuation that capability names derived from document text never contain`);
      };
      for (const k of e.capabilities?.items ?? []) check(`capability "${k.id}"`, k.name);
      for (const k of e.capabilities?.forbidden ?? []) check(`forbidden capability "${k.id}"`, k.name);
      for (const w of e.workflows?.items ?? []) {
        w.steps.forEach((s, i) => check(`workflow "${w.id}" step ${i + 1}`, s));
        for (const b of w.dataFlow?.bindings ?? []) {
          check(`workflow "${w.id}" binding producer`, b.producer);
          check(`workflow "${w.id}" binding consumer`, b.consumer);
        }
      }
      for (const x of def.execution ?? []) {
        if (x.kind === 'capability') check(`execution "${x.id}" target`, x.target);
        else x.steps.forEach((s, i) => check(`execution "${x.id}" step ${i + 1}`, s));
      }
    }
  }
  return out.sort((a, b) => compareStrings(`${a.caseId}|${a.code}|${a.message}`, `${b.caseId}|${b.code}|${b.message}`));
}

function normalizeMatcher(m: NameMatcher): { readonly equals: string } | { readonly contains: string } {
  return 'equals' in m ? { equals: normalizeText(m.equals) } : { contains: normalizeText(m.contains) };
}

function normalizeDeepText(p: { readonly equals?: unknown; readonly contains?: string; readonly exists?: boolean }): unknown {
  if (p.contains !== undefined) return ['contains', normalizeText(p.contains)];
  if (p.exists !== undefined) return ['exists', p.exists];
  return ['equals', typeof p.equals === 'string' ? normalizeText(p.equals) : p.equals];
}
