import { PackageId } from '@xo/types';
import { PermissionId, resourceScope } from '@xo/permissions';
import { scopeKey } from './memory-types.js';
/** `action -> runtime.*` permission id, in the `runtime` permission domain (`@xo/permissions`' `domain.ts` — already a registered domain, so no `@xo/permissions` change is needed to add these). One id per action (§7: read/write/delete/share are checked independently, never folded into one coarse "memory access" permission). */
const ACTION_PERMISSION_ID = {
    read: 'runtime.memory-read',
    write: 'runtime.memory-write',
    delete: 'runtime.memory-delete',
    share: 'runtime.memory-share',
};
/** Sentinel package identity for a memory operation with no requester `packageId` (e.g. a host-initiated write, not attributable to any mounted package). A policy can still grant/deny by *this* well-known id if it wants to distinguish "unattributed" operations, but nothing here assumes that grant exists. */
const UNATTRIBUTED_PACKAGE_ID = PackageId('runtime:unattributed');
/**
 * The concrete `@xo/permissions`-backed {@link MemoryPermissionGate},
 * mirroring `permissions/permission-manager-gate.ts`'s `createPermissionManagerGate`
 * exactly: one file in `@xo/runtime` that imports `@xo/permissions`, used
 * only when a host explicitly passes it to `RuntimeMemory`. Every memory
 * scope is checked as a `resource` `PermissionScope`
 * (`memory:<kind>:<scopeId>`, from `scopeKey`) — this lets an enterprise
 * policy grant/deny memory access down to a specific execution or session,
 * not merely "all memory" or "no memory" — while `check` (never `request`)
 * is used throughout, so a `prompt` decision is treated as a denial here
 * exactly as `createPermissionManagerGate` treats it for capability
 * execution (§9's check/request split — memory access has no synchronous
 * point to pause for user consent either).
 */
export function createPermissionManagerMemoryGate(options) {
    return {
        async check(action, scope, requester) {
            const packageId = requester?.packageId !== undefined ? PackageId(requester.packageId) : UNATTRIBUTED_PACKAGE_ID;
            const decision = await options.manager.check({
                permission: PermissionId(ACTION_PERMISSION_ID[action]),
                scope: resourceScope(`memory:${scopeKey(scope)}`),
                requester: { packageId, ...(requester?.capabilityId !== undefined ? { capabilityId: requester.capabilityId } : {}) },
            });
            if (decision.effect !== 'allow') {
                return { allowed: false, reason: `Memory "${action}" on scope "${scopeKey(scope)}" was not granted: ${decision.reason}` };
            }
            return { allowed: true };
        },
    };
}
//# sourceMappingURL=memory-permission-manager-gate.js.map