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
  type WorkflowIssue,
} from '@xo/workflow-ir';
import type { XoirGraph, XoirNodeId } from '@xo/xoir';
import { digestOf, type Digest } from './canonical.js';
import type { CapabilityInventory, CapabilityReport } from './capability-inventory.js';

export const WORKFLOW_LOWERING_VERSION = 'xo.workflow-lowering.v1';

/** Every Workflow IR construct, and whether generation from compiled capabilities emits it (decision 13). */
export const GENERATION_CONSTRUCTS = {
  decide_rules: 'generated: a rule-bound capability whose conditions render in the expression language',
  approve: 'generated: a capability with a human task contract',
  sequence: 'generated: the composed order (needs)',
  branch: 'not generated: rule outcomes are recorded as decide outputs; routing on them is authored',
  act: 'not generated: connector operations and their side effects are bound by the host, never guessed',
  wait: 'not generated: no source construct states a wait',
  compensate: 'not generated: no source construct states an undo',
  for_each: 'not generated: no source construct states a fan-out',
  extract: 'not generated: inputs arrive structured; free-text extraction is authored',
  escalate: 'emitted only by the runtime on a decide step with no matching rule',
} as const;

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
  readonly construct: Step['type'];
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
}

/** Compiler source id → source name, from a compilation artifact's per-source reports. */
export function sourceNamesOf(artifact: { readonly sources: unknown }): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(artifact.sources)) return out;
  for (const s of artifact.sources as readonly { readonly sourceId?: unknown; readonly sourcePath?: unknown }[])
    if (typeof s.sourceId === 'string' && typeof s.sourcePath === 'string') out.set(s.sourceId, s.sourcePath);
  return out;
}

