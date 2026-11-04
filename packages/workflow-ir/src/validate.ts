import { assertExpressionParses, parseTrees, type DecisionTree } from '@xo/capability-layer';
import { expressionIdentifiers, parseRef, parseTemplate, type ParsedRef } from './refs.js';
import { WORKFLOW_SCHEMA } from './schema.js';
import { checkSchema } from './schema-check.js';
import {
  WORKFLOW_SEMANTICS_VERSION,
  type ActStep,
  type Binding,
  type CompensateStep,
  type ConnectorDecl,
  type Determinism,
  type Step,
  type WorkflowComponent,
  type WorkflowDef,
  type WorkflowFeature,
} from './types.js';

export interface WorkflowIssue {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  /** `$.workflows[0].steps[2]`-style for structure; `workflow:<id>/step:<id>` for semantic findings. */
  readonly path: string;
  readonly message: string;
}

export interface WorkflowValidation {
  readonly valid: boolean;
  readonly issues: readonly WorkflowIssue[];
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DETERMINISM: Readonly<Record<Step['type'], Determinism>> = {
  extract: 'model_assisted',
  decide: 'deterministic',
  act: 'deterministic',
  approve: 'human',
  branch: 'deterministic',
  wait: 'deterministic',
  compensate: 'deterministic',
  escalate: 'human',
};

/** The determinism class a step of this type MUST declare. A document cannot claim a model-backed or human step is deterministic. */
export function intrinsicDeterminism(type: Step['type']): Determinism {
  return DETERMINISM[type];
}

export function hasSideEffects(step: Step): boolean {
  return (step.type === 'act' || step.type === 'compensate') && step.sideEffect !== 'read';
}

/** Features a workflow actually uses; `requiresFeatures` must cover them. */
export function usedFeatures(wf: WorkflowDef): WorkflowFeature[] {
  const f = new Set<WorkflowFeature>();
  if (wf.forEach !== undefined) f.add('for_each');
  if (wf.authority !== undefined) f.add('authority_ceilings');
  for (const s of wf.steps) {
    if (s.type === 'approve') f.add('approve');
    if (s.type === 'compensate' || (s.type === 'act' && s.compensatedBy !== undefined)) f.add('compensation');
    if (s.type === 'extract') f.add('model_extract');
    if (s.type === 'wait') f.add(s.for.kind === 'timer' ? 'wait_timer' : 'wait_event');
    if (s.type === 'decide' && s.method.kind === 'lookup') f.add('lookup');
    if (s.type === 'decide' && s.method.kind === 'rules') f.add('rules');
  }
  return [...f].sort();
}

const PATHLIKE = /^(\/|[A-Za-z]:[\\/]|\\\\|~\/)|(^|[\\/])\.\.([\\/]|$)|^file:\/\//;
const ENDPOINT = /^[a-z][a-z0-9+.-]*:\/\//i;
const SECRETLIKE =
  /(sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})/;
/** True when a string looks like a credential. The same test the validator applies to every string in a document; exported so producers can scrub quoted text before it reaches a portable component or a report. */
export const looksLikeSecret = (s: string): boolean => SECRETLIKE.test(s);
const PROVIDER = /\b(gemini|openai|gpt-?\d|chatgpt|claude|anthropic|llama|ollama|azure openai|mistral)\b/i;
const CRON_FIELD = /^[0-9*/,-]+$/;
const FREE_TEXT_KEYS = new Set(['instruction', 'summary', 'reason', 'description', 'message']);

/** Walks every string in the document, calling `fn(value, key, path)`. */
function walkStrings(v: unknown, path: string, key: string, fn: (s: string, key: string, path: string) => void): void {
  if (typeof v === 'string') fn(v, key, path);
  else if (Array.isArray(v)) v.forEach((x, i) => walkStrings(x, `${path}[${i}]`, key, fn));
  else if (typeof v === 'object' && v !== null) for (const [k, x] of Object.entries(v)) walkStrings(x, `${path}.${k}`, k, fn);
}

interface Ctx {
  readonly issues: WorkflowIssue[];
  readonly err: (code: string, path: string, message: string) => void;
  readonly warn: (code: string, path: string, message: string) => void;
}

