import { err, ok } from '@xo/types';
import { ErrorCode, RuntimeError } from '@xo/errors';
import { CapabilityPermissionRegistry } from '@xo/permissions';
/**
 * The authoritative store of executable capability authority — see
 * `runtime-capability-declaration.ts`'s top doc comment for the full
 * boundary this class enforces. Deliberately a distinct class from
 * `../capability/capability-registry.ts`'s `CapabilityRegistry` (which
 * indexes manifest-declared `CapabilityDeclaration`s across mounted
 * packages, for the AI-provider execution path): the two never share
 * storage, never cross-reference each other, and nothing in this file
 * reads a `MountedPackage`, a manifest, or any package component. That
 * separation is not an implementation detail, it *is* the guarantee that
 * a package cannot grant itself native execution authority by anything
 * it writes into its own `.xo` — only a call to `register()` on an
 * instance of this class, made by whoever embeds this Runtime, can do
 * that.
 *
 * Registration and resolution both fail closed (`Result`, never a thrown
 * exception for an ordinary "not found"/"invalid" outcome) — an unknown
 * `capabilityId` is `RUNTIME_CAPABILITY_NOT_FOUND`, a malformed
 * declaration is rejected at `register()` time with
 * `RUNTIME_CAPABILITY_DECLARATION_INVALID` rather than being stored and
 * failing later at execution time.
 */
export class RuntimeCapabilityRegistry {
    declarations = new Map();
    /** Deliberately reused, not duplicated: the same `@xo/permissions` class `PermissionManagerGate` already knows how to read for a manifest-backed capability's supplementary requirements — see `permission-manager-gate.ts`'s `options.registry`. A native capability's requirements land in the exact same object, just via this registry's own `register()` instead of manual manifest authoring, so one `PermissionManager`-backed check (`RuntimeCapabilityExecutor`) works identically whether the requirement came from a manifest or from here. */
    permissions = new CapabilityPermissionRegistry();
    /**
     * Registers one capability's executable authority. Re-registering the
     * same `capabilityId` overwrites the prior declaration outright (unlike
     * `CapabilityPermissionRegistry.register`'s additive-merge behavior for
     * permission *requirements* — a capability has exactly one current
     * implementation, there is no meaningful way to "merge" two handlers).
     *
     * Validates before storing anything: a capability with an empty id, a
     * non-function `handler`, or a contract missing its required
     * `description` is rejected with `RUNTIME_CAPABILITY_DECLARATION_INVALID`
     * and never enters the registry — the alternative (store it, fail at
     * execution time) would let a malformed registration sit silently until
     * whatever's exercising it happens to hit this specific capability id.
     */
    register(registration) {
        const { declaration, requiredPermissions } = registration;
        if (declaration.capabilityId.trim().length === 0) {
            return err(new RuntimeError(ErrorCode.RUNTIME_CAPABILITY_DECLARATION_INVALID, 'RuntimeCapabilityDeclaration.capabilityId must not be empty'));
        }
        if (typeof declaration.handler !== 'function') {
            return err(new RuntimeError(ErrorCode.RUNTIME_CAPABILITY_DECLARATION_INVALID, `Capability "${declaration.capabilityId}": handler must be a function`));
        }
        if (declaration.inputContract.description.trim().length === 0) {
            return err(new RuntimeError(ErrorCode.RUNTIME_CAPABILITY_DECLARATION_INVALID, `Capability "${declaration.capabilityId}": inputContract.description must not be empty`));
        }
        if (declaration.outputContract.description.trim().length === 0) {
            return err(new RuntimeError(ErrorCode.RUNTIME_CAPABILITY_DECLARATION_INVALID, `Capability "${declaration.capabilityId}": outputContract.description must not be empty`));
        }
        this.declarations.set(declaration.capabilityId, declaration);
        if (requiredPermissions && requiredPermissions.length > 0) {
            const registered = this.permissions.register(declaration.capabilityId, requiredPermissions);
            if (!registered.ok) {
                // Roll back the declaration too — a capability whose permission
                // requirements couldn't be recorded must not become resolvable
                // (that would be a capability the executor could reach without
                // its intended gating ever being registered at all).
                this.declarations.delete(declaration.capabilityId);
                return err(new RuntimeError(ErrorCode.RUNTIME_CAPABILITY_DECLARATION_INVALID, `Capability "${declaration.capabilityId}": ${registered.error.message}`));
            }
        }
        return ok(undefined);
    }
    /** Fails closed (`RUNTIME_CAPABILITY_NOT_FOUND`) rather than returning `undefined` — every caller of this method is about to make an authorization/execution decision, so "not found" should be exactly as hard to accidentally ignore as any other denial. Use `has()` first for a non-failing existence check. */
    resolve(capabilityId) {
        const declaration = this.declarations.get(capabilityId);
        if (!declaration) {
            return err(new RuntimeError(ErrorCode.RUNTIME_CAPABILITY_NOT_FOUND, `No Runtime capability declaration registered for id "${capabilityId}"`));
        }
        return ok(declaration);
    }
    has(capabilityId) {
        return this.declarations.has(capabilityId);
    }
    /** Every registered capability id — deterministic order (insertion order, i.e. registration order), matching `CapabilityPermissionRegistry.registeredCapabilities`'s own convention. */
    registeredCapabilities() {
        return [...this.declarations.keys()];
    }
    get size() {
        return this.declarations.size;
    }
}
//# sourceMappingURL=runtime-capability-registry.js.map