import { createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';
import { evaluateExpression, type Scope } from '@xo/capability-layer';
import {
  canonicalJson,
  expressionIdentifiers,
  sha256Hex,
  validateWorkflowComponent,
  type DecideStep,
  type Scalar,
  type WorkflowComponent,
} from '@xo/workflow-ir';
import type { ReviewerRegistry } from './approvals.js';
import type { RunStore } from './journal.js';
import { replayRun } from './runner.js';
import type { WorkflowDef } from '@xo/workflow-ir';

/**
 * The promotion loop: LEARNING, NEVER AUTO-APPLIED. Decisions a human (or model) made are logged as cases; repeated, consistent
 * patterns are proposed as rules in a reviewable patch with their supporting cases; the patch is validated against ALL logged
 * cases in shadow (agreement report); and only a publisher's signed acceptance lets `applyPatch` produce a new workflow version.
 * Nothing here edits a live workflow. The returned component must still be packaged, signed and installed like any XO version.
 *
 * Scope (honest): single-condition rules over scalar facts (equality, <=, >=), one output field, support threshold, zero counterexamples.
 * It does not learn multi-feature interactions, and unmeasured on real data.
 */

export interface LoggedCase {
  readonly id: string;
  readonly facts: Readonly<Record<string, Scalar>>;
  readonly outcome: string;
  readonly source: 'human' | 'model';
}

/** Cases from approve steps a human decided: facts are the approval case; the outcome is the decision. */
export async function casesFromApprovals(store: RunStore, wf: WorkflowDef, approveStep: string): Promise<LoggedCase[]> {
  const out: LoggedCase[] = [];
  for (const id of await store.list()) {
    const rec = replayRun(await store.read(id), wf, id);
    const s = rec?.steps.get(approveStep);
    if (s?.approval === undefined || s.outputs === undefined) continue;
    const facts: Record<string, Scalar> = {};
    for (const [k, v] of Object.entries(s.approval.request.case))
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) facts[k] = v as Scalar;
    out.push({ id, facts, outcome: String(s.outputs['decision']), source: 'human' });
  }
  return out;
}

export interface ProposedRule {
  readonly id: string;
  readonly when: string;
  readonly outcome: string;
  readonly support: number;
  readonly caseIds: readonly string[];
}

export interface RulePatch {
  readonly workflow: string;
  readonly fromVersion: string;
  readonly step: string;
  readonly outputField: string;
  readonly rules: readonly ProposedRule[];
  readonly casesHash: string;
}

const lit = (v: Scalar): string => (typeof v === 'string' ? `'${v.replace(/'/g, "\\'")}'` : String(v));

export function proposeRules(
  cases: readonly LoggedCase[],
  o: { workflow: WorkflowDef; step: string; outputField: string; minSupport?: number },
): RulePatch {
  const min = o.minSupport ?? 5;
  const rules: ProposedRule[] = [];
  const outcomes = [...new Set(cases.map((c) => c.outcome))].sort();
  const names = [...new Set(cases.flatMap((c) => Object.keys(c.facts)))].sort();
  const add = (when: string, outcome: string, ids: string[]): void => {
    if (ids.length >= min)
      rules.push({ id: `learned_${sha256Hex(when + outcome).slice(0, 8)}`, when, outcome, support: ids.length, caseIds: ids });
  };
  for (const f of names) {
    const withF = cases.filter((c) => c.facts[f] !== undefined && c.facts[f] !== null);
    const values = [...new Set(withF.map((c) => c.facts[f]))];
    for (const v of values) {
      if (typeof v === 'number') continue;
      const group = withF.filter((c) => c.facts[f] === v);
      const oc = new Set(group.map((c) => c.outcome));
      if (oc.size === 1)
        add(
          `${f} == ${lit(v as Scalar)}`,
          [...oc][0] as string,
          group.map((c) => c.id),
        );
    }
    const nums = withF.filter((c) => typeof c.facts[f] === 'number').sort((a, b) => (a.facts[f] as number) - (b.facts[f] as number));
    for (const oc of outcomes) {
      let lo = 0;
      while (lo < nums.length && nums[lo]?.outcome === oc) lo++;
      // ties at the boundary must not straddle outcomes
      while (lo > 0 && lo < nums.length && nums[lo - 1]?.facts[f] === nums[lo]?.facts[f]) lo--;
      if (lo > 0)
        add(
          `${f} <= ${nums[lo - 1]?.facts[f] as number}`,
          oc,
          nums.slice(0, lo).map((c) => c.id),
        );
      let hi = nums.length;
      while (hi > 0 && nums[hi - 1]?.outcome === oc) hi--;
      while (hi < nums.length && hi > 0 && nums[hi - 1]?.facts[f] === nums[hi]?.facts[f]) hi++;
      if (hi < nums.length)
        add(
          `${f} >= ${nums[hi]?.facts[f] as number}`,
          oc,
          nums.slice(hi).map((c) => c.id),
        );
    }
  }
  rules.sort((a, b) => b.support - a.support || (a.when < b.when ? -1 : 1));
  return {
    workflow: o.workflow.id,
    fromVersion: o.workflow.version,
    step: o.step,
    outputField: o.outputField,
    rules: rules.slice(0, 20),
    casesHash: sha256Hex(canonicalJson(cases)),
  };
}

export interface PatchValidation {
  readonly ok: boolean;
  readonly cases: number;
  readonly covered: number;
  readonly agree: number;
  readonly disagree: readonly { rule: string; caseId: string; expected: string }[];
  readonly uncovered: number;
  readonly reasons: readonly string[];
}