/**
 * Validates a parsed workflow component. Structural rules come from the published
 * schema; everything the schema cannot express is checked here. Any `error`
 * makes the component unloadable: a host MUST refuse it rather than run a subset.
 */
export function validateWorkflowComponent(doc: unknown): WorkflowValidation {
  const issues: WorkflowIssue[] = [];
  const ctx: Ctx = {
    issues,
    err: (code, path, message) => issues.push({ severity: 'error', code, path, message }),
    warn: (code, path, message) => issues.push({ severity: 'warning', code, path, message }),
  };
  for (const s of checkSchema(WORKFLOW_SCHEMA, doc)) ctx.err('SCHEMA', s.path, s.message);
  if (issues.length > 0) return { valid: false, issues };

  const comp = doc as WorkflowComponent;
  const [major] = comp.semanticsVersion.split('.');
  if (major !== WORKFLOW_SEMANTICS_VERSION.split('.')[0])
    ctx.err('SEMANTICS_UNSUPPORTED', '$.semanticsVersion', `semantics ${comp.semanticsVersion} is not 1.x`);

  walkStrings(comp, '$', '', (s, key, path) => {
    if (SECRETLIKE.test(s))
      ctx.err(
        'SECRET_IN_DOCUMENT',
        path,
        'looks like a credential; secrets are referenced by name and supplied by the host vault, never embedded',
      );
    if (FREE_TEXT_KEYS.has(key)) {
      if (key === 'instruction' && PROVIDER.test(s))
        ctx.warn('PROVIDER_SPECIFIC_INSTRUCTION', path, 'instruction names a model provider; instructions must be host-independent');
      return;
    }
    if (key === 'const' || key === 'pattern' || key === 'default' || key === 'set') {
      if (PATHLIKE.test(s))
        ctx.err('HOST_PATH', path, 'machine-specific path in a portable document; use a logical source id bound by host policy');
      if (ENDPOINT.test(s))
        ctx.err('HOST_ENDPOINT', path, 'endpoint URL in a portable document; connector endpoints belong in host policy');
    }
  });

  const connectors = new Map<string, ConnectorDecl>();
  comp.connectors.forEach((c, i) => {
    if (connectors.has(c.id)) ctx.err('DUPLICATE_CONNECTOR', `$.connectors[${i}]`, `connector id "${c.id}" is declared twice`);
    connectors.set(c.id, c);
    const ops = new Set<string>();
    for (const op of c.operations) {
      if (ops.has(op.name)) ctx.err('DUPLICATE_OPERATION', `connector:${c.id}`, `operation "${op.name}" is declared twice`);
      ops.add(op.name);
      if (op.sideEffect !== 'read' && c.kind === 'database')
        ctx.err('DATABASE_WRITE', `connector:${c.id}/op:${op.name}`, 'database connectors are read-only in IR 1.0');
    }
  });

  const seenWf = new Set<string>();
  comp.workflows.forEach((wf) => {
    const key = `${wf.id}@${wf.version}`;
    if (seenWf.has(key)) ctx.err('DUPLICATE_WORKFLOW', `workflow:${wf.id}`, `workflow ${key} is declared twice`);
    seenWf.add(key);
    validateWorkflow(wf, connectors, ctx);
  });
  return { valid: !issues.some((i) => i.severity === 'error'), issues };
}

