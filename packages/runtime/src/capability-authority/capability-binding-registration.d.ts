import { type Result } from '@xo/types';
import { RuntimeError } from '@xo/errors';
import { type PermissionRequirement } from '@xo/permissions';
import type { CapabilityBinding, SemanticCapabilityContract } from '@xo/capability-contract';
import type { RuntimeCapabilityRegistry } from './runtime-capability-registry.js';
/**
 * This module is the *only* bridge in this codebase between
 * `@xo/capability-contract`'s discovery/resolution world and
 * `@xo/runtime`'s execution-authority world — and it is a bridge that
 * must be walked explicitly, once, by a caller who has already decided
 * to grant execution authority. Nothing in `@xo/capability-contract`
 * calls into this file, and nothing here runs automatically when a
 * package is mounted or a contract is discovered.
 *
 * This is precisely the semantic-discovery/execution-authority boundary
 * the brief requires (§4, §9, §12): a `SemanticCapabilityContract` with a
 * `resolved` `CapabilityBinding` is still just data — a *candidate* for
 * execution — until a caller here explicitly calls
 * `registerResolvedCapabilityBinding`, at which point (and only at which
 * point) it becomes reachable through `RuntimeCapabilityExecutor`.
 */
export interface RegisterResolvedBindingOptions {
    /**
     * Additional permission requirements the host wants enforced on top of
     * whatever `contract.requiredPermissions` already specifies (which will
     * typically be empty — see `SemanticCapabilityContract`'s own doc
     * comment on why the compiler rarely populates this). This is the
     * host's opportunity to require more than the semantic layer knew to
     * ask for; it is never a way to require *less* (there is no mechanism
     * here to strip a permission the contract itself declared).
     */
    readonly additionalRequiredPermissions?: readonly PermissionRequirement[];
    /** Overrides the registered capability id (default: `contract.id`, i.e. the source XOIR capability node's id) — for a host that wants its own native id-space independent of XOIR ids. */
    readonly capabilityId?: string;
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
export declare function registerResolvedCapabilityBinding(registry: RuntimeCapabilityRegistry, contract: SemanticCapabilityContract, binding: CapabilityBinding, options?: RegisterResolvedBindingOptions): Result<void, RuntimeError>;
//# sourceMappingURL=capability-binding-registration.d.ts.map