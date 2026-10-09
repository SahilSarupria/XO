import { isPlainObject } from './json.js';
import type { NameMatcher, Predicate } from './match.js';

/**
 * The benchmark DEFINITION data model — what a human says XO SHOULD
 * produce for a given source, authored as plain JSON and validated by
 * {@link validateSuiteDefinition}. Nothing here observes the pipeline;
 * see `observation.ts` for what actually happened and `evaluate.ts` for
 * the comparison.
 *
 * Two deliberate modeling choices:
 *
 *   1. OPEN vs CLOSED world, stated per dimension. A list of expected
 *      items is only a complete ground truth when the author says so
 *      (`closedWorld: true` / `closedWorldKinds`). Only then can
 *      "anything else the pipeline produced" be called unexpected and a
 *      PRECISION be computed. Without it, precision is reported as "not
 *      measurable" (`null`), never silently 100%.
 *   2. Identity vs assertion. An expected item is FOUND by `identify`
 *      predicates (which item is this?) and then judged by `assert`
 *      predicates / attribute expectations (is it right?). Identity
 *      matched but assertion failed = semantically INCORRECT — a
 *      different failure from MISSING.
 */

export const SUITE_SCHEMA_VERSION = 1 as const;

export type SourceKind = 'pdf' | 'document' | 'html' | 'structured' | 'openapi' | 'image';
export const SOURCE_KINDS: readonly SourceKind[] = ['pdf', 'document', 'html', 'structured', 'openapi', 'image'];

export interface SourceSpec {
  /** Explicit `@xo/compiler` source-input discriminant — the case states HOW the file is ingested, so no extension sniffing lives here. */
  readonly kind: SourceKind;
  /** Relative to the suite's `sourceRoot`; recorded verbatim as the compiler's `sourcePath` (so provenance `documentPath` is machine-independent). */
  readonly path: string;
  /** Required iff `kind === 'structured'`. */
  readonly format?: 'json' | 'csv';
}

export interface EvidenceSpec {
  /** Default 1 when an `evidence` block is present. */
  readonly minSourceRefs?: number;
  /** The item must cite a source whose documentPath ends with this string. */
  readonly documentPath?: string;
  /** Every listed page must be cited by some source ref of the item. */
  readonly pages?: readonly number[];
}

export interface FactExpectation {
  readonly id: string;
  /** XOIR node kind (`decision_node`, `heuristic`, `constraint`, `concept`, ...). */
  readonly kind: string;
  readonly identify: readonly Predicate[];
  readonly assert?: readonly Predicate[];
  readonly evidence?: EvidenceSpec;
}

export interface ForbiddenFact {
  readonly id: string;
  readonly kind: string;
  readonly identify: readonly Predicate[];
  readonly reason?: string;
}

export type Resolution = 'resolved' | 'unresolved' | 'ambiguous' | 'denied';
export const RESOLUTIONS: readonly Resolution[] = ['resolved', 'unresolved', 'ambiguous', 'denied'];

/** `not_executable` = the capability has no lowered executable declaration (unresolved / ambiguous / denied / resolved-but-not-promoted). */
export type ExpectedExecutionClass = 'deterministic_rule' | 'human_in_the_loop' | 'not_executable';
export const EXPECTED_EXECUTION_CLASSES: readonly ExpectedExecutionClass[] = ['deterministic_rule', 'human_in_the_loop', 'not_executable'];

export interface CapabilityExpectation {
  readonly id: string;
  readonly name: NameMatcher;
  readonly resolution?: Resolution;
  readonly executionClass?: ExpectedExecutionClass;
  /** Declared/derived input parameter names (compared as a set, against contract parameter names OR their runtime keys). */
  readonly inputs?: readonly string[];
  readonly outputs?: readonly string[];
  readonly evidence?: EvidenceSpec;
  /**
   * P0.9C Step 4: the EXPECTED `producedBy` of the capability's XOIR node — asserted only where the creating extractor is
   * objectively determined (e.g. a structured / OpenAPI source is lowered by the `structured-operation` extractor). Compared only
   * when the located capability was created by a capability extractor (see `producer.ts`); never inferred from the observation.
   */
  readonly producedBy?: string;
}

export interface ForbiddenCapability {
  readonly id: string;
  readonly name: NameMatcher;
  readonly reason?: string;
}