function validateWorkflow(wf: WorkflowDef, connectors: ReadonlyMap<string, ConnectorDecl>, ctx: Ctx): void {
  const wp = `workflow:${wf.id}`;
  const stepsById = new Map<string, Step>();
  for (const s of wf.steps) {
    if (stepsById.has(s.id)) ctx.err('DUPLICATE_STEP', `${wp}/step:${s.id}`, `step id "${s.id}" is used twice`);
    stepsById.set(s.id, s);
  }
  for (const k of Object.keys(wf.inputs))
    if (!NAME.test(k)) ctx.err('BAD_NAME', `${wp}/inputs`, `input name "${k}" is not a valid identifier`);

  // --- triggers
  const trigIds = new Set<string>();
  for (const t of wf.triggers) {
    const tp = `${wp}/trigger:${t.id}`;
    if (trigIds.has(t.id)) ctx.err('DUPLICATE_TRIGGER', tp, `trigger id "${t.id}" is used twice`);
    trigIds.add(t.id);
    for (const name of Object.keys(t.map ?? {}))
      if (!(name in wf.inputs)) ctx.err('TRIGGER_MAP_UNKNOWN_INPUT', tp, `maps to unknown input "${name}"`);
    if (t.kind === 'cron') {
      const fields = t.schedule.trim().split(/\s+/);
      if (fields.length !== 5 || !fields.every((f) => CRON_FIELD.test(f)))
        ctx.err('BAD_CRON', tp, `"${t.schedule}" is not a 5-field cron expression`);
      const required = Object.entries(wf.inputs)
        .filter(([, v]) => v.required === true)
        .map(([k]) => k);
      if (required.length > 0)
        ctx.err('CRON_NEEDS_INPUT', tp, `a cron trigger carries no payload but input(s) ${required.join(', ')} are required`);
    }
    if (t.kind === 'batch_file' && wf.forEach !== undefined)
      ctx.warn('BATCH_AND_FOREACH', tp, 'batch_file already fans out one run per row; forEach on the same workflow multiplies that');
  }

  // --- graph: needs resolve, acyclic
  const needs = new Map<string, readonly string[]>();
  for (const s of wf.steps) {
    const sp = `${wp}/step:${s.id}`;
    for (const n of s.needs ?? []) {
      if (n === s.id) ctx.err('SELF_DEPENDENCY', sp, 'a step cannot need itself');
      else if (!stepsById.has(n)) ctx.err('UNKNOWN_NEED', sp, `needs unknown step "${n}"`);
      else if (stepsById.get(n)?.type === 'compensate')
        ctx.err(
          'NEEDS_COMPENSATION_STEP',
          sp,
          `"${n}" is a compensate step; compensation steps run only during rollback and cannot be depended on`,
        );
    }
    needs.set(
      s.id,
      (s.needs ?? []).filter((n) => stepsById.has(n)),
    );
  }
  const closure = transitiveNeeds(needs);
  const cyc = findCycle(needs);
  if (cyc !== undefined)
    ctx.err(
      'CYCLE',
      wp,
      `the step graph has a cycle (${cyc.join(' -> ')}); IR 1.0 graphs are acyclic. Use forEach or retry for bounded repetition`,
    );

  // --- per-step
  for (const s of wf.steps) validateStep(wf, s, stepsById, closure, connectors, ctx);

  // --- workflow-level refs
  const refCtx = { wf, stepsById, closure, ctx } as const;
  const allSteps = new Set(wf.steps.map((s) => s.id));
  for (const [name, b] of Object.entries(wf.result ?? {})) {
    if (!NAME.test(name)) ctx.err('BAD_NAME', `${wp}/result`, `result name "${name}" is not a valid identifier`);
    checkBinding(b, `${wp}/result:${name}`, refCtx, allSteps, undefined);
  }
  wf.authority?.ceilings.forEach((c, i) => checkBinding(c.value, `${wp}/authority[${i}]`, refCtx, allSteps, undefined));
  if (wf.authority !== undefined && !wf.steps.some(hasSideEffects))
    ctx.warn('UNUSED_CEILING', wp, 'authority ceilings are declared but no step has side effects');

  if (wf.forEach !== undefined) {
    const over = wf.inputs[wf.forEach.over];
    if (over === undefined) ctx.err('FOREACH_UNKNOWN_INPUT', wp, `forEach.over "${wf.forEach.over}" is not a declared input`);
    else if (over.type !== 'json')
      ctx.err('FOREACH_NOT_JSON', wp, `forEach.over "${wf.forEach.over}" must be a json input (an array of flat objects)`);
    if (wf.forEach.concurrency > wf.maxConcurrency) ctx.err('FOREACH_CONCURRENCY', wp, 'forEach.concurrency exceeds maxConcurrency');
  }

  const used = usedFeatures(wf);
  const declared = new Set(wf.requiresFeatures ?? []);
  const missing = used.filter((f) => !declared.has(f));
  if (missing.length > 0)
    ctx.err(
      'FEATURES_UNDECLARED',
      wp,
      `uses feature(s) ${missing.join(', ')} that requiresFeatures does not list; hosts negotiate on that list`,
    );
  const extra = [...declared].filter((f) => !used.includes(f));
  if (extra.length > 0)
    ctx.warn(
      'FEATURES_OVERDECLARED',
      wp,
      `requiresFeatures lists unused feature(s) ${extra.join(', ')}; this needlessly narrows which hosts can run it`,
    );
}

