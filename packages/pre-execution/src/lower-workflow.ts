/**
 * PX-6 — lowering a composed `CandidateWorkflow` to Workflow IR, the canonical definition (ADR 0029 decisions 12 and 13;
 * gaps PX-G21 and PX-G23).
 *
 * One function, used by every surface. Each step is lowered from what its capability's report says it is bound to:
 *
 *   deterministic_rule  → `decide` (method `rules`): each linked rule whose structured condition renders in the closed
 *                         expression language becomes one rule; no match escalates. A rule that does not render (a
 *                         temporal condition, an exception clause) makes the step unsupported for generation.
 *   human_in_the_loop   → `approve`: the human task contract's instruction, done-when and role are the summary; the
 *                         person's inputs are attached as evidence; a timeout escalates (never auto-approves).
 *   external_tool       → not generated: connector operations are bound by the host at runtime, so an `act` step would
 *                         have to guess the connector and its side effects. Reported, never invented.
 *   anything unbound    → not generated, reported as blocking.
 *
 * Steps run in the composed order (each needs the one before). The result carries the definition, a rationale per step,
 * the issues, the construct matrix (what generation can and cannot emit) and a digest over the canonical definition.
 * The definition is validated with `validateWorkflowComponent`; generation never weakens a construct to make it valid.
 */
import { buildSemanticCapabilityContract, type SemanticCapabilityContract, type StructuredCondition } from '@xo/capability-contract';
import type { CandidateWorkflow } from '@xo/workflow-composer';
import {
  WORKFLOW_FORMAT_VERSION,
  WORKFLOW_SEMANTICS_VERSION,
  validateWorkflowComponent,
  type InputSpec,
  type Step,
  type WorkflowComponent,
  type WorkflowDef,
  type WorkflowFeature,
  type WorkflowIssue,
} from '@xo/workflow-ir';
import type { XoirGraph, XoirNodeId } from '@xo/xoir';
import { digestOf, type Digest } from './canonical.js';
import type { CapabilityInventory, CapabilityReport } from './capability-inventory.js';

export const WORKFLOW_LOWERING_VERSION = 'xo.workflow-lowering.v1';

/**
 * Every Workflow IR construct, and exactly what evidence makes generation emit it (decision 13). A construct is emitted only
 * when that evidence exists; otherwise the step is reported, never invented.
 */
export const GENERATION_CONSTRUCTS = {
  sequence: 'the composed order: each step needs the one before',
  approve:
    'a capability with a human task contract; the deadline is the one the source states ("within 3 days"), else 7 days, and it escalates',
  decide_rules: 'a rule-bound capability whose conditions render in the closed expression language; no match escalates',
  branch: 'a decide step whose rule outcomes name later steps: each named step runs only on its outcome',
  wait: 'a human task whose instruction states a wait ("wait 24 hours before ..."): a timer before the task',
  act: 'a declared operation the workspace bound to a connector operation, with the side effect the operator declared; side effects carry an idempotency key',
  compensate: 'an act whose binding declares an undo operation: the undo runs on rollback',
  for_each: 'a goal that says the work is done for each item ("for each invoice"): one run per item, keys include the item index',
  extract:
    'a goal that says cases arrive as text: one quoted, model-assisted reading of the facts the rules need; structured input bypasses the model',
  escalate:
    'after a human task, when the person reports it was not done (the workflow stops and goes back to a person); and by the runtime on a decide step with no matching rule, a timeout, or an unknown outcome',
} as const;

/** The operator's statement of how a declared operation is carried out (ADR 0030): which connector, which effect, which undo. */
export interface ConnectorBinding {
  /** The declared operation (capability name) this binding carries out. */
  readonly capability: string;
  /** Workflow IR connector id (`^[a-z][a-z0-9_]{0,63}$`). */
  readonly connector: string;
  readonly kind: 'http' | 'webhook_out' | 'file' | 'smtp' | 'slack_webhook' | 'database' | 'mcp';
  readonly operation: string;
  readonly sideEffect: 'read' | 'write' | 'irreversible';
  /** The operation that undoes this one, when the destination offers one. */
  readonly compensation?: { readonly operation: string; readonly sideEffect: 'read' | 'write' | 'irreversible' };
  /** The host adapter that performs the call. */
  readonly adapter: string;
  /**
   * UW-9: the workspace connection credential the adapter acts with (`crd_…`), released to it per call by the credential broker
   * (tenant, state and scopes checked at every use). Absent: the adapter uses whatever the host configured it with.
   */
  readonly credentialId?: string;
  /**
   * V1-1 (ADR 0049): the call's arguments, each from a field of the item (or of the run's input, without a forEach) or a constant the
   * operator wrote. A binding with arguments makes the step it names an `act` step whatever its source says, a person's task included:
   * which steps XO carries out is the operator's decision (manage role, recent sign-in, audited), never the source's.
   */
  readonly arguments?: Readonly<Record<string, BindingArgument>>;
}