export type WorkflowExecutability = 'executable_candidate' | 'not_executable_yet' | 'semantically_invalid';
export const WORKFLOW_EXECUTABILITIES: readonly WorkflowExecutability[] = ['executable_candidate', 'not_executable_yet', 'semantically_invalid'];

export interface DataFlowExpectation {
  readonly producer: NameMatcher;
  readonly output: string;
  readonly consumer: NameMatcher;
  readonly input: string;
  /** `proven`: the existing data-flow audit must report a PROVEN producer->consumer binding. `not_proven`: it must NOT (guards against fabricated bindings). */
  readonly status: 'proven' | 'not_proven';
}

export interface WorkflowExpectation {
  readonly id: string;
  /** Identity: the workflow's steps must be exactly this set (perfect matching), independent of order. */
  readonly steps: readonly NameMatcher[];
  /** When true, the observed step ORDER must equal `steps` order. */
  readonly ordered?: boolean;
  readonly executability?: WorkflowExecutability;
  /** Per-step execution classes in order; requires `ordered: true`. */
  readonly stepClasses?: readonly ExpectedExecutionClass[];
  readonly dataFlow?: { readonly closedWorld?: boolean; readonly bindings: readonly DataFlowExpectation[] };
}

export type ExpectedCapabilityOutcome = 'succeeded' | 'waiting_for_human' | 'not_executable' | 'invalid_input' | 'error';
export const EXPECTED_CAPABILITY_OUTCOMES: readonly ExpectedCapabilityOutcome[] = ['succeeded', 'waiting_for_human', 'not_executable', 'invalid_input', 'error'];

export interface CapabilityExecutionCase {
  readonly id: string;
  readonly kind: 'capability';
  readonly target: NameMatcher;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly expect: {
    readonly outcome: ExpectedCapabilityOutcome;
    /** Subset match (normalized) against the capability's actual output. */
    readonly output?: Readonly<Record<string, unknown>>;
    readonly errorCode?: string;
  };
}

export type ExpectedWorkflowRunStatus = 'completed' | 'waiting_for_human' | 'not_executable_yet' | 'failed';
export const EXPECTED_WORKFLOW_RUN_STATUSES: readonly ExpectedWorkflowRunStatus[] = ['completed', 'waiting_for_human', 'not_executable_yet', 'failed'];

export interface WorkflowExecutionCase {
  readonly id: string;
  readonly kind: 'workflow';
  readonly steps: readonly NameMatcher[];
  readonly input?: Readonly<Record<string, unknown>>;
  readonly expect: {
    readonly status: ExpectedWorkflowRunStatus;
    readonly steps?: readonly { readonly capability: NameMatcher; readonly outputStatus?: string; readonly output?: Readonly<Record<string, unknown>> }[];
    /** Producer values the RUNTIME must actually have injected into consumer inputs. */
    readonly injections?: readonly { readonly producer: NameMatcher; readonly output: string; readonly consumer: NameMatcher; readonly input: string }[];
  };
}

export type ExecutionCase = CapabilityExecutionCase | WorkflowExecutionCase;

export interface CaseExpectations {
  readonly compile?: { readonly outcome: 'succeeds' | 'fails'; readonly errorCode?: string };
  readonly semantics?: {
    /** XOIR kinds for which `facts` is a COMPLETE list. Observed nodes of these kinds that no fact claims are `unexpected`. */
    readonly closedWorldKinds?: readonly string[];
    readonly facts?: readonly FactExpectation[];
    readonly forbidden?: readonly ForbiddenFact[];
  };
  readonly capabilities?: {
    readonly closedWorld?: boolean;
    readonly items?: readonly CapabilityExpectation[];
    readonly forbidden?: readonly ForbiddenCapability[];
  };
  readonly workflows?: { readonly closedWorld?: boolean; readonly items?: readonly WorkflowExpectation[] };
}

export interface BenchmarkCaseDefinition {
  readonly caseId: string;
  readonly description?: string;
  /** Exactly one of `sources` / `xoir`. `xoir` enters the REAL pipeline at the graph stage (packaging/contracts/workflows/runtime), skipping only source ingestion — used for hand-built fixtures no real source can currently produce. */
  readonly sources?: readonly SourceSpec[];
  readonly xoir?: string;
  readonly domainHint?: string;
  readonly expect: CaseExpectations;
  readonly execution?: readonly ExecutionCase[];
}