export function lowerCandidateWorkflow(
  graph: XoirGraph,
  candidate: CandidateWorkflow,
  inventory: CapabilityInventory,
  options: LowerOptions = {},
): LoweredWorkflow {
  const reports = new Map(inventory.capabilities.map((c) => [c.capabilityId, c] as const));
  const issues: LoweringIssue[] = [];
  const rationale: StepRationale[] = [];
  const steps: Step[] = [];
  const workflowInputs: Record<string, InputSpec> = {};
  let previous: string | undefined;
  let previousIsHuman = false;

  for (const cs of candidate.steps) {
    const report: CapabilityReport | undefined = reports.get(cs.capabilityId);
    const stepId = stepIdOf(cs.order, cs.capabilityName);
    const needs = previous !== undefined ? { needs: [previous] } : {};
    // After a human task, the next step runs only when the person confirmed it done; otherwise it is skipped, never run on
    // the assumption that the task happened.
    // `optional`: a skipped previous step leaves no decision, so this one is skipped too (the skip cascades).
    const gateOnPrevious: { inputs?: Record<string, { from: string; optional?: boolean }>; runIf?: string } =
      previous !== undefined && previousIsHuman
        ? {
            inputs: { previous_decision: { from: `steps.${previous}.decision`, optional: true } },
            runIf: "previous_decision == 'approved'",
          }
        : {};
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
        stepId,
        capabilityId: cs.capabilityId,
        severity: 'blocking',
        code: 'unbound',
        message: `"${cs.capabilityName}" is not bound${report !== undefined ? ` (${report.readiness.bound.reason})` : ''}; no step is generated for it`,
      });
      continue;
    }
    if (report.readiness.runtimeSupported.value !== 'yes')
      issues.push({
        stepId,
        capabilityId: cs.capabilityId,
        severity: 'blocking',
        code: 'not_runtime_supported',
        message: `"${cs.capabilityName}": ${report.readiness.runtimeSupported.reason}`,
      });

    const strategy = report.readiness.bound.strategy;
    if (strategy === 'human_in_the_loop' && report.humanTask !== undefined) {
      const t = report.humanTask;
      const inputs: Record<string, { from: string; optional?: boolean }> = { ...(gateOnPrevious.inputs ?? {}) };
      for (const name of t.requiredInputs) {
        const id = identifierOf(name);
        inputs[id] = { from: `input.${id}` };
        workflowInputs[id] ??= { type: 'string', description: name, required: true };
      }
      steps.push({
        id: stepId,
        type: 'approve',
        determinism: 'human',
        ...needs,
        ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
        ...(gateOnPrevious.runIf !== undefined ? { runIf: gateOnPrevious.runIf } : {}),
        ...(t.requiredInputs.length > 0 ? { evidence: t.requiredInputs.map(identifierOf) } : {}),
        roles: ['reviewer'],
        // The person confirms the task is done (`approved`) or that it could not be done (`rejected`).
        outputs: { decision: { type: 'enum', enum: ['approved', 'rejected'], description: 'approved: the task is done as instructed' } },
        summary: sanitizeSummary(
          `${t.instruction}${t.doneWhen !== undefined ? ` Done when: ${t.doneWhen}` : ''} (role: ${t.actorRole.derivation === 'stated' ? t.actorRole.value : 'not stated in the source'})`,
        ),
        onTimeout: 'escalate',
        timeoutMs: STEP_TIMEOUT_HUMAN_MS,
        description: sanitizeSummary(cs.capabilityName),
        ...(provenance.length > 0 ? { provenance } : {}),
      });
      rationale.push({
        stepId,
        capabilityId: cs.capabilityId,
        capabilityName: cs.capabilityName,
        construct: 'approve',
        reason: `bound human_in_the_loop under its ${t.origin} human task contract: a person does it and confirms`,
      });
      previous = stepId;
      previousIsHuman = true;
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
          stepId,
          capabilityId: cs.capabilityId,
          severity: 'blocking',
          code: 'unsupported_for_generation',
          message: `"${cs.capabilityName}": the rule "${unrenderable ?? '(none)'}" has no faithful rendering in the workflow expression language; author this step`,
        });
        continue;
      }
      const inputs: Record<string, { from: string; optional?: boolean }> = { ...(gateOnPrevious.inputs ?? {}) };
      for (const [f, type] of fields) {
        inputs[f] = { from: `input.${f}` };
        workflowInputs[f] ??= { type, required: true };
      }
      steps.push({
        id: stepId,
        type: 'decide',
        determinism: 'deterministic',
        ...needs,
        inputs,
        ...(gateOnPrevious.runIf !== undefined ? { runIf: gateOnPrevious.runIf } : {}),
        method: { kind: 'rules', rules, onNoMatch: 'escalate' },
        outputs: { outcome: { type: 'string' } },
        timeoutMs: STEP_TIMEOUT_DECIDE_MS,
        description: sanitizeSummary(cs.capabilityName),
        ...(provenance.length > 0 ? { provenance } : {}),
      });
      rationale.push({
        stepId,
        capabilityId: cs.capabilityId,
        capabilityName: cs.capabilityName,
        construct: 'decide',
        reason: `bound deterministic_rule: ${rules.length} rule(s) rendered from the source's structured conditions; no match escalates`,
      });
      previous = stepId;
      previousIsHuman = false;
      continue;
    }

    issues.push({
      stepId,
      capabilityId: cs.capabilityId,
      severity: 'blocking',
      code: 'unsupported_for_generation',
      message: `"${cs.capabilityName}" is bound ${strategy ?? 'to an unknown strategy'}; ${strategy === 'external_tool' ? GENERATION_CONSTRUCTS.act : 'generation has no construct for it'}`,
    });
  }

  let component: WorkflowComponent | undefined;
  if (steps.length > 0) {
    const def: WorkflowDef = {
      id: workflowIdOf(candidate.name),
      version: options.version ?? '1.0.0',
      description: sanitizeSummary(candidate.description || candidate.name),
      triggers: [{ id: 'api', kind: 'api' }],
      inputs: workflowInputs,
      steps,
      maxConcurrency: 1,
      runTimeoutMs: steps.reduce((n, s) => n + s.timeoutMs, 0) + 60_000,
      cancellation: { onCancel: 'abandon' },
      ...(steps.some((s) => s.type === 'approve')
        ? {
            requiresFeatures: ['approve' as const, 'rules' as const].filter((f) => f !== 'rules' || steps.some((s) => s.type === 'decide')),
          }
        : steps.some((s) => s.type === 'decide')
          ? { requiresFeatures: ['rules' as const] }
          : {}),
    };
    component = { formatVersion: WORKFLOW_FORMAT_VERSION, semanticsVersion: WORKFLOW_SEMANTICS_VERSION, connectors: [], workflows: [def] };
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