/** Shadow validation: evaluates every proposed rule on EVERY logged case (not only its supporters). Any disagreement fails the patch. */
export function validatePatch(patch: RulePatch, cases: readonly LoggedCase[], minSupport = 5): PatchValidation {
  const disagree: { rule: string; caseId: string; expected: string }[] = [];
  const covered = new Set<string>();
  let agree = 0;
  const reasons: string[] = [];
  if (sha256Hex(canonicalJson(cases)) !== patch.casesHash) reasons.push('the supplied cases are not the ones the patch was proposed from');
  for (const r of patch.rules) {
    if (r.support < minSupport) reasons.push(`rule ${r.id} has support ${r.support} < ${minSupport}`);
    for (const c of cases) {
      let hit = false;
      try {
        hit = Boolean(evaluateExpression(r.when, c.facts as Scope));
      } catch {
        hit = false; // a missing fact means the rule does not fire for that case
      }
      if (!hit) continue;
      covered.add(c.id);
      if (c.outcome === r.outcome) agree++;
      else disagree.push({ rule: r.id, caseId: c.id, expected: c.outcome });
    }
  }
  if (disagree.length > 0) reasons.push(`${disagree.length} logged case(s) contradict a proposed rule`);
  if (patch.rules.length === 0) reasons.push('no rule met the support threshold');
  return {
    ok: reasons.length === 0,
    cases: cases.length,
    covered: covered.size,
    agree,
    disagree,
    uncovered: cases.length - covered.size,
    reasons,
  };
}

export interface PatchAcceptance {
  readonly patchHash: string;
  readonly reviewerId: string;
  readonly signature: string;
}

export const patchHash = (p: RulePatch): string => sha256Hex(canonicalJson(p));

export function signPatchAcceptance(privateKeyPem: string, patch: RulePatch, reviewerId: string): PatchAcceptance {
  const h = patchHash(patch);
  return {
    patchHash: h,
    reviewerId,
    signature: edSign(null, Buffer.from(canonicalJson({ patchHash: h, reviewerId })), privateKeyPem).toString('base64'),
  };
}

const bump = (v: string): string => {
  const [a, b, c] = v.split('.').map(Number) as [number, number, number];
  return `${a}.${b}.${c + 1}`;
};

/**
 * Produces the next workflow version with the accepted rules placed FIRST in the target `rules` decide step. Requires: patch valid
 * against the cases, a publisher's verifying signature over the exact patch, and a resulting component that passes full validation.
 */
export function applyPatch(
  component: WorkflowComponent,
  patch: RulePatch,
  cases: readonly LoggedCase[],
  acceptance: PatchAcceptance,
  registry: ReviewerRegistry,
): WorkflowComponent {
  const v = validatePatch(patch, cases);
  if (!v.ok) throw new Error(`patch refused: ${v.reasons.join('; ')}`);
  if (acceptance.patchHash !== patchHash(patch)) throw new Error('acceptance is for a different patch');
  const reviewer = registry.get(acceptance.reviewerId);
  if (reviewer === undefined || reviewer.revoked === true || !reviewer.roles.includes('publisher'))
    throw new Error('acceptance must come from a trusted, non-revoked publisher');
  const ok = edVerify(
    null,
    Buffer.from(canonicalJson({ patchHash: acceptance.patchHash, reviewerId: acceptance.reviewerId })),
    createPublicKey(reviewer.publicKeyPem),
    Buffer.from(acceptance.signature, 'base64'),
  );
  if (!ok) throw new Error('acceptance signature does not verify');
  const wf = component.workflows.find((w) => w.id === patch.workflow && w.version === patch.fromVersion);
  if (wf === undefined) throw new Error('the workflow version the patch targets is not in this component');
  const target = wf.steps.find((s) => s.id === patch.step);
  if (target?.type !== 'decide' || target.method.kind !== 'rules') throw new Error('the target step must be a decide step using rules');
  if (Object.keys(target.outputs ?? {}).length !== 1 || !(patch.outputField in (target.outputs ?? {})))
    throw new Error('promotion supports decide steps with exactly the one output the patch sets');
  const spec = target.outputs?.[patch.outputField];
  if (spec?.type === 'enum')
    for (const r of patch.rules)
      if (!(spec.enum ?? []).includes(r.outcome))
        throw new Error(`rule outcome "${r.outcome}" is not a value of output "${patch.outputField}"`);
  // Learned rules may read facts the step does not take yet. Wire each from the workflow input of the same name, or refuse.
  const stepInputs: Record<string, { from: string; optional?: boolean }> = { ...(target.inputs as Record<string, { from: string }>) };
  for (const r of patch.rules)
    for (const id of expressionIdentifiers(r.when))
      if (!(id in stepInputs)) {
        if (!(id in wf.inputs)) throw new Error(`rule "${r.when}" reads "${id}", which is neither a step input nor a workflow input`);
        stepInputs[id] = { from: `input.${id}`, optional: true };
      }
  const learned = patch.rules.map((r) => ({ id: r.id, when: r.when, set: { [patch.outputField]: r.outcome } }));
  const existing = new Set(target.method.rules.map((r) => r.id));
  const merged: DecideStep = {
    ...target,
    inputs: stepInputs,
    method: { ...target.method, rules: [...learned.filter((r) => !existing.has(r.id)), ...target.method.rules] },
  };
  const next: WorkflowDef = { ...wf, version: bump(wf.version), steps: wf.steps.map((s) => (s.id === patch.step ? merged : s)) };
  const out: WorkflowComponent = { ...component, workflows: component.workflows.map((w) => (w === wf ? next : w)) };
  const val = validateWorkflowComponent(out);
  if (!val.valid)
    throw new Error(
      `patched component is invalid: ${val.issues
        .filter((i) => i.severity === 'error')
        .map((i) => `${i.code} ${i.path}: ${i.message}`)
        .join('; ')}`,
    );
  return out;
}