type RefCtx = {
  readonly wf: WorkflowDef;
  readonly stepsById: ReadonlyMap<string, Step>;
  readonly closure: ReadonlyMap<string, ReadonlySet<string>>;
  readonly ctx: Ctx;
};

/** Validates one binding. `reader` is the reading step (undefined for workflow-level result/ceilings: any step may be read). */
function checkBinding(
  b: Binding,
  path: string,
  rc: RefCtx,
  _allSteps: ReadonlySet<string>,
  reader: Step | undefined,
): ParsedRef | undefined {
  if (!('from' in b)) return undefined;
  const ref = parseRef(b.from);
  if (ref === undefined) {
    rc.ctx.err('BAD_REF', path, `"${b.from}" is not a valid reference`);
    return undefined;
  }
  checkRef(ref, b.optional === true, path, rc, reader);
  return ref;
}

function checkRef(ref: ParsedRef, optional: boolean, path: string, rc: RefCtx, reader: Step | undefined): void {
  const { wf, stepsById, closure, ctx } = rc;
  if (ref.kind === 'input' && !(ref.name in wf.inputs)) ctx.err('UNKNOWN_INPUT', path, `reads undeclared workflow input "${ref.name}"`);
  if (ref.kind === 'item' && wf.forEach === undefined)
    ctx.err('ITEM_WITHOUT_FOREACH', path, 'reads item.* but the workflow has no forEach');
  if (ref.kind === 'step') {
    const target = stepsById.get(ref.step);
    if (target === undefined) {
      ctx.err('UNKNOWN_STEP_REF', path, `reads unknown step "${ref.step}"`);
      return;
    }
    if (target.type === 'compensate') ctx.err('REF_COMPENSATION_STEP', path, 'compensate steps do not produce readable outputs');
    if (target.outputs === undefined || !(ref.output in target.outputs))
      ctx.err('UNKNOWN_OUTPUT', path, `step "${ref.step}" does not declare output "${ref.output}"`);
    if (reader !== undefined) {
      if (reader.id === ref.step) ctx.err('SELF_REF', path, 'a step cannot read its own outputs');
      else if (!readable(reader, closure).has(ref.step))
        ctx.err(
          'UNORDERED_REF',
          path,
          `reads steps.${ref.step}.* but does not (transitively) need "${ref.step}", so the value may not exist yet`,
        );
    }
    if (target.runIf !== undefined && !optional)
      ctx.err(
        'REF_MAYBE_SKIPPED',
        path,
        `"${ref.step}" has a runIf and may be skipped; mark this binding optional or the step reading it may run with a missing value`,
      );
  }
}

/** Steps a reader may legitimately read: its transitive needs; a compensate step may read what its target could read, plus the target. */
function readable(reader: Step, closure: ReadonlyMap<string, ReadonlySet<string>>): ReadonlySet<string> {
  if (reader.type === 'compensate') return new Set([reader.compensates, ...(closure.get(reader.compensates) ?? [])]);
  return closure.get(reader.id) ?? new Set();
}

