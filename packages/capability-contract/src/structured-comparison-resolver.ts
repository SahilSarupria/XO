import { parseComparisonCondition, evaluateComparison } from './comparison-grammar.js';
import type { BindingOutcome, BindingResolver, CapabilityBinding, SemanticCapabilityContract, SemanticCapabilityParameter, SemanticCapabilityRule, Result_LikeUnknown } from './types.js';
import type { StructuredCondition } from './structured-expression-grammar.js';

const RESOLVER_NAME = 'structured-comparison-resolver';

const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'to']);

/** `"the claimed loss amount"` -> `"claimed_loss_amount"` — the fallback runtime-input key convention used only when the contract declares no `inputs` for a field phrase to be matched against (see `resolveFieldKey`'s doc comment). Same conservative style as `@xo/compiler`'s `capability-id.ts#normalizeCapabilityName`: lowercase, punctuation stripped, whitespace-delimited words, stop words removed — deterministic, no stemming/synonym folding (this module doesn't need `capability-id.ts`'s convergence behavior, only a stable key). */
export function normalizeToFallbackKey(phrase: string): string {
  const words = phrase
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w));
  return words.join('_');
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w))
    .join(' ');
}

/**
 * Resolves a parsed condition's `fieldPhrase` to the runtime-input object
 * key `evaluate` will read. If the contract declares `inputs`, the field
 * phrase must match (normalized, whole-word-set) exactly one declared
 * input's `name` — declared inputs are an allow-list, never bypassed by a
 * close-enough guess, so an unmatched field phrase is a resolution
 * failure, not a fabricated mapping. If the contract declares no inputs
 * at all (the common case — `@xo/compiler`'s rule-based extractor rarely
 * populates `Capability.inputs`), the field phrase's own normalized,
 * stop-word-stripped, underscore-joined form (`normalizeToFallbackKey`)
 * becomes the required key — documented, not inferred per-call.
 */
function resolveFieldKey(fieldPhrase: string, declaredInputs: readonly SemanticCapabilityParameter[]): { readonly key: string; readonly matchedDeclaredInput: boolean } | undefined {
  if (declaredInputs.length === 0) {
    return { key: normalizeToFallbackKey(fieldPhrase), matchedDeclaredInput: false };
  }
  const normalizedPhrase = normalizeForMatch(fieldPhrase);
  const matches = declaredInputs.filter((input) => normalizeForMatch(input.name) === normalizedPhrase);
  if (matches.length !== 1) return undefined;
  return { key: normalizeToFallbackKey(matches[0]!.name), matchedDeclaredInput: true };
}

// ---------------------------------------------------------------------------
// Phase 2: compiling a `StructuredCondition` (comparison / categorical /
// range / and / or) into a evaluable `CompiledCheck` tree. A leaf whose
// shape this resolver cannot safely lower to a deterministic binding
// today — currently only `'temporal'` — fails compilation of the WHOLE
// rule (never a partial tree with that leaf silently dropped), exactly
// the same all-or-nothing discipline the module doc comment already
// describes for exception clauses. This is deliberate scope discipline
// from the Phase 2 brief: structure temporal semantics, but do not build
// a temporal execution/lowering engine.
//
// A rule with no `structuredCondition` (or one that fails to compile)
// falls back unchanged to the original `parseComparisonCondition` single-
// comparison grammar — see `compileRule` below. Every contract that
// resolved before Phase 2 continues to resolve exactly the same way.
// ---------------------------------------------------------------------------

type CompiledCheck =
  | { readonly kind: 'comparison'; readonly inputKey: string; readonly operator: '>' | '<' | '>=' | '<=' | '==' | '!='; readonly value: number }
  | { readonly kind: 'categorical'; readonly inputKey: string; readonly operator: '==' | '!='; readonly value: string }
  | { readonly kind: 'range'; readonly inputKey: string; readonly min: number; readonly max: number }
  | { readonly kind: 'and'; readonly checks: readonly CompiledCheck[] }
  | { readonly kind: 'or'; readonly checks: readonly CompiledCheck[] };

