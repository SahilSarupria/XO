import type { MemoryScope } from './memory-types.js';

/**
 * §7 of the Stage 5 brief: "Reuse the existing permission architecture.
 * Do NOT create a new memory-specific authorization framework." This is
 * the same *port* pattern `permissions/permission-gate.interface.ts`
 * already established for capability execution — a minimal interface
 * with no `@xo/permissions` import, so `RuntimeMemory` (and this file)
 * stay usable without that package, while `memory-permission-manager-gate.ts`
 * (the one file that *does* import `@xo/permissions`) provides the real,
 * policy-backed implementation. The default, {@link allowAllMemoryPermissionGate},
 * is a no-op, mirroring `allowAllPermissionGate` — memory access is
 * unrestricted unless a host explicitly wires in a real gate.
 */
export type MemoryPermissionAction = 'read' | 'write' | 'delete' | 'share';

/** Who is asking — deliberately the same minimal shape `PermissionGate.check`'s `capabilityId` parameter implies, kept structural (no `@xo/types` `PackageId` import required) so a caller can supply as much or as little identity as it has. Absent fields simply aren't checked against requirement scopes that need them. */
export interface MemoryPermissionRequester {
  readonly packageId?: string;
  readonly capabilityId?: string;
}

export interface MemoryPermissionVerdict {
  readonly allowed: boolean;
  /** Human-readable reason, surfaced verbatim in the resulting `RuntimeError` message when `allowed` is false. */
  readonly reason?: string;
}

export interface MemoryPermissionGate {
  check(action: MemoryPermissionAction, scope: MemoryScope, requester?: MemoryPermissionRequester): Promise<MemoryPermissionVerdict>;
}

export const allowAllMemoryPermissionGate: MemoryPermissionGate = {
  async check(): Promise<MemoryPermissionVerdict> {
    return { allowed: true };
  },
};