/** One argument of a bound call: a field of the item or input, or a constant. */
export type BindingArgument = { readonly field: string } | { readonly const: string | number | boolean };

export interface LoweringIssue {
  readonly stepId?: string;
  readonly capabilityId?: string;
  readonly severity: 'blocking' | 'warning';
  readonly code: 'unbound' | 'unsupported_for_generation' | 'not_runtime_supported' | 'invalid_definition' | 'empty';
  readonly message: string;
}

export interface StepRationale {
  readonly stepId: string;
  readonly capabilityId: string;
  readonly capabilityName: string;
  readonly construct: Step['type'] | 'for_each';
  readonly reason: string;
}

export interface LoweredWorkflow {
  readonly schema: typeof WORKFLOW_LOWERING_VERSION;
  readonly candidateWorkflowId: string;
  /** The single-workflow component (`workflows/workflows.json` shape); absent when no step could be generated. */
  readonly component?: WorkflowComponent;
  readonly rationale: readonly StepRationale[];
  readonly issues: readonly LoweringIssue[];
  /** Validation of `component` by `validateWorkflowComponent` (the same validator packages use). */
  readonly validation: { readonly valid: boolean; readonly issues: readonly WorkflowIssue[] };
  /** `sha256:` of the canonical JSON of `component` (absent component: of null). Stable across regeneration. */
  readonly definitionDigest: Digest;
  /** True when every candidate step was generated, the definition is valid and nothing blocks. */
  readonly complete: boolean;
}

const STEP_TIMEOUT_DECIDE_MS = 30_000;
const STEP_TIMEOUT_HUMAN_MS = 7 * 24 * 60 * 60 * 1000;

/** "the refund amount" → "refund_amount": an identifier the expression language and the reference grammar accept. */
/** A connector's own field name, kept verbatim when it is already a valid IR identifier: the adapter's request and result use it. */
export function contractFieldName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) ? name : identifierOf(name);
}

export function identifierOf(text: string): string {
  const id = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((w) => w !== '' && !['the', 'a', 'an', 'of'].includes(w))
    .join('_')
    .replace(/[^a-z0-9_]/g, '');
  const safe = /^[a-z_]/.test(id) ? id : `f_${id}`;
  return safe.slice(0, 63) || 'value';
}

/** A workflow id the IR accepts (`^[a-z][a-z0-9_]{0,63}$`). */
function workflowIdOf(name: string): string {
  const base = identifierOf(name);
  return (/^[a-z]/.test(base) ? base : `wf_${base}`).slice(0, 64).replace(/_+$/, '') || 'workflow';
}

function stepIdOf(order: number, name: string): string {
  return `s${order + 1}_${identifierOf(name)}`.slice(0, 64).replace(/_+$/, '');
}

const quote = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Renders a structured condition in the closed expression language, or `undefined` when it has no faithful rendering. */
export function renderCondition(c: StructuredCondition, fields: Map<string, 'number' | 'string'>): string | undefined {
  switch (c.type) {
    case 'comparison': {
      const f = identifierOf(c.field);
      fields.set(f, 'number');
      return `${f} ${c.operator} ${c.value}`;
    }
    case 'categorical': {
      const f = identifierOf(c.field);
      if (!fields.has(f)) fields.set(f, 'string');
      return `${f} ${c.operator} ${quote(c.value)}`;
    }
    case 'range': {
      const f = identifierOf(c.field);
      fields.set(f, 'number');
      return `(${f} >= ${c.min} && ${f} <= ${c.max})`;
    }
    case 'temporal':
      return undefined;
    case 'and':
    case 'or': {
      const parts = c.operands.map((o) => renderCondition(o, fields));
      if (parts.some((p) => p === undefined)) return undefined;
      return `(${parts.join(c.type === 'and' ? ' && ' : ' || ')})`;
    }
  }
}

function sanitizeSummary(s: string): string {
  return s
    .replace(/\{\{|\}\}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900);
}