function compileStructuredCondition(condition: StructuredCondition, declaredInputs: readonly SemanticCapabilityParameter[]): { readonly ok: true; readonly check: CompiledCheck } | { readonly ok: false; readonly reason: string } {
  if (condition.type === 'and' || condition.type === 'or') {
    const checks: CompiledCheck[] = [];
    for (const operand of condition.operands) {
      const result = compileStructuredCondition(operand, declaredInputs);
      if (!result.ok) return result;
      checks.push(result.check);
    }
    return { ok: true, check: { kind: condition.type, checks } };
  }
  if (condition.type === 'temporal') {
    // M1.3: a duration temporal condition (`amount`+`unit`+`field` all
    // present — see `StructuredTemporalCondition`'s doc comment) lowers
    // to an ordinary numeric comparison against a runtime-supplied
    // day-count field: `'within' N <unit>` -> `<= N`, `'after' N <unit>`
    // -> `> N`. This is deliberately NOT a date/time engine — nothing
    // here computes a duration from two dates or touches a wall clock;
    // the caller is expected to supply the already-computed elapsed
    // count under `field`'s resolved key (e.g. a benchmark input like
    // `{ reported_loss_date: 5 }` meaning "5 days since the reported
    // loss date", not a calendar date). `unit` itself is intentionally
    // not consulted here (no day/month/year conversion) — every duration
    // this grammar currently parses is already `days` in practice
    // (`TEMPORAL_UNIT_WORDS`), and mixing units would be exactly the
    // kind of real date arithmetic this milestone is scoped to avoid.
    //
    // Every other temporal shape remains refused exactly as before:
    // - the anchor shape (`{relation, anchor}`, no `amount`) — genuinely
    //   requires evaluating against a reference date, out of scope.
    // - a duration with no capturable `field` (`parseTemporalDuration`
    //   found no confident trailing reference phrase) — refused rather
    //   than guessed.
    // - `relation` of `'before'`/`'during'` — `parseTemporalDuration`
    //   never actually produces these with `amount`/`unit` set today
    //   (only `'within'`/`'after'` reach that shape), but this resolver
    //   does not assume that invariant holds forever; it explicitly
    //   refuses rather than silently mis-mapping an unanticipated
    //   relation to a comparison operator.
    if (condition.amount !== undefined && condition.unit !== undefined && condition.field !== undefined && (condition.relation === 'within' || condition.relation === 'after')) {
      const resolvedKey = resolveFieldKey(condition.field, declaredInputs);
      if (!resolvedKey) {
        return { ok: false, reason: `Structured temporal condition field ("${condition.field}") does not match any declared contract input` };
      }
      const operator = condition.relation === 'within' ? '<=' : '>';
      return { ok: true, check: { kind: 'comparison', inputKey: resolvedKey.key, operator, value: condition.amount } };
    }
    return { ok: false, reason: `A temporal condition ("${condition.relation}"${condition.anchor !== undefined ? ` ${condition.anchor}` : ''}) cannot lower to a deterministic_rule binding — this resolver structures temporal semantics but never evaluates them against a wall clock/reference date, and only lowers a duration-with-field shape (see the module's M1.3 doc comment) to a plain numeric comparison` };
  }

  const resolvedKey = resolveFieldKey(condition.field, declaredInputs);
  if (!resolvedKey) {
    return { ok: false, reason: `Structured condition field ("${condition.field}") does not match any declared contract input` };
  }

  if (condition.type === 'comparison') {
    return { ok: true, check: { kind: 'comparison', inputKey: resolvedKey.key, operator: condition.operator, value: condition.value } };
  }
  if (condition.type === 'range') {
    return { ok: true, check: { kind: 'range', inputKey: resolvedKey.key, min: condition.min, max: condition.max } };
  }
  // condition.type === 'categorical'
  return { ok: true, check: { kind: 'categorical', inputKey: resolvedKey.key, operator: condition.operator, value: condition.value } };
}

interface CompiledRule {
  readonly sourceNodeId: string;
  readonly check: CompiledCheck;
  readonly outcome: string;
}

/**
 * A bare `constraint` rule (`kind === 'constraint'`) is, by
 * `SemanticCapabilityRule`'s own documented contract (see `types.ts`'s
 * doc comment on `outcome`: "Absent for a bare `constraint`"), a
 * precondition/hard-limit statement, not a decision-table branch — it
 * has no `outcome`/action for an `evaluate()` call to return, by design,
 * not by extraction failure. It is therefore never a candidate for this
 * resolver's decision-table compilation and is skipped rather than
 * attempted-and-failed, exactly like a resolver's own "not applicable"
 * signal — it does not participate in `compileRules`'s all-or-nothing
 * discipline for `decision_node`/`heuristic` rules, because a `constraint`
 * was never expected to produce a branch in the first place. It is not
 * silently discarded, though: every skipped constraint is still recorded
 * (see `compileRules`'s `skipped` return value) so it remains visible in
 * `CapabilityBinding.derivation` for audit, honoring the "never silently
 * drop provenance-linked information" principle even though it can't be
 * executed as a check.
 */
function isBareConstraint(rule: SemanticCapabilityRule): boolean {
  return rule.kind === 'constraint' && (rule.outcome === undefined || rule.outcome.trim().length === 0);
}