function validateStep(
  wf: WorkflowDef,
  s: Step,
  stepsById: ReadonlyMap<string, Step>,
  closure: ReadonlyMap<string, ReadonlySet<string>>,
  connectors: ReadonlyMap<string, ConnectorDecl>,
  ctx: Ctx,
): void {
  const sp = `workflow:${wf.id}/step:${s.id}`;
  const rc: RefCtx = { wf, stepsById, closure, ctx };
  const expected = DETERMINISM[s.type];
  if (s.determinism !== expected)
    ctx.err('DETERMINISM_MISMATCH', sp, `a ${s.type} step is "${expected}" by definition but declares "${s.determinism}"`);
  for (const k of Object.keys(s.inputs ?? {})) if (!NAME.test(k)) ctx.err('BAD_NAME', sp, `input name "${k}" is not a valid identifier`);
  for (const k of Object.keys(s.outputs ?? {})) if (!NAME.test(k)) ctx.err('BAD_NAME', sp, `output name "${k}" is not a valid identifier`);
  for (const [name, b] of Object.entries(s.inputs ?? {})) checkBinding(b, `${sp}/input:${name}`, rc, new Set(), s);
  const inputNames = new Set(Object.keys(s.inputs ?? {}));
  const expr = (src: string, extra: ReadonlySet<string>, where: string): void => {
    try {
      assertExpressionParses(src);
    } catch (e) {
      ctx.err('BAD_EXPRESSION', `${sp}/${where}`, `expression does not parse in the closed expression language: ${(e as Error).message}`);
      return;
    }
    for (const id of expressionIdentifiers(src))
      if (!inputNames.has(id) && !extra.has(id))
        ctx.err('EXPRESSION_SCOPE', `${sp}/${where}`, `uses "${id}" which is not one of this step's declared inputs`);
  };
  if (s.runIf !== undefined) expr(s.runIf, new Set(), 'runIf');

  if (s.retry !== undefined && s.retry.backoff.maxMs < s.retry.backoff.baseMs) ctx.err('BAD_BACKOFF', sp, 'backoff.maxMs is below baseMs');

  const isEffectful = hasSideEffects(s);
  const keyAllowed = s.type === 'act' || s.type === 'compensate';
  if (s.idempotencyKey !== undefined && !keyAllowed)
    ctx.err(
      'KEY_NOT_ALLOWED',
      sp,
      s.type === 'approve'
        ? 'approval decision identity is derived by the semantics (workflow, version, run, step, item); authors cannot override it'
        : `idempotencyKey is only meaningful on act/compensate steps, not ${s.type}`,
    );
  if (isEffectful && s.idempotencyKey === undefined)
    ctx.err('MISSING_IDEMPOTENCY_KEY', sp, `${s.type} step has side effects (${(s as ActStep).sideEffect}) but no idempotencyKey`);
  if (s.idempotencyKey !== undefined && keyAllowed) {
    const t = parseTemplate(s.idempotencyKey);
    if ('error' in t) ctx.err('BAD_IDEMPOTENCY_KEY', sp, t.error);
    else {
      const placeholders = t.parts.filter((p) => !('literal' in p));
      if (placeholders.length === 0)
        ctx.err(
          'CONSTANT_IDEMPOTENCY_KEY',
          sp,
          'a constant key would deduplicate every run into one; include at least one placeholder such as {{run.id}}',
        );
      for (const p of t.parts) if ('ref' in p) checkRef(p.ref, false, `${sp}/idempotencyKey`, rc, s);
      if (
        wf.forEach !== undefined &&
        !t.parts.some((p) => 'ref' in p && (p.ref.kind === 'item' || (p.ref.kind === 'run' && p.ref.name === 'index')))
      )
        ctx.err(
          'FOREACH_KEY_NOT_PER_ITEM',
          sp,
          'in a forEach workflow the key must include {{run.index}} or an {{item.*}} field, otherwise items collide',
        );
    }
  }

  switch (s.type) {
    case 'extract':
      if (s.outputs === undefined || Object.keys(s.outputs).length === 0)
        ctx.err('NO_OUTPUTS', sp, 'an extract step must declare the fields it extracts');
      if (s.structuredFirst === true && !inputNames.has('structured'))
        ctx.err('STRUCTURED_FIRST_INPUT', sp, 'structuredFirst needs an input named "structured"');
      if (!inputNames.has('text') && !inputNames.has('structured'))
        ctx.err('EXTRACT_NO_SOURCE', sp, 'an extract step needs a "text" and/or "structured" input');
      if (s.grounding === 'quote_required' && !inputNames.has('text'))
        ctx.err('GROUNDING_NEEDS_TEXT', sp, 'quote_required grounding needs the source "text" input to check quotes against');
      break;
    case 'decide': {
      const outs = Object.keys(s.outputs ?? {});
      if (outs.length === 0) ctx.err('NO_OUTPUTS', sp, 'a decide step must declare its outputs');
      const m = s.method;
      if (m.kind === 'rules') {
        const ids = new Set<string>();
        for (const r of m.rules) {
          if (ids.has(r.id)) ctx.err('DUPLICATE_RULE', sp, `rule id "${r.id}" is used twice`);
          ids.add(r.id);
          expr(r.when, new Set(), `rule:${r.id}`);
          if (!sameSet(Object.keys(r.set), outs))
            ctx.err('RULE_OUTPUT_MISMATCH', `${sp}/rule:${r.id}`, `a rule must set exactly the declared outputs (${outs.join(', ')})`);
        }
        if (m.onNoMatch === 'default' && (m.default === undefined || !sameSet(Object.keys(m.default), outs)))
          ctx.err('BAD_DEFAULT', sp, 'onNoMatch "default" needs a default that sets exactly the declared outputs');
        if (m.onNoMatch === 'escalate' && m.default !== undefined)
          ctx.err('UNUSED_DEFAULT', sp, 'a default is given but onNoMatch is "escalate"');
      } else if (m.kind === 'formula') {
        const known = new Set<string>();
        for (const [name, src] of Object.entries(m.set)) {
          expr(src, known, `formula:${name}`);
          known.add(name);
        }
        if (!sameSet(Object.keys(m.set), outs))
          ctx.err('FORMULA_OUTPUT_MISMATCH', sp, `formula must set exactly the declared outputs (${outs.join(', ')})`);
      } else if (m.kind === 'lookup') {
        for (const k of m.keys)
          if (!inputNames.has(k)) ctx.err('LOOKUP_KEY_NOT_INPUT', sp, `lookup key "${k}" is not one of this step's inputs`);
        const cols = new Set([...m.keys, ...outs]);
        const seen = new Set<string>();
        m.rows.forEach((row, i) => {
          if (!sameSet(Object.keys(row), [...cols]))
            ctx.err('LOOKUP_ROW_SHAPE', `${sp}/row:${i}`, `row must have exactly the columns ${[...cols].join(', ')}`);
          const k = JSON.stringify(m.keys.map((c) => row[c]));
          if (seen.has(k))
            ctx.err('LOOKUP_DUPLICATE_KEY', `${sp}/row:${i}`, `duplicate lookup key ${k}; a lookup must be a function of its keys`);
          seen.add(k);
        });
      }
      break;
    }
    case 'branch': {
      const routes = new Set(s.cases.map((c) => c.route));
      if (routes.size !== s.cases.length) ctx.err('DUPLICATE_ROUTE', sp, 'two cases share a route name');
      if (routes.has(s.default)) ctx.err('DEFAULT_ROUTE_COLLIDES', sp, 'the default route name is also a case route');
      s.cases.forEach((c) => expr(c.when, new Set(), `case:${c.route}`));
      if (s.outputs === undefined || !('route' in s.outputs))
        ctx.err('BRANCH_ROUTE_OUTPUT', sp, 'a branch step must declare an output named "route" (type enum or string)');
      else if (s.outputs['route']?.type === 'enum') {
        const allowed = new Set(s.outputs['route'].enum ?? []);
        for (const r of [...routes, s.default])
          if (!allowed.has(r)) ctx.err('ROUTE_NOT_IN_ENUM', sp, `route "${r}" is missing from the route enum`);
      }
      break;
    }
    case 'act': {
      checkOperation(s, s.connector, s.operation, s.sideEffect, sp, connectors, ctx);
      if (s.compensatedBy !== undefined) {
        const c = stepsById.get(s.compensatedBy);
        if (c === undefined || c.type !== 'compensate')
          ctx.err('BAD_COMPENSATION', sp, `compensatedBy "${s.compensatedBy}" is not a compensate step`);
        else if (c.compensates !== s.id)
          ctx.err('BAD_COMPENSATION', sp, `compensate step "${c.id}" compensates "${c.compensates}", not "${s.id}"`);
        if (s.sideEffect === 'read') ctx.err('COMPENSATING_READ', sp, 'a read step has nothing to compensate');
        if (s.sideEffect === 'irreversible')
          ctx.warn(
            'IRREVERSIBLE_COMPENSATED',
            sp,
            'irreversible steps cannot be truly undone; the compensation is a best-effort semantic reversal (for example a correction message)',
          );
      }
      if (s.sideEffect === 'irreversible' && s.onError === 'compensate')
        ctx.warn('ONERROR_COMPENSATE_IRREVERSIBLE', sp, 'onError "compensate" cannot undo this step itself');
      break;
    }
    case 'compensate': {
      checkOperation(s, s.connector, s.operation, s.sideEffect, sp, connectors, ctx);
      const target = stepsById.get(s.compensates);
      if (target === undefined || target.type !== 'act')
        ctx.err('BAD_COMPENSATION', sp, `compensates "${s.compensates}" which is not an act step`);
      else if (target.compensatedBy !== s.id)
        ctx.err('BAD_COMPENSATION', sp, `act "${target.id}" does not name this step in compensatedBy`);
      if (s.needs !== undefined && s.needs.length > 0)
        ctx.err('COMPENSATE_HAS_NEEDS', sp, 'compensate steps are scheduled by rollback order, not by needs');
      if (s.runIf !== undefined)
        ctx.err('COMPENSATE_HAS_RUNIF', sp, 'compensate steps cannot be conditional; they run when their target completed');
      break;
    }
    case 'approve': {
      for (const e of s.evidence ?? [])
        if (!inputNames.has(e)) ctx.err('EVIDENCE_NOT_INPUT', sp, `evidence "${e}" is not one of this step's inputs`);
      const t = parseTemplate(s.summary);
      if ('error' in t) ctx.err('BAD_TEMPLATE', sp, t.error);
      else for (const p of t.parts) if ('ref' in p) checkRef(p.ref, false, `${sp}/summary`, rc, s);
      if (s.onError === 'fail')
        ctx.warn(
          'APPROVE_FAILS_RUN',
          sp,
          'a failed approval request fails the run rather than reaching a person; prefer onError "escalate"',
        );
      if (s.outputs === undefined || !('decision' in s.outputs))
        ctx.err('APPROVE_DECISION_OUTPUT', sp, 'an approve step must declare a "decision" output (enum approved|rejected)');
      else if (!sameSet(s.outputs['decision']?.enum ?? [], ['approved', 'rejected']))
        ctx.err('APPROVE_DECISION_OUTPUT', sp, 'the "decision" output must be enum ["approved","rejected"]');
      break;
    }
    case 'wait':
      if (s.for.kind === 'approval') {
        const t = stepsById.get(s.for.step);
        if (t === undefined || t.type !== 'approve')
          ctx.err('WAIT_NOT_APPROVE', sp, `waits for "${s.for.step}" which is not an approve step`);
        else if (!closure.get(s.id)?.has(t.id))
          ctx.err('WAIT_UNORDERED', sp, `must (transitively) need the approve step "${t.id}" it waits on`);
      }
      if (s.for.kind === 'event' && !(s.for.correlationKey in wf.inputs))
        ctx.err('WAIT_CORRELATION', sp, `correlationKey "${s.for.correlationKey}" is not a workflow input`);
      if (s.for.kind === 'timer' && s.for.delayMs > s.timeoutMs)
        ctx.err('WAIT_TIMER_EXCEEDS_TIMEOUT', sp, 'delayMs exceeds the step timeout, so the step could never complete');
      break;
    case 'escalate':
      for (const [field, text] of [
        ['reason', s.reason],
        ['target', s.target],
      ] as const) {
        const t = parseTemplate(text);
        if ('error' in t) ctx.err('BAD_TEMPLATE', `${sp}/${field}`, t.error);
        else for (const p of t.parts) if ('ref' in p) checkRef(p.ref, false, `${sp}/${field}`, rc, s);
      }
      break;
  }
}