export interface LowerOptions {
  /** Workflow version written into the definition. Default `1.0.0`. */
  readonly version?: string;
  /**
   * Compiler source id → the source's name, so step provenance names the document a person knows ("release.md § Release
   * steps") instead of an internal id. `sourceNamesOf(artifact)` builds it.
   */
  readonly sourceNames?: ReadonlyMap<string, string>;
  /** Workspace connector bindings by capability name (the `act` and `compensate` evidence). */
  readonly connectorBindings?: ReadonlyMap<string, ConnectorBinding>;
  /** How cases arrive (`text`: an extract step reads the facts) and whether the work repeats per item (`forEach`). */
  readonly intake?: 'structured' | 'text';
  /** The item the work is done for, as the goal names it ("invoice"); the run fans out over input `<item>_items`. */
  readonly forEach?: string;
}

/** Compiler source id → source name, from a compilation artifact's per-source reports. */
export function sourceNamesOf(artifact: { readonly sources: unknown }): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(artifact.sources)) return out;
  for (const s of artifact.sources as readonly { readonly sourceId?: unknown; readonly sourcePath?: unknown }[])
    if (typeof s.sourceId === 'string' && typeof s.sourcePath === 'string') out.set(s.sourceId, s.sourcePath);
  return out;
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twelve: 12,
  fourteen: 14,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  'twenty-four': 24,
  'forty-eight': 48,
  'seventy-two': 72,
};
const UNIT_MS: Readonly<Record<string, number>> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  'business day': 86_400_000,
  week: 604_800_000,
};
const AMOUNT = String.raw`(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fourteen|fifteen|twenty|thirty|twenty-four|forty-eight|seventy-two)`;
const UNIT = String.raw`(minute|hour|business day|day|week)s?`;

function durationMs(amount: string, unit: string): number {
  const n = /^\d+$/.test(amount) ? Number(amount) : (NUMBER_WORDS[amount.toLowerCase()] ?? 0);
  return n * (UNIT_MS[unit.toLowerCase()] ?? 0);
}

/** "Wait 24 hours before …" → the stated wait; `undefined` when the text states none. */
export function statedWaitMs(text: string): number | undefined {
  const m = new RegExp(String.raw`\b(?:wait|waiting)\s+(?:for\s+)?(?:at\s+least\s+)?${AMOUNT}\s+${UNIT}\b`, 'i').exec(text);
  if (m === null) return undefined;
  const ms = durationMs(m[1]!, m[2]!);
  return ms > 0 ? ms : undefined;
}

/** "… within 3 days" → the stated deadline; `undefined` when the text states none. */
export function statedDeadlineMs(text: string): number | undefined {
  const m = new RegExp(String.raw`\bwithin\s+${AMOUNT}\s+${UNIT}\b`, 'i').exec(text);
  if (m === null) return undefined;
  const ms = durationMs(m[1]!, m[2]!);
  return ms > 0 ? ms : undefined;
}

const CONTENT_STOP = new Set([
  'the',
  'a',
  'an',
  'of',
  'to',
  'must',
  'be',
  'is',
  'should',
  'shall',
  'will',
  'then',
  'and',
  'or',
  'it',
  'this',
  'that',
]);
const contentWords = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(' ')
      .filter((w) => w.length > 2 && !CONTENT_STOP.has(w))
      .map((w) => (w.length > 4 && w.endsWith('ed') ? w.slice(0, -2) : w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w)),
  );

/** A rule outcome names a step when every content word of the step's name appears in the outcome (at least two words). */
function outcomeNames(outcome: string, stepName: string): boolean {
  const o = contentWords(outcome);
  const n = contentWords(stepName);
  if (n.size < 2) return false;
  for (const w of n) if (!o.has(w)) return false;
  return true;
}

function scalarType(t: string | undefined): 'string' | 'number' | 'boolean' {
  return t === 'number' || t === 'boolean' ? t : 'string';
}

type PlannedStep =
  | {
      readonly kind: 'human';
      readonly id: string;
      readonly cs: CandidateWorkflow['steps'][number];
      readonly report: CapabilityReport;
      readonly provenance: readonly string[];
    }
  | {
      readonly kind: 'decide';
      readonly id: string;
      readonly cs: CandidateWorkflow['steps'][number];
      readonly rules: readonly { id: string; when: string; set: Record<string, string> }[];
      readonly fields: ReadonlyMap<string, 'number' | 'string'>;
      readonly provenance: readonly string[];
    }
  | {
      readonly kind: 'act';
      readonly id: string;
      readonly cs: CandidateWorkflow['steps'][number];
      readonly binding: ConnectorBinding;
      /** Absent for a binding with arguments over a step that declares no operation (a person's task, a prose action). */
      readonly contract?: SemanticCapabilityContract;
      readonly provenance: readonly string[];
    };

