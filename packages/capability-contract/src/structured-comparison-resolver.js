import { parseComparisonCondition, evaluateComparison } from './comparison-grammar.js';
const RESOLVER_NAME = 'structured-comparison-resolver';
const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'to']);
/** `"the claimed loss amount"` -> `"claimed_loss_amount"` — the fallback runtime-input key convention used only when the contract declares no `inputs` for a field phrase to be matched against (see `resolveFieldKey`'s doc comment). Same conservative style as `@xo/compiler`'s `capability-id.ts#normalizeCapabilityName`: lowercase, punctuation stripped, whitespace-delimited words, stop words removed — deterministic, no stemming/synonym folding (this module doesn't need `capability-id.ts`'s convergence behavior, only a stable key). */
function normalizeToFallbackKey(phrase) {
    const words = phrase
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter((w) => w.length > 0 && !STOP_WORDS.has(w));
    return words.join('_');
}
function normalizeForMatch(text) {
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
function resolveFieldKey(fieldPhrase, declaredInputs) {
    if (declaredInputs.length === 0) {
        return { key: normalizeToFallbackKey(fieldPhrase), matchedDeclaredInput: false };
    }
    const normalizedPhrase = normalizeForMatch(fieldPhrase);
    const matches = declaredInputs.filter((input) => normalizeForMatch(input.name) === normalizedPhrase);
    if (matches.length !== 1)
        return undefined;
    return { key: normalizeToFallbackKey(matches[0].name), matchedDeclaredInput: true };
}
function compileStructuredCondition(condition, declaredInputs) {
    if (condition.type === 'and' || condition.type === 'or') {
        const checks = [];
        for (const operand of condition.operands) {
            const result = compileStructuredCondition(operand, declaredInputs);
            if (!result.ok)
                return result;
            checks.push(result.check);
        }
        return { ok: true, check: { kind: condition.type, checks } };
    }
    if (condition.type === 'temporal') {
        return { ok: false, reason: `A temporal condition ("${condition.relation}"${condition.anchor !== undefined ? ` ${condition.anchor}` : ''}) cannot lower to a deterministic_rule binding — this resolver structures temporal semantics but never evaluates them (no wall-clock/reference-date input model)` };
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
/**
 * Every rule must compile to a `CompiledCheck` — either from its
 * `structuredCondition` (Phase 2's generalized comparison/categorical/
 * range/and/or grammar, preferred when present and compilable) or, as a
 * fallback, from the original single-comparison `parseComparisonCondition`
 * grammar over `condition`'s raw text — see the module doc comment on why
 * one unparseable rule fails the *whole* capability's resolution rather
 * than being silently dropped from the evaluator (a decision table
 * missing one of its branches is not a smaller-but-correct decision
 * table, it is a wrong one).
 */
function compileRules(rules, declaredInputs) {
    const compiled = [];
    for (const rule of rules) {
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
    return { ok: true, compiled };
}
function evaluateCheck(check, input) {
    if (check.kind === 'and') {
        for (const sub of check.checks) {
            const result = evaluateCheck(sub, input);
            if (!result.ok)
                return result;
            if (result.value !== true)
                return { ok: true, value: false };
        }
        return { ok: true, value: true };
    }
    if (check.kind === 'or') {
        for (const sub of check.checks) {
            const result = evaluateCheck(sub, input);
            if (!result.ok)
                return result;
            if (result.value === true)
                return { ok: true, value: true };
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
function buildEvaluator(compiled) {
    return (input) => {
        for (const rule of compiled) {
            const result = evaluateCheck(rule.check, input);
            if (!result.ok)
                return { ok: false, error: `${result.error} (rule "${rule.sourceNodeId}")` };
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
 *   - every rule parses as a single structured comparison via
 *     `parseComparisonCondition`, has a non-empty outcome, has no
 *     exception clause, and its condition's field phrase resolves to a
 *     runtime input key (see `resolveFieldKey`)
 *
 * Any other case returns `unresolved` with the specific reason the first
 * failing rule produced — never a partial/best-effort evaluator.
 */
export class StructuredComparisonBindingResolver {
    name = RESOLVER_NAME;
    resolve(contract) {
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
        const evaluate = buildEvaluator(result.compiled);
        const binding = {
            id: `binding_${contract.id}_${RESOLVER_NAME}`,
            contractId: contract.id,
            implementationClass: 'deterministic_rule',
            resolverName: RESOLVER_NAME,
            description: `Deterministic decision-table evaluator compiled from ${result.compiled.length} structured-comparison rule(s) linked to contract "${contract.id}"`,
            evaluate,
            derivation: {
                rules: result.compiled.map((r) => ({ sourceNodeId: r.sourceNodeId, check: r.check, outcome: r.outcome })),
            },
        };
        return { status: 'resolved', binding };
    }
}
//# sourceMappingURL=structured-comparison-resolver.js.map