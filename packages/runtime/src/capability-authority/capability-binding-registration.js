import { err, ok } from '@xo/types';
import { ErrorCode, RuntimeError } from '@xo/errors';
import { parsePermissionId } from '@xo/permissions';
function wrapEvaluatorAsHandler(binding) {
    return async (input) => {
        if (!binding.evaluate) {
            return err(new RuntimeError(ErrorCode.RUNTIME_CAPABILITY_HANDLER_UNAVAILABLE, `Binding "${binding.id}" (implementationClass "${binding.implementationClass}") has no callable evaluator — only 'deterministic_rule' bindings from this codebase's resolver are directly executable this way`));
        }
        if (typeof input !== 'object' || input === null) {
            return err(new RuntimeError(ErrorCode.RUNTIME_CAPABILITY_DECLARATION_INVALID, `Binding "${binding.id}" requires a plain object input, got ${typeof input}`));
        }
        const result = binding.evaluate(input);
        if (!result.ok) {
            return err(new RuntimeError(ErrorCode.RUNTIME_CAPABILITY_HANDLER_UNAVAILABLE, result.error));
        }
        return ok(result.value);
    };
}
/**
 * Converts `contract.requiredPermissions` (plain strings, verbatim from
 * whatever the compiler extracted — see `SemanticCapabilityContract`'s
 * doc comment) into `@xo/permissions`' `PermissionRequirement[]`, via the
 * same `parsePermissionId` every other permission-id string in this
 * codebase goes through — never a bespoke parser for this one call site.
 * A string that fails to parse as a valid `PermissionId` is a hard error
 * (`CONTRACT_MALFORMED`-shaped `RuntimeError`), not silently dropped —
 * silently dropping a permission requirement here would be exactly the
 * "capability discovery implying execution authority" failure mode §4
 * warns against, just inverted (weakening gating instead of granting it).
 */
function parseRequiredPermissions(raw) {
    const requirements = [];
    for (const value of raw) {
        const parsed = parsePermissionId(value);
        if (!parsed.ok) {
            return err(new RuntimeError(ErrorCode.RUNTIME_CAPABILITY_DECLARATION_INVALID, `Contract-declared required permission "${value}" is not a valid PermissionId: ${parsed.error}`));
        }
        requirements.push({ permission: parsed.value.id });
    }
    return ok(requirements);
}
/**
 * Registers a `resolved` `CapabilityBinding` (from
 * `resolveCapabilityBinding`) against `registry`, making it — and only
 * it, and only from this point forward — reachable through
 * `RuntimeCapabilityExecutor`. This is the one and only place in the
 * codebase where a `SemanticCapabilityContract`/`CapabilityBinding` pair
 * crosses into execution authority.
 *
 * Only `implementationClass: 'deterministic_rule'` bindings (the only
 * kind `@xo/capability-contract`'s v1 resolver produces) are directly
 * registerable this way — the handler wraps `binding.evaluate`. Any
 * other `implementationClass` is rejected here with
 * `RUNTIME_CAPABILITY_DECLARATION_INVALID`, since this function has no
 * generic way to turn e.g. an `ai_provider`-class binding into a
 * `RuntimeCapabilityHandler` without host-specific wiring this codebase
 * doesn't have yet (see the brief's §17 "do not overbuild" and this
 * package's own README on which `implementationClass`es are
 * implemented).
 */
export function registerResolvedCapabilityBinding(registry, contract, binding, options = {}) {
    if (binding.implementationClass !== 'deterministic_rule') {
        return err(new RuntimeError(ErrorCode.RUNTIME_CAPABILITY_DECLARATION_INVALID, `Binding "${binding.id}" has implementationClass "${binding.implementationClass}" — only 'deterministic_rule' bindings can be registered by this function`));
    }
    const contractPermissions = parseRequiredPermissions(contract.requiredPermissions);
    if (!contractPermissions.ok)
        return err(contractPermissions.error);
    const requiredPermissions = [...contractPermissions.value, ...(options.additionalRequiredPermissions ?? [])];
    return registry.register({
        declaration: {
            capabilityId: options.capabilityId ?? contract.id,
            inputContract: { description: `Auto-derived from SemanticCapabilityContract "${contract.id}" (${contract.name}): ${contract.description}` },
            outputContract: { description: `{matched: boolean, ruleSourceNodeId?: string, outcome?: string} — see binding "${binding.id}"'s derivation for the underlying rule set.` },
            handler: wrapEvaluatorAsHandler(binding),
        },
        ...(requiredPermissions.length > 0 ? { requiredPermissions } : {}),
    });
}
//# sourceMappingURL=capability-binding-registration.js.map