export function lowerCandidateWorkflow(
  graph: XoirGraph,
  candidate: CandidateWorkflow,
  inventory: CapabilityInventory,
  options: LowerOptions = {},
): LoweredWorkflow {
  const reports = new Map(inventory.capabilities.map((c) => [c.capabilityId, c] as const));
  const issues: LoweringIssue[] = [];
  const rationale: StepRationale[] = [];

  // ---- pass 1: what each candidate step is, from its capability report (nothing generated for an unbound step)
  const plan: PlannedStep[] = [];
  for (const cs of candidate.steps) {
    const report: CapabilityReport | undefined = reports.get(cs.capabilityId);
    const id = stepIdOf(cs.order, cs.capabilityName);
    const provenance = [
      ...new Set(
        (report?.evidence ?? []).map(
          (e) =>
            `${options.sourceNames?.get(e.documentPath) ?? e.documentPath}${e.sectionPath !== undefined ? ` § ${e.sectionPath.join(' > ')}` : ''}`,
        ),
      ),
    ].slice(0, 8);
    if (report === undefined || report.readiness.bound.value !== 'yes') {
      issues.push({
        stepId: id,
        capabilityId: cs.capabilityId,
        severity: 'blocking',
        code: 'unbound',
        message: `"${cs.capabilityName}" is not bound${report !== undefined ? ` (${report.readiness.bound.reason})` : ''}; no step is generated for it`,
      });
      continue;
    }
    if (report.readiness.runtimeSupported.value !== 'yes')
      issues.push({
        stepId: id,
        capabilityId: cs.capabilityId,
        severity: 'blocking',
        code: 'not_runtime_supported',
        message: `"${cs.capabilityName}": ${report.readiness.runtimeSupported.reason}`,
      });
    const strategy = report.readiness.bound.strategy;
    if (strategy === 'human_in_the_loop' && report.humanTask !== undefined) {
      plan.push({ kind: 'human', id, cs, report, provenance });
      continue;
    }
    if (strategy === 'deterministic_rule') {
      const built = buildSemanticCapabilityContract(graph, cs.capabilityId as XoirNodeId);
      const contract: SemanticCapabilityContract | undefined = built.ok ? built.value : undefined;
      const fields = new Map<string, 'number' | 'string'>();
      const rules: { id: string; when: string; set: Record<string, string> }[] = [];
      let unrenderable: string | undefined;
      for (const [i, r] of (contract?.rules ?? []).entries()) {
        const when =
          r.structuredCondition !== undefined && r.exceptionConditions.length === 0
            ? renderCondition(r.structuredCondition, fields)
            : undefined;
        if (when === undefined) {
          unrenderable = r.condition;
          break;
        }
        rules.push({ id: `r${i + 1}`, when, set: { outcome: r.outcome ?? 'condition holds' } });
      }
      if (unrenderable !== undefined || rules.length === 0) {
        issues.push({
          stepId: id,
          capabilityId: cs.capabilityId,
          severity: 'blocking',
          code: 'unsupported_for_generation',
          message: `"${cs.capabilityName}": the rule "${unrenderable ?? '(none)'}" has no faithful rendering in the workflow expression language; author this step`,
        });
        continue;
      }
      plan.push({ kind: 'decide', id, cs, rules, fields, provenance });
      continue;
    }
    if (strategy === 'external_tool') {
      const binding = options.connectorBindings?.get(cs.capabilityName);
      const built = buildSemanticCapabilityContract(graph, cs.capabilityId as XoirNodeId);
      // V1-1: a binding with arguments needs no declared operation: the operator named every argument.
      if (binding?.arguments !== undefined) {
        plan.push({ kind: 'act', id, cs, binding, ...(built.ok ? { contract: built.value } : {}), provenance });
        continue;
      }
      if (binding === undefined || !built.ok) {
        issues.push({
          stepId: id,
          capabilityId: cs.capabilityId,
          severity: 'blocking',
          code: 'unsupported_for_generation',
          message: `"${cs.capabilityName}" is a declared operation with no connector binding in this workspace: bind it to a connector operation (and its side effect) to generate the act step`,
        });
        continue;
      }
      plan.push({ kind: 'act', id, cs, binding, contract: built.value, provenance });
      continue;
    }
    issues.push({
      stepId: id,
      capabilityId: cs.capabilityId,
      severity: 'blocking',
      code: 'unsupported_for_generation',
      message: `"${cs.capabilityName}" is bound ${strategy ?? 'to an unknown strategy'}; generation has no construct for it`,
    });
  }

  // ---- shared intake: per-item fan-out and free-text reading
  const overInput = options.forEach !== undefined ? `${identifierOf(options.forEach)}_items` : undefined;
  const ref = (f: string): string => (overInput !== undefined ? `item.${f}` : `input.${f}`);
  const workflowInputs: Record<string, InputSpec> = {};
  const declareInput = (f: string, spec: InputSpec): void => {
    if (overInput === undefined) workflowInputs[f] ??= spec;
  };
  const steps: Step[] = [];
  const decideFields = new Map<string, 'number' | 'string'>();
  for (const p of plan) if (p.kind === 'decide') for (const [f, t] of p.fields) if (!decideFields.has(f)) decideFields.set(f, t);
  const extracting = options.intake === 'text' && decideFields.size > 0;
  if (extracting) {
    const textIn = overInput !== undefined ? 'item.case_text' : 'input.case_text';
    const factsIn = overInput !== undefined ? 'item.case_facts' : 'input.case_facts';
    if (overInput === undefined) {
      workflowInputs['case_text'] = { type: 'string', description: 'the case as written', required: false };
      workflowInputs['case_facts'] = {
        type: 'json',
        maxBytes: 65_536,
        description: 'the case facts, when they arrive structured',
        required: false,
      };
    }
    steps.push({
      id: 'extract_facts',
      type: 'extract',
      determinism: 'model_assisted',
      description:
        'Structured intake bypasses the model; a written case is read once into the facts the rules need, each quoted from the text.',
      instruction: `Read the case and state each of these facts exactly as written: ${[...decideFields.keys()].join(', ')}. Leave a fact null when the case does not state it. Quote the sentence each fact comes from.`,
      requires: ['structured_output'],
      structuredFirst: true,
      grounding: 'quote_required',
      maxModelCalls: 1,
      inputs: { text: { from: textIn, optional: true }, structured: { from: factsIn, optional: true } },
      outputs: Object.fromEntries([...decideFields].map(([f, t]) => [f, { type: t, nullable: true }])),
      timeoutMs: 60_000,
      retry: { maxAttempts: 2, backoff: { kind: 'exponential', baseMs: 500, maxMs: 5_000, jitter: 'full' } },
      onError: 'escalate',
    });
    rationale.push({
      stepId: 'extract_facts',
      capabilityId: '',
      capabilityName: 'Read the case',
      construct: 'extract',
      reason: GENERATION_CONSTRUCTS.extract,
    });
  }

  // ---- branches: a decide step whose outcomes name later steps
  const routedBy = new Map<string, { branch: string; route: string }>();
  const branchFor = new Map<string, { id: string; cases: { route: string; when: string }[] }>();
  for (const [i, p] of plan.entries()) {
    if (p.kind !== 'decide') continue;
    const cases: { route: string; when: string }[] = [];
    for (const later of plan.slice(i + 1)) {
      if (routedBy.has(later.id)) continue;
      const named = p.rules.filter((r) => outcomeNames(r.set['outcome'] ?? '', later.cs.capabilityName));
      if (named.length === 0) continue;
      const branch = `${p.id}_route`.slice(0, 64);
      cases.push({ route: later.id, when: named.map((r) => `outcome == ${quote(r.set['outcome'] ?? '')}`).join(' || ') });
      routedBy.set(later.id, { branch, route: later.id });
    }
    if (cases.length > 0) branchFor.set(p.id, { id: `${p.id}_route`.slice(0, 64), cases });
  }

  // ---- pass 2: the steps
  const connectors = new Map<string, { id: string; kind: ConnectorBinding['kind']; ops: Map<string, ConnectorBinding['sideEffect']> }>();
  let previous: string | undefined = extracting ? 'extract_facts' : undefined;
  let lastHuman: string | undefined;
  for (const p of plan) {
    const needs = new Set<string>(previous !== undefined ? [previous] : []);
    const inputs: Record<string, { from: string; optional?: boolean } | { const: string | number | boolean }> = {};
    const guards: string[] = [];
    // After a person's task, everything until the next task runs only when the person confirmed it; a refusal (or a skipped
    // task, which leaves no decision) skips the rest, never runs it on the assumption that the task happened.
    if (lastHuman !== undefined) {
      inputs['previous_decision'] = { from: `steps.${lastHuman}.decision`, optional: true };
      guards.push("previous_decision == 'approved'");
    }
    const routed = routedBy.get(p.id);
    if (routed !== undefined) {
      needs.add(routed.branch);
      inputs['route'] = { from: `steps.${routed.branch}.route`, optional: true };
      guards.push(`route == ${quote(routed.route)}`);
    }
    const runIf = guards.length > 0 ? { runIf: guards.join(' && ') } : {};
    const prov = p.provenance.length > 0 ? { provenance: p.provenance } : {};

    if (p.kind === 'human') {
      const t = p.report.humanTask!;
      const text = `${t.instruction} ${t.doneWhen ?? ''}`;
      const wait = statedWaitMs(t.instruction);
      if (wait !== undefined) {
        const waitId = `${p.id}_wait`.slice(0, 64);
        steps.push({
          id: waitId,
          type: 'wait',
          determinism: 'deterministic',
          ...(needs.size > 0 ? { needs: [...needs] } : {}),
          ...(Object.keys(inputs).length > 0 ? { inputs: { ...inputs } } : {}),
          ...runIf,
          for: { kind: 'timer', delayMs: wait },
          onTimeout: 'fail',
          timeoutMs: wait + 60_000,
          description: `The source states a wait before "${sanitizeSummary(p.cs.capabilityName)}"`,
          ...prov,
        });
        rationale.push({
          stepId: waitId,
          capabilityId: p.cs.capabilityId,
          capabilityName: p.cs.capabilityName,
          construct: 'wait',
          reason: GENERATION_CONSTRUCTS.wait,
        });
        needs.clear();
        needs.add(waitId);
      }
      for (const name of t.requiredInputs) {
        const f = identifierOf(name);
        inputs[f] = { from: ref(f) };
        declareInput(f, { type: 'string', description: name, required: true });
      }
      const deadline = statedDeadlineMs(text);
      steps.push({
        id: p.id,
        type: 'approve',
        determinism: 'human',
        ...(needs.size > 0 ? { needs: [...needs] } : {}),
        ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
        ...runIf,
        ...(t.requiredInputs.length > 0 ? { evidence: t.requiredInputs.map(identifierOf) } : {}),
        roles: ['reviewer'],
        outputs: { decision: { type: 'enum', enum: ['approved', 'rejected'], description: 'approved: the task is done as instructed' } },
        summary: sanitizeSummary(
          `${t.instruction}${t.doneWhen !== undefined ? ` Done when: ${t.doneWhen}` : ''} (role: ${t.actorRole.derivation === 'stated' ? t.actorRole.value : 'not stated in the source'})`,
        ),
        onTimeout: 'escalate',
        timeoutMs: deadline ?? STEP_TIMEOUT_HUMAN_MS,
        description: sanitizeSummary(p.cs.capabilityName),
        ...prov,
      });
      rationale.push({
        stepId: p.id,
        capabilityId: p.cs.capabilityId,
        capabilityName: p.cs.capabilityName,
        construct: 'approve',
        reason: `bound human_in_the_loop under its ${t.origin} human task contract: a person does it and confirms${deadline !== undefined ? '; the deadline is the one the source states' : ''}`,
      });
      // UW-7 (ADR 0033, found by the engine-parity test): a person reporting that the task was NOT done stops the workflow and
      // hands it back to a person. Without this the rest is skipped and the run would end "completed" although the work was not done.
      const notDoneId = `${p.id}_not_done`.slice(0, 64);
      steps.push({
        id: notDoneId,
        type: 'escalate',
        determinism: 'human',
        needs: [p.id],
        inputs: { decision: { from: `steps.${p.id}.decision`, optional: true } },
        runIf: "decision == 'rejected'",
        target: t.actorRole.derivation === 'stated' ? sanitizeSummary(t.actorRole.value) : 'reviewer',
        reason: sanitizeSummary(
          `A person reported that "${p.cs.capabilityName}" was not done as instructed, so the rest of the workflow did not run`,
        ),
        timeoutMs: STEP_TIMEOUT_DECIDE_MS,
        description: sanitizeSummary(`${p.cs.capabilityName}: not done`),
        ...prov,
      });
      rationale.push({
        stepId: notDoneId,
        capabilityId: p.cs.capabilityId,
        capabilityName: p.cs.capabilityName,
        construct: 'escalate',
        reason: 'a person reported the task was not done: the workflow stops and goes back to a person instead of ending as completed',
      });
      // What follows needs the escalation (which is skipped when the task was done): a refused task therefore stops the run before
      // anything after it is even considered, and no later step ever reads the decision of a task that was skipped.
      previous = notDoneId;
      lastHuman = p.id;
      continue;
    }

    if (p.kind === 'decide') {
      for (const [f, type] of p.fields) {
        inputs[f] = extracting ? { from: `steps.extract_facts.${f}` } : { from: ref(f) };
        if (!extracting) declareInput(f, { type, required: true });
      }
      steps.push({
        id: p.id,
        type: 'decide',
        determinism: 'deterministic',
        ...(needs.size > 0 ? { needs: [...needs] } : {}),
        inputs,
        ...runIf,
        method: { kind: 'rules', rules: p.rules, onNoMatch: 'escalate' },
        outputs: { outcome: { type: 'string' } },
        timeoutMs: STEP_TIMEOUT_DECIDE_MS,
        description: sanitizeSummary(p.cs.capabilityName),
        ...prov,
      });
      rationale.push({
        stepId: p.id,
        capabilityId: p.cs.capabilityId,
        capabilityName: p.cs.capabilityName,
        construct: 'decide',
        reason: `bound deterministic_rule: ${p.rules.length} rule(s) rendered from the source's structured conditions; no match escalates`,
      });
      previous = p.id;
      const branch = branchFor.get(p.id);
      if (branch !== undefined) {
        steps.push({
          id: branch.id,
          type: 'branch',
          determinism: 'deterministic',
          needs: [p.id],
          inputs: { outcome: { from: `steps.${p.id}.outcome` } },
          cases: branch.cases,
          default: 'none',
          outputs: { route: { type: 'string' } },
          timeoutMs: STEP_TIMEOUT_DECIDE_MS,
          description: `Routes on the outcome of "${sanitizeSummary(p.cs.capabilityName)}"`,
        });
        rationale.push({
          stepId: branch.id,
          capabilityId: p.cs.capabilityId,
          capabilityName: p.cs.capabilityName,
          construct: 'branch',
          reason: GENERATION_CONSTRUCTS.branch,
        });
      }
      continue;
    }

    // act
    const b = p.binding;
    if (b.arguments !== undefined) {
      // V1-1: the operator's argument map, verbatim: a field of the item (or input), or a constant.
      for (const [name, a] of Object.entries(b.arguments)) {
        if ('const' in a) inputs[name] = { const: a.const };
        else {
          inputs[name] = { from: ref(a.field) };
          declareInput(a.field, { type: 'string', description: a.field, required: true });
        }
      }
    } else
      for (const param of p.contract!.inputs) {
        const f = contractFieldName(param.name);
        inputs[f] = { from: ref(f) };
        declareInput(f, { type: scalarType(param.semanticType), description: param.name, required: param.required ?? true });
      }
    const effectful = b.sideEffect !== 'read';
    const key = overInput !== undefined ? '{{workflow.id}}:{{run.id}}:{{run.index}}:{{step.id}}' : '{{workflow.id}}:{{run.id}}:{{step.id}}';
    const undoId = b.compensation !== undefined ? `${p.id}_undo`.slice(0, 64) : undefined;
    const c = connectors.get(b.connector) ?? { id: b.connector, kind: b.kind, ops: new Map() };
    c.ops.set(b.operation, b.sideEffect);
    if (b.compensation !== undefined) c.ops.set(b.compensation.operation, b.compensation.sideEffect);
    connectors.set(b.connector, c);
    const outputs =
      b.arguments !== undefined
        ? {}
        : Object.fromEntries(p.contract!.outputs.map((o) => [contractFieldName(o.name), { type: scalarType(o.semanticType) }]));
    steps.push({
      id: p.id,
      type: 'act',
      determinism: 'deterministic',
      ...(needs.size > 0 ? { needs: [...needs] } : {}),
      ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
      ...runIf,
      connector: b.connector,
      operation: b.operation,
      sideEffect: b.sideEffect,
      ...(effectful ? { idempotencyKey: key } : {}),
      ...(undoId !== undefined ? { compensatedBy: undoId } : {}),
      ...(Object.keys(outputs).length > 0 ? { outputs } : {}),
      timeoutMs: 30_000,
      onError: b.sideEffect === 'irreversible' ? 'escalate' : undoId !== undefined ? 'compensate' : 'escalate',
      description: sanitizeSummary(p.cs.capabilityName),
      ...prov,
    });
    rationale.push({
      stepId: p.id,
      capabilityId: p.cs.capabilityId,
      capabilityName: p.cs.capabilityName,
      construct: 'act',
      reason:
        b.arguments !== undefined
          ? `carried out by ${b.connector}.${b.operation} (${b.sideEffect}) with the arguments the workspace's binding maps`
          : `bound to ${b.connector}.${b.operation} (${b.sideEffect}) by the workspace`,
    });
    if (undoId !== undefined && b.compensation !== undefined) {
      const undoInputs = Object.fromEntries(Object.entries(inputs).filter(([k]) => k !== 'previous_decision' && k !== 'route'));
      steps.push({
        id: undoId,
        type: 'compensate',
        determinism: 'deterministic',
        compensates: p.id,
        connector: b.connector,
        operation: b.compensation.operation,
        sideEffect: b.compensation.sideEffect,
        ...(Object.keys(undoInputs).length > 0 ? { inputs: undoInputs } : {}),
        ...(b.compensation.sideEffect !== 'read' ? { idempotencyKey: `${key}:undo` } : {}),
        timeoutMs: 30_000,
        description: `Undoes "${sanitizeSummary(p.cs.capabilityName)}" on rollback`,
      });
      rationale.push({
        stepId: undoId,
        capabilityId: p.cs.capabilityId,
        capabilityName: p.cs.capabilityName,
        construct: 'compensate',
        reason: GENERATION_CONSTRUCTS.compensate,
      });
    }
    previous = p.id;
  }

  let component: WorkflowComponent | undefined;
  if (steps.length > 0 && plan.length > 0) {
    if (overInput !== undefined)
      workflowInputs[overInput] = {
        type: 'json',
        maxBytes: 1_048_576,
        description: `the ${options.forEach} items, one run each`,
        required: true,
      };
    const features = new Set<WorkflowFeature>();
    for (const st of steps) {
      if (st.type === 'approve') features.add('approve');
      if (st.type === 'decide') features.add('rules');
      if (st.type === 'extract') features.add('model_extract');
      if (st.type === 'wait') features.add(st.for.kind === 'timer' ? 'wait_timer' : 'wait_event');
      if (st.type === 'compensate') features.add('compensation');
    }
    if (overInput !== undefined) features.add('for_each');
    const def: WorkflowDef = {
      id: workflowIdOf(candidate.name),
      version: options.version ?? '1.0.0',
      description: sanitizeSummary(candidate.description || candidate.name),
      triggers: [{ id: 'api', kind: 'api' }],
      inputs: workflowInputs,
      steps,
      ...(overInput !== undefined ? { forEach: { over: overInput, maxItems: 1000, concurrency: 1 } } : {}),
      maxConcurrency: 1,
      runTimeoutMs: steps.reduce((n, st) => n + st.timeoutMs, 0) + 60_000,
      cancellation: { onCancel: steps.some((st) => st.type === 'compensate') ? 'compensate' : 'abandon' },
      ...(features.size > 0 ? { requiresFeatures: [...features].sort() } : {}),
    };
    if (overInput !== undefined)
      rationale.push({
        stepId: '(workflow)',
        capabilityId: '',
        capabilityName: `each ${options.forEach}`,
        construct: 'for_each',
        reason: GENERATION_CONSTRUCTS.for_each,
      });
    component = {
      formatVersion: WORKFLOW_FORMAT_VERSION,
      semanticsVersion: WORKFLOW_SEMANTICS_VERSION,
      connectors: [...connectors.values()]
        .sort((x, y) => x.id.localeCompare(y.id))
        .map((c) => ({
          id: c.id,
          kind: c.kind,
          operations: [...c.ops].sort(([x], [y]) => x.localeCompare(y)).map(([name, sideEffect]) => ({ name, sideEffect })),
        })),
      workflows: [def],
    };
  } else {
    issues.push({ severity: 'blocking', code: 'empty', message: 'no step of the candidate workflow could be generated' });
  }

  const validation = component !== undefined ? validateWorkflowComponent(component) : { valid: false, issues: [] };
  for (const v of validation.issues)
    if (v.severity === 'error')
      issues.push({ severity: 'blocking', code: 'invalid_definition', message: `${v.code} at ${v.path}: ${v.message}` });

  return {
    schema: WORKFLOW_LOWERING_VERSION,
    candidateWorkflowId: candidate.id,
    ...(component !== undefined ? { component } : {}),
    rationale,
    issues,
    validation: { valid: validation.valid, issues: validation.issues },
    definitionDigest: digestOf(component ?? null),
    complete: component !== undefined && validation.valid && issues.every((i) => i.severity !== 'blocking'),
  };
}