function checkOperation(
  s: ActStep | CompensateStep,
  connector: string,
  operation: string,
  sideEffect: string,
  sp: string,
  connectors: ReadonlyMap<string, ConnectorDecl>,
  ctx: Ctx,
): void {
  const c = connectors.get(connector);
  if (c === undefined) {
    ctx.err('UNDECLARED_CONNECTOR', sp, `uses connector "${connector}" which the connector manifest does not declare`);
    return;
  }
  const op = c.operations.find((o) => o.name === operation);
  if (op === undefined) {
    ctx.err('UNDECLARED_OPERATION', sp, `connector "${connector}" does not declare operation "${operation}"`);
    return;
  }
  if (op.sideEffect !== sideEffect)
    ctx.err(
      'SIDE_EFFECT_MISMATCH',
      sp,
      `step says "${sideEffect}" but the connector manifest declares "${operation}" as "${op.sideEffect}"`,
    );
  void s;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x));
}

function transitiveNeeds(needs: ReadonlyMap<string, readonly string[]>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const visit = (id: string, stack: Set<string>): Set<string> => {
    const have = out.get(id);
    if (have !== undefined) return have;
    const acc = new Set<string>();
    if (stack.has(id)) return acc; // cycle: reported separately
    stack.add(id);
    for (const n of needs.get(id) ?? []) {
      acc.add(n);
      for (const x of visit(n, stack)) acc.add(x);
    }
    stack.delete(id);
    out.set(id, acc);
    return acc;
  };
  for (const id of needs.keys()) visit(id, new Set());
  return out;
}

