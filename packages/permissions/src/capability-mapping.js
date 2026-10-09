import { err, ok } from '@xo/types';
import { ErrorCode, PermissionError } from '@xo/errors';
/**
 * §15's "Capability → Required Permissions" mapping, kept as an explicit,
 * host-populated registry rather than a hardcoded catalog — exactly what
 * §15 asks for ("do not hardcode the entire future capability catalog...
 * possible for packages to register capability requirements without
 * modifying the permission engine"). A package's manifest can also declare
 * this directly (see `manifest.ts`); this registry is for capabilities
 * that want to declare their requirements in code (e.g. a built-in
 * capability implemented directly in Runtime) rather than through a
 * package manifest.
 */
export class CapabilityPermissionRegistry {
    byCapability = new Map();
    /**
     * Registers `requirements` for `capabilityId`. Re-registering the same
     * capability id merges rather than silently overwriting — later callers
     * commonly want to *add* a requirement (e.g. a plugin extending a
     * built-in capability), not accidentally wipe out an earlier
     * registration by forgetting it exists.
     */
    register(capabilityId, requirements) {
        if (capabilityId.length === 0) {
            return err(new PermissionError(ErrorCode.PERMISSION_INVALID_REQUEST, 'capabilityId must not be empty'));
        }
        const existing = this.byCapability.get(capabilityId) ?? [];
        const merged = [...existing];
        for (const req of requirements) {
            if (!merged.some((r) => r.permission === req.permission && scopeEquals(r.scope, req.scope))) {
                merged.push(req);
            }
        }
        this.byCapability.set(capabilityId, merged);
        return ok(undefined);
    }
    resolve(capabilityId) {
        return this.byCapability.get(capabilityId) ?? [];
    }
    has(capabilityId) {
        return this.byCapability.has(capabilityId);
    }
    /** All capability ids with at least one registered requirement. */
    registeredCapabilities() {
        return [...this.byCapability.keys()];
    }
}
function scopeEquals(a, b) {
    if (a === undefined && b === undefined)
        return true;
    if (a === undefined || b === undefined)
        return false;
    return JSON.stringify(a) === JSON.stringify(b);
}
//# sourceMappingURL=capability-mapping.js.map