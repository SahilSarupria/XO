import {
  evaluateExpression,
  evaluateTree,
  ExpressionError,
  MissingFactError,
  type DecisionTree,
  type Scope,
  type Value,
} from '@xo/capability-layer';
import type { DecideStep, FieldSpec, Scalar } from './types.js';

/**
 * Pure evaluation of a `decide` step. No clock, no randomness, no I/O, no model.
 * Identical valid inputs and an identical workflow version produce an identical
 * result on every conforming runtime (numbers are IEEE-754 binary64; the
 * expression language is the closed one in docs/LAYER_CONTRACT.md).
 *
 * Every failure is a structured refusal: the caller MUST treat any `ok:false` as
 * "escalate to a human", never as a default decision.
 */

export type DecideFailure =
  | { readonly ok: false; readonly code: 'missing_fact'; readonly detail: string }
  | { readonly ok: false; readonly code: 'invalid_input'; readonly detail: string }
  | { readonly ok: false; readonly code: 'no_match'; readonly detail: string }
  | { readonly ok: false; readonly code: 'lookup_miss'; readonly detail: string }
  | { readonly ok: false; readonly code: 'eval_error'; readonly detail: string }
  | { readonly ok: false; readonly code: 'invalid_output'; readonly detail: string }
  | { readonly ok: false; readonly code: 'tree_unavailable'; readonly detail: string };

export interface DecideSuccess {
  readonly ok: true;
  readonly outputs: Readonly<Record<string, Scalar>>;
  /** Rule ids / lookup row keys / tree rule refs that produced the outputs, for audit and `xo explain`. */
  readonly rulesFired: readonly string[];
}

export type DecideResult = DecideSuccess | DecideFailure;

const fail = (code: DecideFailure['code'], detail: string): DecideFailure => ({ ok: false, code, detail }) as DecideFailure;

function checkOutput(name: string, spec: FieldSpec | undefined, v: unknown): string | undefined {
  if (spec === undefined) return `unexpected output "${name}"`;
  if (v === undefined) return `output "${name}" was not produced`;
  if (v === null) return spec.nullable === true ? undefined : `output "${name}" must not be null`;
  switch (spec.type) {
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? undefined : `output "${name}" must be a finite number`;
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v) ? undefined : `output "${name}" must be an integer`;
    case 'boolean':
      return typeof v === 'boolean' ? undefined : `output "${name}" must be a boolean`;
    case 'string':
      return typeof v === 'string' ? undefined : `output "${name}" must be a string`;
    case 'enum':
      return typeof v === 'string' && (spec.enum ?? []).includes(v)
        ? undefined
        : `output "${name}" must be one of ${(spec.enum ?? []).join(', ')}`;
    case 'json':
      return undefined;
  }
}

function finish(step: DecideStep, outputs: Record<string, Scalar>, rulesFired: string[]): DecideResult {
  const specs = step.outputs ?? {};
  for (const name of Object.keys(specs)) {
    const p = checkOutput(name, specs[name], outputs[name]);
    if (p !== undefined) return fail('invalid_output', p);
  }
  const extra = Object.keys(outputs).find((k) => !(k in specs));
  if (extra !== undefined) return fail('invalid_output', `unexpected output "${extra}"`);
  return { ok: true, outputs, rulesFired };
}

const toScope = (inputs: Readonly<Record<string, unknown>>): Scope => {
  const s: Record<string, Value | undefined> = {};
  for (const [k, v] of Object.entries(inputs)) s[k] = v as Value | undefined;
  return s;
};

export interface EvaluateDecideOptions {
  /** Trees from the package's decision_trees component, required for `method.kind === 'tree'`. */
  readonly trees?: ReadonlyMap<string, DecisionTree>;
}

export function evaluateDecide(
  step: DecideStep,
  inputs: Readonly<Record<string, unknown>>,
  options: EvaluateDecideOptions = {},
): DecideResult {
  const m = step.method;
  try {
    if (m.kind === 'tree') {
      const tree = options.trees?.get(m.treeId);
      if (tree === undefined) return fail('tree_unavailable', `decision tree "${m.treeId}" is not loaded`);
      // For tree steps only, a null input means "not stated" and is passed as an absent fact so the tree reports it missing instead of guessing.
      const facts = Object.fromEntries(Object.entries(inputs).filter(([, v]) => v !== null && v !== undefined));
      const r = evaluateTree(tree, facts);
      if (!r.ok) {
        if (r.error === 'missing_facts') return fail('missing_fact', r.missing.map((x) => x.name).join(', '));
        if (r.error === 'invalid_facts') return fail('invalid_input', r.problems.join('; '));
        return fail('eval_error', r.message);
      }
      const out: Record<string, Scalar> = {};
      for (const k of Object.keys(step.outputs ?? {})) out[k] = (r.output[k] ?? null) as Scalar;
      for (const k of Object.keys(step.outputs ?? {}))
        if (r.output[k] === undefined) return fail('invalid_output', `tree did not produce "${k}"`);
      return finish(step, out, [...r.rules]);
    }
    if (m.kind === 'rules') {
      const scope = toScope(inputs);
      for (const rule of m.rules) if (Boolean(evaluateExpression(rule.when, scope))) return finish(step, { ...rule.set }, [rule.id]);
      if (m.onNoMatch === 'default' && m.default !== undefined) return finish(step, { ...m.default }, ['default']);
      return fail('no_match', 'no rule matched');
    }
    if (m.kind === 'formula') {
      const scope: Record<string, Value | undefined> = { ...toScope(inputs) };
      const out: Record<string, Scalar> = {};
      for (const [name, src] of Object.entries(m.set)) {
        const v = evaluateExpression(src, scope);
        out[name] = v;
        scope[name] = v;
      }
      return finish(step, out, Object.keys(m.set));
    }
    // lookup: exact, type-strict match on every key column
    const keyVals = m.keys.map((k) => inputs[k]);
    if (keyVals.some((v) => v === undefined || v === null))
      return fail('missing_fact', m.keys.filter((k) => inputs[k] === undefined || inputs[k] === null).join(', '));
    const idx = m.rows.findIndex((row) => m.keys.every((k, i) => row[k] === keyVals[i]));
    if (idx === -1) return fail('lookup_miss', `no row for ${JSON.stringify(Object.fromEntries(m.keys.map((k, i) => [k, keyVals[i]])))}`);
    const row = m.rows[idx] as Readonly<Record<string, Scalar>>;
    const out: Record<string, Scalar> = {};
    for (const k of Object.keys(step.outputs ?? {})) out[k] = row[k] as Scalar;
    return finish(step, out, [`row:${idx}`]);
  } catch (e) {
    if (e instanceof MissingFactError) return fail('missing_fact', e.fact);
    if (e instanceof ExpressionError) return fail('eval_error', e.message);
    throw e;
  }
}