export interface BenchmarkSuiteDefinition {
  readonly schemaVersion: typeof SUITE_SCHEMA_VERSION;
  readonly suiteId: string;
  readonly description?: string;
  /** Directory (relative to the suite file) that case `path`s are resolved against. Default: the suite file's own directory. */
  readonly sourceRoot?: string;
  readonly cases: readonly BenchmarkCaseDefinition[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface DefinitionIssue {
  readonly path: string;
  readonly message: string;
}

export type DefinitionResult = { readonly ok: true; readonly value: BenchmarkSuiteDefinition } | { readonly ok: false; readonly issues: readonly DefinitionIssue[] };

class Validator {
  readonly issues: DefinitionIssue[] = [];

  fail(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  obj(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> | undefined {
    if (!isPlainObject(value)) {
      this.fail(path, 'must be an object');
      return undefined;
    }
    for (const key of Object.keys(value)) if (!allowed.includes(key)) this.fail(`${path}.${key}`, `unknown field (allowed: ${allowed.join(', ')})`);
    return value;
  }

  str(value: unknown, path: string, opts: { optional?: boolean } = {}): string | undefined {
    if (value === undefined && opts.optional) return undefined;
    if (typeof value !== 'string' || value.trim().length === 0) {
      this.fail(path, 'must be a non-empty string');
      return undefined;
    }
    return value;
  }

  bool(value: unknown, path: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') {
      this.fail(path, 'must be a boolean');
      return undefined;
    }
    return value;
  }

  oneOf<T extends string>(value: unknown, path: string, options: readonly T[], opts: { optional?: boolean } = {}): T | undefined {
    if (value === undefined && opts.optional) return undefined;
    if (typeof value !== 'string' || !options.includes(value as T)) {
      this.fail(path, `must be one of: ${options.join(', ')}`);
      return undefined;
    }
    return value as T;
  }

  arr(value: unknown, path: string, opts: { optional?: boolean; min?: number } = {}): unknown[] | undefined {
    if (value === undefined && opts.optional) return undefined;
    if (!Array.isArray(value)) {
      this.fail(path, 'must be an array');
      return undefined;
    }
    if (opts.min !== undefined && value.length < opts.min) this.fail(path, `must contain at least ${opts.min} item(s)`);
    return value;
  }

  strList(value: unknown, path: string, opts: { optional?: boolean } = {}): string[] | undefined {
    const list = this.arr(value, path, opts);
    if (list === undefined) return undefined;
    const out: string[] = [];
    list.forEach((v, i) => {
      const s = this.str(v, `${path}[${i}]`);
      if (s !== undefined) out.push(s);
    });
    return out;
  }

  uniqueIds(items: readonly { readonly id: string }[], path: string): void {
    const seen = new Set<string>();
    items.forEach((item, i) => {
      if (seen.has(item.id)) this.fail(`${path}[${i}].id`, `duplicate id "${item.id}"`);
      seen.add(item.id);
    });
  }
}

function matcher(v: Validator, value: unknown, path: string): NameMatcher | undefined {
  const o = v.obj(value, path, ['equals', 'contains']);
  if (o === undefined) return undefined;
  const hasEquals = o['equals'] !== undefined;
  const hasContains = o['contains'] !== undefined;
  if (hasEquals === hasContains) {
    v.fail(path, 'must have exactly one of "equals" or "contains"');
    return undefined;
  }
  if (hasEquals) {
    const s = v.str(o['equals'], `${path}.equals`);
    return s === undefined ? undefined : { equals: s };
  }
  const s = v.str(o['contains'], `${path}.contains`);
  return s === undefined ? undefined : { contains: s };
}

function matcherList(v: Validator, value: unknown, path: string, min = 1): NameMatcher[] | undefined {
  const list = v.arr(value, path, { min });
  if (list === undefined) return undefined;
  const out: NameMatcher[] = [];
  list.forEach((item, i) => {
    const m = matcher(v, item, `${path}[${i}]`);
    if (m !== undefined) out.push(m);
  });
  return out;
}

function predicate(v: Validator, value: unknown, path: string): Predicate | undefined {
  const o = v.obj(value, path, ['path', 'equals', 'contains', 'exists']);
  if (o === undefined) return undefined;
  const p = v.str(o['path'], `${path}.path`);
  const kinds = ['equals', 'contains', 'exists'].filter((k) => o[k] !== undefined);
  if (kinds.length !== 1) {
    v.fail(path, 'must have exactly one of "equals", "contains", "exists"');
    return undefined;
  }
  if (p === undefined) return undefined;
  if (o['contains'] !== undefined && typeof o['contains'] !== 'string') {
    v.fail(`${path}.contains`, 'must be a string');
    return undefined;
  }
  if (o['exists'] !== undefined && typeof o['exists'] !== 'boolean') {
    v.fail(`${path}.exists`, 'must be a boolean');
    return undefined;
  }
  return { path: p, ...(o['equals'] !== undefined ? { equals: o['equals'] } : {}), ...(o['contains'] !== undefined ? { contains: o['contains'] as string } : {}), ...(o['exists'] !== undefined ? { exists: o['exists'] as boolean } : {}) };
}

function predicateList(v: Validator, value: unknown, path: string, opts: { optional?: boolean; min?: number } = {}): Predicate[] | undefined {
  const list = v.arr(value, path, opts);
  if (list === undefined) return undefined;
  const out: Predicate[] = [];
  list.forEach((item, i) => {
    const p = predicate(v, item, `${path}[${i}]`);
    if (p !== undefined) out.push(p);
  });
  return out;
}

function evidence(v: Validator, value: unknown, path: string): EvidenceSpec | undefined {
  if (value === undefined) return undefined;
  const o = v.obj(value, path, ['minSourceRefs', 'documentPath', 'pages']);
  if (o === undefined) return undefined;
  if (o['minSourceRefs'] !== undefined && (typeof o['minSourceRefs'] !== 'number' || !Number.isInteger(o['minSourceRefs']) || o['minSourceRefs'] < 0)) v.fail(`${path}.minSourceRefs`, 'must be a non-negative integer');
  const documentPath = v.str(o['documentPath'], `${path}.documentPath`, { optional: true });
  let pages: number[] | undefined;
  if (o['pages'] !== undefined) {
    const list = v.arr(o['pages'], `${path}.pages`);
    if (list !== undefined) {
      pages = [];
      list.forEach((p, i) => {
        if (typeof p !== 'number' || !Number.isInteger(p) || p < 1) v.fail(`${path}.pages[${i}]`, 'must be a positive integer page number');
        else pages!.push(p);
      });
    }
  }
  return { ...(typeof o['minSourceRefs'] === 'number' ? { minSourceRefs: o['minSourceRefs'] } : {}), ...(documentPath !== undefined ? { documentPath } : {}), ...(pages !== undefined ? { pages } : {}) };
}

function objectOf(v: Validator, value: unknown, path: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    v.fail(path, 'must be an object');
    return undefined;
  }
  return value;
}

function validateFacts(v: Validator, value: unknown, path: string): FactExpectation[] | undefined {
  const list = v.arr(value, path, { optional: true });
  if (list === undefined) return undefined;
  const out: FactExpectation[] = [];
  list.forEach((item, i) => {
    const p = `${path}[${i}]`;
    const o = v.obj(item, p, ['id', 'kind', 'identify', 'assert', 'evidence']);
    if (o === undefined) return;
    const id = v.str(o['id'], `${p}.id`);
    const kind = v.str(o['kind'], `${p}.kind`);
    const identify = predicateList(v, o['identify'], `${p}.identify`, { min: 1 });
    const assertions = predicateList(v, o['assert'], `${p}.assert`, { optional: true });
    const ev = evidence(v, o['evidence'], `${p}.evidence`);
    if (id !== undefined && kind !== undefined && identify !== undefined) out.push({ id, kind, identify, ...(assertions !== undefined ? { assert: assertions } : {}), ...(ev !== undefined ? { evidence: ev } : {}) });
  });
  v.uniqueIds(out, path);
  return out;
}

function validateForbiddenFacts(v: Validator, value: unknown, path: string): ForbiddenFact[] | undefined {
  const list = v.arr(value, path, { optional: true });
  if (list === undefined) return undefined;
  const out: ForbiddenFact[] = [];
  list.forEach((item, i) => {
    const p = `${path}[${i}]`;
    const o = v.obj(item, p, ['id', 'kind', 'identify', 'reason']);
    if (o === undefined) return;
    const id = v.str(o['id'], `${p}.id`);
    const kind = v.str(o['kind'], `${p}.kind`);
    const identify = predicateList(v, o['identify'], `${p}.identify`, { min: 1 });
    const reason = v.str(o['reason'], `${p}.reason`, { optional: true });
    if (id !== undefined && kind !== undefined && identify !== undefined) out.push({ id, kind, identify, ...(reason !== undefined ? { reason } : {}) });
  });
  v.uniqueIds(out, path);
  return out;
}

function validateCapabilities(v: Validator, value: unknown, path: string): CaseExpectations['capabilities'] | undefined {
  if (value === undefined) return undefined;
  const o = v.obj(value, path, ['closedWorld', 'items', 'forbidden']);
  if (o === undefined) return undefined;
  const closedWorld = v.bool(o['closedWorld'], `${path}.closedWorld`);
  const items: CapabilityExpectation[] = [];
  const rawItems = v.arr(o['items'], `${path}.items`, { optional: true });
  rawItems?.forEach((item, i) => {
    const p = `${path}.items[${i}]`;
    const c = v.obj(item, p, ['id', 'name', 'resolution', 'executionClass', 'inputs', 'outputs', 'evidence', 'producedBy']);
    if (c === undefined) return;
    const id = v.str(c['id'], `${p}.id`);
    const name = matcher(v, c['name'], `${p}.name`);
    const resolution = v.oneOf(c['resolution'], `${p}.resolution`, RESOLUTIONS, { optional: true });
    const executionClass = v.oneOf(c['executionClass'], `${p}.executionClass`, EXPECTED_EXECUTION_CLASSES, { optional: true });
    const inputs = v.strList(c['inputs'], `${p}.inputs`, { optional: true });
    const outputs = v.strList(c['outputs'], `${p}.outputs`, { optional: true });
    const ev = evidence(v, c['evidence'], `${p}.evidence`);
    const producedBy = v.str(c['producedBy'], `${p}.producedBy`, { optional: true });
    if (resolution !== undefined && executionClass !== undefined && resolution !== 'resolved' && executionClass !== 'not_executable') v.fail(p, `resolution "${resolution}" is incompatible with executionClass "${executionClass}" (only a resolved capability can have an executable class)`);
    if (id !== undefined && name !== undefined) {
      items.push({ id, name, ...(resolution !== undefined ? { resolution } : {}), ...(executionClass !== undefined ? { executionClass } : {}), ...(inputs !== undefined ? { inputs } : {}), ...(outputs !== undefined ? { outputs } : {}), ...(ev !== undefined ? { evidence: ev } : {}), ...(producedBy !== undefined ? { producedBy } : {}) });
    }
  });
  v.uniqueIds(items, `${path}.items`);
  const forbidden: ForbiddenCapability[] = [];
  v.arr(o['forbidden'], `${path}.forbidden`, { optional: true })?.forEach((item, i) => {
    const p = `${path}.forbidden[${i}]`;
    const f = v.obj(item, p, ['id', 'name', 'reason']);
    if (f === undefined) return;
    const id = v.str(f['id'], `${p}.id`);
    const name = matcher(v, f['name'], `${p}.name`);
    const reason = v.str(f['reason'], `${p}.reason`, { optional: true });
    if (id !== undefined && name !== undefined) forbidden.push({ id, name, ...(reason !== undefined ? { reason } : {}) });
  });
  v.uniqueIds(forbidden, `${path}.forbidden`);
  return { ...(closedWorld !== undefined ? { closedWorld } : {}), items, ...(forbidden.length > 0 ? { forbidden } : {}) };
}

function validateWorkflows(v: Validator, value: unknown, path: string): CaseExpectations['workflows'] | undefined {
  if (value === undefined) return undefined;
  const o = v.obj(value, path, ['closedWorld', 'items']);
  if (o === undefined) return undefined;
  const closedWorld = v.bool(o['closedWorld'], `${path}.closedWorld`);
  const items: WorkflowExpectation[] = [];
  v.arr(o['items'], `${path}.items`, { optional: true })?.forEach((item, i) => {
    const p = `${path}.items[${i}]`;
    const w = v.obj(item, p, ['id', 'steps', 'ordered', 'executability', 'stepClasses', 'dataFlow']);
    if (w === undefined) return;
    const id = v.str(w['id'], `${p}.id`);
    const steps = matcherList(v, w['steps'], `${p}.steps`);
    const ordered = v.bool(w['ordered'], `${p}.ordered`);
    const executability = v.oneOf(w['executability'], `${p}.executability`, WORKFLOW_EXECUTABILITIES, { optional: true });
    let stepClasses: ExpectedExecutionClass[] | undefined;
    if (w['stepClasses'] !== undefined) {
      const list = v.arr(w['stepClasses'], `${p}.stepClasses`);
      if (list !== undefined) {
        stepClasses = [];
        list.forEach((c, j) => {
          const cls = v.oneOf(c, `${p}.stepClasses[${j}]`, EXPECTED_EXECUTION_CLASSES);
          if (cls !== undefined) stepClasses!.push(cls);
        });
        if (ordered !== true) v.fail(`${p}.stepClasses`, 'requires "ordered": true (classes are positional)');
        if (steps !== undefined && stepClasses.length !== steps.length) v.fail(`${p}.stepClasses`, `must have one class per step (${steps.length})`);
      }
    }
    let dataFlow: WorkflowExpectation['dataFlow'];
    if (w['dataFlow'] !== undefined) {
      const d = v.obj(w['dataFlow'], `${p}.dataFlow`, ['closedWorld', 'bindings']);
      if (d !== undefined) {
        const dfClosed = v.bool(d['closedWorld'], `${p}.dataFlow.closedWorld`);
        const bindings: DataFlowExpectation[] = [];
        v.arr(d['bindings'], `${p}.dataFlow.bindings`)?.forEach((b, j) => {
          const bp = `${p}.dataFlow.bindings[${j}]`;
          const bo = v.obj(b, bp, ['producer', 'output', 'consumer', 'input', 'status']);
          if (bo === undefined) return;
          const producer = matcher(v, bo['producer'], `${bp}.producer`);
          const output = v.str(bo['output'], `${bp}.output`);
          const consumer = matcher(v, bo['consumer'], `${bp}.consumer`);
          const input = v.str(bo['input'], `${bp}.input`);
          const status = v.oneOf(bo['status'], `${bp}.status`, ['proven', 'not_proven'] as const);
          if (producer && output !== undefined && consumer && input !== undefined && status) bindings.push({ producer, output, consumer, input, status });
        });
        dataFlow = { ...(dfClosed !== undefined ? { closedWorld: dfClosed } : {}), bindings };
      }
    }
    if (id !== undefined && steps !== undefined) {
      items.push({ id, steps, ...(ordered !== undefined ? { ordered } : {}), ...(executability !== undefined ? { executability } : {}), ...(stepClasses !== undefined ? { stepClasses } : {}), ...(dataFlow !== undefined ? { dataFlow } : {}) });
    }
  });
  v.uniqueIds(items, `${path}.items`);
  return { ...(closedWorld !== undefined ? { closedWorld } : {}), items };
}

function validateExecution(v: Validator, value: unknown, path: string): ExecutionCase[] | undefined {
  const list = v.arr(value, path, { optional: true });
  if (list === undefined) return undefined;
  const out: ExecutionCase[] = [];
  list.forEach((item, i) => {
    const p = `${path}[${i}]`;
    if (!isPlainObject(item)) {
      v.fail(p, 'must be an object');
      return;
    }
    const kind = v.oneOf(item['kind'], `${p}.kind`, ['capability', 'workflow'] as const);
    if (kind === 'capability') {
      const o = v.obj(item, p, ['id', 'kind', 'target', 'input', 'expect']);
      if (o === undefined) return;
      const id = v.str(o['id'], `${p}.id`);
      const target = matcher(v, o['target'], `${p}.target`);
      const input = objectOf(v, o['input'], `${p}.input`);
      const e = v.obj(o['expect'], `${p}.expect`, ['outcome', 'output', 'errorCode']);
      if (e === undefined) return;
      const outcome = v.oneOf(e['outcome'], `${p}.expect.outcome`, EXPECTED_CAPABILITY_OUTCOMES);
      const output = objectOf(v, e['output'], `${p}.expect.output`);
      const errorCode = v.str(e['errorCode'], `${p}.expect.errorCode`, { optional: true });
      if (id !== undefined && target !== undefined && outcome !== undefined) out.push({ id, kind, target, ...(input !== undefined ? { input } : {}), expect: { outcome, ...(output !== undefined ? { output } : {}), ...(errorCode !== undefined ? { errorCode } : {}) } });
    } else if (kind === 'workflow') {
      const o = v.obj(item, p, ['id', 'kind', 'steps', 'input', 'expect']);
      if (o === undefined) return;
      const id = v.str(o['id'], `${p}.id`);
      const steps = matcherList(v, o['steps'], `${p}.steps`);
      const input = objectOf(v, o['input'], `${p}.input`);
      const e = v.obj(o['expect'], `${p}.expect`, ['status', 'steps', 'injections']);
      if (e === undefined) return;
      const status = v.oneOf(e['status'], `${p}.expect.status`, EXPECTED_WORKFLOW_RUN_STATUSES);
      const stepExpectations: NonNullable<WorkflowExecutionCase['expect']['steps']>[number][] = [];
      v.arr(e['steps'], `${p}.expect.steps`, { optional: true })?.forEach((s, j) => {
        const sp = `${p}.expect.steps[${j}]`;
        const so = v.obj(s, sp, ['capability', 'outputStatus', 'output']);
        if (so === undefined) return;
        const capability = matcher(v, so['capability'], `${sp}.capability`);
        const outputStatus = v.str(so['outputStatus'], `${sp}.outputStatus`, { optional: true });
        const output = objectOf(v, so['output'], `${sp}.output`);
        if (capability) stepExpectations.push({ capability, ...(outputStatus !== undefined ? { outputStatus } : {}), ...(output !== undefined ? { output } : {}) });
      });
      const injections: NonNullable<WorkflowExecutionCase['expect']['injections']>[number][] = [];
      v.arr(e['injections'], `${p}.expect.injections`, { optional: true })?.forEach((b, j) => {
        const bp = `${p}.expect.injections[${j}]`;
        const bo = v.obj(b, bp, ['producer', 'output', 'consumer', 'input']);
        if (bo === undefined) return;
        const producer = matcher(v, bo['producer'], `${bp}.producer`);
        const output = v.str(bo['output'], `${bp}.output`);
        const consumer = matcher(v, bo['consumer'], `${bp}.consumer`);
        const inp = v.str(bo['input'], `${bp}.input`);
        if (producer && output !== undefined && consumer && inp !== undefined) injections.push({ producer, output, consumer, input: inp });
      });
      if (id !== undefined && steps !== undefined && status !== undefined) {
        out.push({ id, kind, steps, ...(input !== undefined ? { input } : {}), expect: { status, ...(stepExpectations.length > 0 ? { steps: stepExpectations } : {}), ...(injections.length > 0 ? { injections } : {}) } });
      }
    }
  });
  v.uniqueIds(out, path);
  return out;
}

function validateCase(v: Validator, value: unknown, path: string): BenchmarkCaseDefinition | undefined {
  const o = v.obj(value, path, ['caseId', 'description', 'sources', 'xoir', 'domainHint', 'expect', 'execution']);
  if (o === undefined) return undefined;
  const caseId = v.str(o['caseId'], `${path}.caseId`);
  const description = v.str(o['description'], `${path}.description`, { optional: true });
  const domainHint = v.str(o['domainHint'], `${path}.domainHint`, { optional: true });

  const hasSources = o['sources'] !== undefined;
  const hasXoir = o['xoir'] !== undefined;
  if (hasSources === hasXoir) v.fail(path, 'must have exactly one of "sources" or "xoir"');
  let sources: SourceSpec[] | undefined;
  if (hasSources) {
    const list = v.arr(o['sources'], `${path}.sources`, { min: 1 });
    if (list !== undefined) {
      sources = [];
      list.forEach((s, i) => {
        const sp = `${path}.sources[${i}]`;
        const so = v.obj(s, sp, ['kind', 'path', 'format']);
        if (so === undefined) return;
        const kind = v.oneOf(so['kind'], `${sp}.kind`, SOURCE_KINDS);
        const sourcePath = v.str(so['path'], `${sp}.path`);
        const format = v.oneOf(so['format'], `${sp}.format`, ['json', 'csv'] as const, { optional: true });
        if (kind === 'structured' && format === undefined) v.fail(`${sp}.format`, 'is required when kind is "structured"');
        if (kind !== undefined && kind !== 'structured' && so['format'] !== undefined) v.fail(`${sp}.format`, 'is only valid when kind is "structured"');
        if (sourcePath !== undefined && (sourcePath.startsWith('/') || sourcePath.split('/').includes('..'))) v.fail(`${sp}.path`, 'must be a relative path without ".." segments');
        if (kind !== undefined && sourcePath !== undefined) sources!.push({ kind, path: sourcePath, ...(format !== undefined ? { format } : {}) });
      });
    }
  }
  let xoir: string | undefined;
  if (hasXoir) {
    xoir = v.str(o['xoir'], `${path}.xoir`);
    if (xoir !== undefined && (xoir.startsWith('/') || xoir.split('/').includes('..'))) v.fail(`${path}.xoir`, 'must be a relative path without ".." segments');
  }

  let expect: CaseExpectations = {};
  const e = v.obj(o['expect'], `${path}.expect`, ['compile', 'semantics', 'capabilities', 'workflows']);
  if (e !== undefined) {
    let compile: CaseExpectations['compile'];
    if (e['compile'] !== undefined) {
      const c = v.obj(e['compile'], `${path}.expect.compile`, ['outcome', 'errorCode']);
      if (c !== undefined) {
        const outcome = v.oneOf(c['outcome'], `${path}.expect.compile.outcome`, ['succeeds', 'fails'] as const);
        const errorCode = v.str(c['errorCode'], `${path}.expect.compile.errorCode`, { optional: true });
        if (outcome !== undefined) compile = { outcome, ...(errorCode !== undefined ? { errorCode } : {}) };
      }
    }
    let semantics: CaseExpectations['semantics'];
    if (e['semantics'] !== undefined) {
      const s = v.obj(e['semantics'], `${path}.expect.semantics`, ['closedWorldKinds', 'facts', 'forbidden']);
      if (s !== undefined) {
        const closedWorldKinds = v.strList(s['closedWorldKinds'], `${path}.expect.semantics.closedWorldKinds`, { optional: true });
        const facts = validateFacts(v, s['facts'], `${path}.expect.semantics.facts`);
        const forbidden = validateForbiddenFacts(v, s['forbidden'], `${path}.expect.semantics.forbidden`);
        semantics = { ...(closedWorldKinds !== undefined ? { closedWorldKinds } : {}), ...(facts !== undefined ? { facts } : {}), ...(forbidden !== undefined ? { forbidden } : {}) };
      }
    }
    const capabilities = validateCapabilities(v, e['capabilities'], `${path}.expect.capabilities`);
    const workflows = validateWorkflows(v, e['workflows'], `${path}.expect.workflows`);
    expect = { ...(compile !== undefined ? { compile } : {}), ...(semantics !== undefined ? { semantics } : {}), ...(capabilities !== undefined ? { capabilities } : {}), ...(workflows !== undefined ? { workflows } : {}) };
  }
  const execution = validateExecution(v, o['execution'], `${path}.execution`);

  if (caseId === undefined) return undefined;
  return { caseId, ...(description !== undefined ? { description } : {}), ...(sources !== undefined ? { sources } : {}), ...(xoir !== undefined ? { xoir } : {}), ...(domainHint !== undefined ? { domainHint } : {}), expect, ...(execution !== undefined ? { execution } : {}) };
}

/**
 * Strict validation of an untrusted suite definition (parsed JSON):
 * unknown fields, wrong types, empty predicates, duplicate ids, conflicting
 * attribute expectations, path traversal, and a wrong `schemaVersion` are
 * all reported with a precise JSON path — the definition is NEVER partially
 * accepted. An EMPTY `cases` array is valid (and measures nothing).
 */
export function validateSuiteDefinition(raw: unknown): DefinitionResult {
  const v = new Validator();
  const o = v.obj(raw, '$', ['schemaVersion', 'suiteId', 'description', 'sourceRoot', 'cases']);
  if (o === undefined) return { ok: false, issues: v.issues };
  if (o['schemaVersion'] !== SUITE_SCHEMA_VERSION) v.fail('$.schemaVersion', `must be ${SUITE_SCHEMA_VERSION}`);
  const suiteId = v.str(o['suiteId'], '$.suiteId');
  const description = v.str(o['description'], '$.description', { optional: true });
  const sourceRoot = v.str(o['sourceRoot'], '$.sourceRoot', { optional: true });
  const rawCases = v.arr(o['cases'], '$.cases');
  const cases: BenchmarkCaseDefinition[] = [];
  rawCases?.forEach((c, i) => {
    const validated = validateCase(v, c, `$.cases[${i}]`);
    if (validated !== undefined) cases.push(validated);
  });
  const seen = new Set<string>();
  cases.forEach((c, i) => {
    if (seen.has(c.caseId)) v.fail(`$.cases[${i}].caseId`, `duplicate caseId "${c.caseId}"`);
    seen.add(c.caseId);
  });
  if (v.issues.length > 0 || suiteId === undefined) return { ok: false, issues: v.issues };
  return { ok: true, value: { schemaVersion: SUITE_SCHEMA_VERSION, suiteId, ...(description !== undefined ? { description } : {}), ...(sourceRoot !== undefined ? { sourceRoot } : {}), cases } };
}