function findCycle(needs: ReadonlyMap<string, readonly string[]>): string[] | undefined {
  const state = new Map<string, 1 | 2>();
  const path: string[] = [];
  const dfs = (id: string): string[] | undefined => {
    state.set(id, 1);
    path.push(id);
    for (const n of needs.get(id) ?? []) {
      if (state.get(n) === 1) return [...path.slice(path.indexOf(n)), n];
      if (state.get(n) === undefined) {
        const c = dfs(n);
        if (c !== undefined) return c;
      }
    }
    path.pop();
    state.set(id, 2);
    return undefined;
  };
  for (const id of needs.keys())
    if (state.get(id) === undefined) {
      const c = dfs(id);
      if (c !== undefined) return c;
    }
  return undefined;
}

/** Facts a host's package contains that cross-component validation needs. */
export interface BundleRefs {
  /** Raw JSON of `reasoning/decision_trees.json`, if the package has that component. */
  readonly decisionTrees?: unknown;
}

/**
 * Checks references from the workflow component into the rest of the package:
 * every `decide` tree must exist, accept only inputs the step supplies, and be
 * able to produce every declared output. Run at load time after
 * {@link validateWorkflowComponent}.
 */
export function validateAgainstBundle(comp: WorkflowComponent, refs: BundleRefs): WorkflowValidation {
  const issues: WorkflowIssue[] = [];
  const trees: DecisionTree[] = refs.decisionTrees === undefined ? [] : (parseTrees(refs.decisionTrees) ?? []);
  const byId = new Map(trees.map((t) => [t.id, t]));
  for (const wf of comp.workflows)
    for (const s of wf.steps) {
      if (s.type !== 'decide' || s.method.kind !== 'tree') continue;
      const sp = `workflow:${wf.id}/step:${s.id}`;
      const tree = byId.get(s.method.treeId);
      if (tree === undefined) {
        issues.push({
          severity: 'error',
          code: 'TREE_NOT_FOUND',
          path: sp,
          message: `decision tree "${s.method.treeId}" is not in this package`,
        });
        continue;
      }
      const supplied = new Set(Object.keys(s.inputs ?? {}));
      for (const i of tree.inputs)
        if (!supplied.has(i.name))
          issues.push({
            severity: 'error',
            code: 'TREE_INPUT_UNSUPPLIED',
            path: sp,
            message: `tree "${tree.id}" needs input "${i.name}" which this step does not supply`,
          });
      const leafKeys = new Set<string>();
      for (const n of Object.values(tree.nodes)) if (n.type === 'leaf') for (const k of Object.keys(n.output)) leafKeys.add(k);
      for (const o of Object.keys(s.outputs ?? {}))
        if (!leafKeys.has(o))
          issues.push({
            severity: 'error',
            code: 'TREE_OUTPUT_UNPRODUCED',
            path: sp,
            message: `tree "${tree.id}" never produces output "${o}"`,
          });
    }
  return { valid: !issues.some((i) => i.severity === 'error'), issues };
}
