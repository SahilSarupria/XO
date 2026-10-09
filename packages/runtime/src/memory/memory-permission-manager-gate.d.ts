import { type PermissionManager } from '@xo/permissions';
import type { MemoryPermissionGate } from './memory-permission-gate.interface.js';
export interface MemoryPermissionManagerGateOptions {
    readonly manager: PermissionManager;
}
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
export declare function createPermissionManagerMemoryGate(options: MemoryPermissionManagerGateOptions): MemoryPermissionGate;
//# sourceMappingURL=memory-permission-manager-gate.d.ts.map