/**
 * Every non-constraint rule must compile to a `CompiledCheck` — either
 * from its `structuredCondition` (Phase 2's generalized comparison/
 * categorical/range/and/or grammar, preferred when present and
 * compilable) or, as a fallback, from the original single-comparison
 * `parseComparisonCondition` grammar over `condition`'s raw text — see
 * the module doc comment on why one unparseable `decision_node`/
 * `heuristic` rule fails the *whole* capability's resolution rather than
 * being silently dropped from the evaluator (a decision table missing
 * one of its branches is not a smaller-but-correct decision table, it is
 * a wrong one). A bare `constraint` rule (see `isBareConstraint`) is
 * exempt from this all-or-nothing rule entirely — it is skipped, not
 * evaluated as a potential failure.
 */
function compileRules(rules: readonly SemanticCapabilityRule[], declaredInputs: readonly SemanticCapabilityParameter[]): { readonly ok: true; readonly compiled: readonly CompiledRule[]; readonly skippedConstraints: readonly { readonly sourceNodeId: string; readonly condition: string }[] } | { readonly ok: false; readonly reason: string } {
  const compiled: CompiledRule[] = [];
  const skippedConstraints: { readonly sourceNodeId: string; readonly condition: string }[] = [];
  for (const rule of rules) {
    if (isBareConstraint(rule)) {
      skippedConstraints.push({ sourceNodeId: rule.sourceNodeId, condition: rule.condition });
      continue;
    }
    if (rule.exceptionConditions.length > 0) {
      return { ok: false, reason: `Rule "${rule.sourceNodeId}" has an exception clause ("unless ${rule.exceptionConditions.join('; ')}"), which is outside this resolver's closed single-comparison grammar` };
    }
    if (rule.outcome === undefined || rule.outcome.trim().length === 0) {
      return { ok: false, reason: `Rule "${rule.sourceNodeId}" (kind "${rule.kind}") has no outcome/action — nothing for a decision table to return` };
    }

    if (rule.structuredCondition !== undefined) {
      const structuredResult = compileStructuredCondition(rule.structuredCondition, declaredInputs);
      if (structuredResult.ok) {
        compiled.push({ sourceNodeId: rule.sourceNodeId, check: structuredResult.check, outcome: rule.outcome });
        continue;
      }
      // Fall through to the legacy single-comparison grammar below rather
      // than failing immediately — a structured condition that doesn't
      // compile (e.g. a temporal leaf) may still have raw `condition` text
      // that the narrower legacy grammar can parse on its own.
    }

    const parsed = parseComparisonCondition(rule.condition);
    if (!parsed) {
      return { ok: false, reason: `Rule "${rule.sourceNodeId}"'s condition ("${rule.condition}") does not match the closed structured-comparison grammar` };
    }
    const resolvedKey = resolveFieldKey(parsed.fieldPhrase, declaredInputs);
    if (!resolvedKey) {
      return { ok: false, reason: `Rule "${rule.sourceNodeId}"'s condition field ("${parsed.fieldPhrase}") does not match any declared contract input` };
    }
    compiled.push({ sourceNodeId: rule.sourceNodeId, check: { kind: 'comparison', inputKey: resolvedKey.key, operator: parsed.operator, value: parsed.value }, outcome: rule.outcome });
  }
  return { ok: true, compiled, skippedConstraints };
}

function evaluateCheck(check: CompiledCheck, input: Readonly<Record<string, unknown>>): Result_LikeUnknown {
  if (check.kind === 'and') {
    for (const sub of check.checks) {
      const result = evaluateCheck(sub, input);
      if (!result.ok) return result;
      if (result.value !== true) return { ok: true, value: false };
    }
    return { ok: true, value: true };
  }
  if (check.kind === 'or') {
    for (const sub of check.checks) {
      const result = evaluateCheck(sub, input);
      if (!result.ok) return result;
      if (result.value === true) return { ok: true, value: true };
    }
    return { ok: true, value: false };
  }
  if (check.kind === 'categorical') {
    const raw = input[check.inputKey];
    if (typeof raw !== 'string') {
      return { ok: false, error: `Missing or non-string input field "${check.inputKey}" required by a categorical condition` };
    }
    const matches = raw.trim().toLowerCase() === check.value.toLowerCase();
    return { ok: true, value: check.operator === '==' ? matches : !matches };
  }
  const raw = input[check.inputKey];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { ok: false, error: `Missing or non-numeric input field "${check.inputKey}" required by a ${check.kind} condition` };
  }
  if (check.kind === 'range') {
    return { ok: true, value: raw >= check.min && raw <= check.max };
  }
  return { ok: true, value: evaluateComparison(check.operator, raw, check.value) };
}

