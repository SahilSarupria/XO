import type { XoManifest } from '@xo/types';
import type { ExecutionRequest } from '../execution/execution-request.js';

/**
 * §19's clean integration boundary: the seam `ExecutionPipeline` calls
 * into before a planned capability actually runs, so a host can wire in
 * `@xo/permissions` (or anything else) without this package depending on
 * it. Deliberately a *port* — this file has no `@xo/permissions` import,
 * matching that package's own "independent of Runtime and Sandbox"
 * constraint being symmetric: Runtime doesn't need to know permissions
 * exist to define where they'd plug in, the same way `@xo/storage`'s
 * `BlobStore` doesn't need to know which backend implements it. (`@xo/types`
 * is the one exception — it's the shared foundational package every
 * Runtime file already depends on, not a Runtime- or permissions-specific
 * dependency, so importing its `XoManifest` type here doesn't compromise
 * that independence.)
 *
 * The default, {@link allowAllPermissionGate}, is a no-op — every
 * existing `ExecutionPipeline` behavior is unchanged unless a host
 * explicitly supplies a real gate via `ExecutionPipelineOptions.permissionGate`.
 */
export interface PermissionGateVerdict {
  readonly allowed: boolean;
  /** Human-readable reason, surfaced verbatim in the resulting `RuntimeError` message when `allowed` is false. */
  readonly reason?: string;
}

export interface PermissionGate {
  /**
   * @param mountedPackage The package whose capability is about to run — `{name, version, manifest}`, matching `MountedPackage`'s own shape (kept structural here rather than importing that type, so this port stays minimal). `manifest` is included (Stage 2) specifically so a gate can resolve a capability's declared permissions straight from `manifest.permissions` without any separate registration step — see `permission-manager-gate.ts`.
   * @param capabilityId The capability id selected by planning (`ExecutionPlan.selected.capability.declaration.id`) — or, for an auxiliary capability, `request.auxiliaryCapabilityIds[n]`'s corresponding declaration id. Both primary and auxiliary capabilities pass through this same gate; see `execution-pipeline.ts`'s doc comment on the auxiliary retrieval loop for why.
   * @param request The full `ExecutionRequest` being executed, for a gate that wants to inspect `environment`/`auxiliaryCapabilityIds`/etc.
   */
  check(mountedPackage: { readonly name: string; readonly version: string; readonly manifest: XoManifest }, capabilityId: string, request: ExecutionRequest): Promise<PermissionGateVerdict>;
}

export const allowAllPermissionGate: PermissionGate = {
  async check(): Promise<PermissionGateVerdict> {
    return { allowed: true };
  },
};