function buildEvaluator(compiled: readonly CompiledRule[]): (input: Readonly<Record<string, unknown>>) => Result_LikeUnknown {
  return (input) => {
    for (const rule of compiled) {
      const result = evaluateCheck(rule.check, input);
      if (!result.ok) return { ok: false, error: `${result.error} (rule "${rule.sourceNodeId}")` };
      if (result.value === true) {
        return { ok: true, value: { matched: true, ruleSourceNodeId: rule.sourceNodeId, outcome: rule.outcome } };
      }
    }
    return { ok: true, value: { matched: false, outcome: undefined } };
  };
}

/**
 * The only `BindingResolver` implemented in v1. Resolves a contract to a
 * `deterministic_rule` binding if and only if:
 *
 *   - `contract.determinism` is not explicitly `'non_deterministic'`
 *     (an explicit `'non_deterministic'` signal from the compiler is
 *     honored as a `denied` outcome — see below, not silently overridden)
 *   - `contract.rules` is non-empty (nothing to evaluate otherwise)
 *   - every non-`constraint` rule (i.e. every `decision_node`/`heuristic`
 *     rule — see `isBareConstraint`) parses as a single structured
 *     comparison via `parseComparisonCondition`, has a non-empty outcome,
 *     has no exception clause, and its condition's field phrase resolves
 *     to a runtime input key (see `resolveFieldKey`)
 *   - at least one rule actually compiles into an executable decision-table
 *     branch — a contract whose only linked rules are bare `constraint`s
 *     (which never carry an outcome, by design) is `unresolved`, not
 *     `resolved` with an empty evaluator
 *
 * Bare `constraint` rules are skipped, not evaluated as a potential
 * failure (see `isBareConstraint`): they are preconditions, not
 * decision-table branches, so a `constraint` with no outcome is expected
 * shape, never a reason to fail the whole capability's resolution. They
 * are still recorded in the resulting binding's
 * `derivation.skippedConstraints` for audit.
 *
 * Any other case returns `unresolved` with the specific reason the first
 * failing rule produced — never a partial/best-effort evaluator.
 */
export class StructuredComparisonBindingResolver implements BindingResolver {
  readonly name = RESOLVER_NAME;

  resolve(contract: SemanticCapabilityContract): BindingOutcome | undefined {
    if (contract.determinism === 'non_deterministic') {
      return { status: 'denied', reason: `Contract "${contract.id}" is explicitly marked non-deterministic by the compiler — a deterministic evaluator would misrepresent it` };
    }
    if (contract.rules.length === 0) {
      return { status: 'unresolved', reason: `Contract "${contract.id}" has no linked decision_node/heuristic/constraint rules — nothing for a deterministic evaluator to check` };
    }

    const result = compileRules(contract.rules, contract.inputs);
    if (!result.ok) {
      return { status: 'unresolved', reason: result.reason };
    }
    if (result.compiled.length === 0) {
      // Every linked rule was a bare `constraint` (skipped, per
      // `isBareConstraint` — never a decision-table branch). There is
      // still nothing for a deterministic evaluator to check, but the
      // reason is distinguishable from the "no linked rules at all" case
      // above: name the skipped constraints so the caller can see this
      // was a real (if unactionable) rule set, not an empty one.
      const names = result.skippedConstraints.map((c) => `"${c.sourceNodeId}"`).join(', ');
      return { status: 'unresolved', reason: `Contract "${contract.id}" has ${result.skippedConstraints.length} linked constraint rule(s) (${names}) but no decision_node/heuristic rule with an executable outcome — a constraint alone has nothing for a decision table to return` };
    }

    const evaluate = buildEvaluator(result.compiled);
    const binding: CapabilityBinding = {
      id: `binding_${contract.id}_${RESOLVER_NAME}`,
      contractId: contract.id,
      implementationClass: 'deterministic_rule',
      resolverName: RESOLVER_NAME,
      description: `Deterministic decision-table evaluator compiled from ${result.compiled.length} structured-comparison rule(s) linked to contract "${contract.id}"${result.skippedConstraints.length > 0 ? ` (${result.skippedConstraints.length} bare constraint rule(s) linked but not evaluable as decision-table branches — see derivation.skippedConstraints)` : ''}`,
      evaluate,
      derivation: {
        rules: result.compiled.map((r) => ({ sourceNodeId: r.sourceNodeId, check: r.check, outcome: r.outcome })),
        ...(result.skippedConstraints.length > 0 ? { skippedConstraints: result.skippedConstraints } : {}),
      },
    };
    return { status: 'resolved', binding };
  }
}