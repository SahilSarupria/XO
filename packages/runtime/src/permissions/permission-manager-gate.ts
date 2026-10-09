import { PackageId } from '@xo/types';
import { resolveManifestCapabilityPermissions, type CapabilityPermissionRegistry, type PermissionManager, type PermissionRequirement } from '@xo/permissions';
import type { ExecutionRequest } from '../execution/execution-request.js';
import type { PermissionGate, PermissionGateVerdict } from './permission-gate.interface.js';

export interface PermissionManagerGateOptions {
  readonly manager: PermissionManager;
  /**
   * An optional *supplementary* requirement source, for capabilities that
   * aren't backed by a manifest at all (e.g. a built-in Runtime
   * capability with no `.xo` package). The manifest — resolved
   * automatically via `resolveManifestCapabilityPermissions`, see this
   * function's doc comment — is always the primary, automatic source;
   * nothing needs to be registered here for an ordinary manifest-declared
   * capability to be enforced.
   */
  readonly registry?: Pick<CapabilityPermissionRegistry, 'resolve'>;
}

/**
 * The concrete `@xo/permissions`-backed {@link PermissionGate} — this is
 * the one file in `@xo/runtime` that imports `@xo/permissions`, kept
 * separate from `permission-gate.interface.ts` so that file (and every
 * other file in this package) stays free of the dependency. A host wires
 * this in via `new ExecutionPipeline(..., { permissionGate:
 * createPermissionManagerGate({ manager }) })`; nothing here is called
 * automatically.
 *
 * **Requirement resolution (Stage 2 §4).** For every check, this
 * resolves `mountedPackage.manifest.permissions` via
 * `resolveManifestCapabilityPermissions` (`@xo/permissions`) fresh —
 * never from a registry a host has to remember to populate. That
 * function's result *is* the manifest, reparsed on demand; there is
 * nothing to fall out of sync. The optional `registry` is additive, for
 * capabilities the manifest can't describe.
 *
 * **Fail-closed on a malformed manifest (Stage 2 §5).** If
 * `resolveManifestCapabilityPermissions` reports a parse error for this
 * package's manifest, the capability is denied outright — a malformed
 * declaration is treated as "privileged capability whose requirements
 * couldn't be verified", never silently downgraded to "no requirements".
 * (In practice `PackageLoader.mount` already refuses to mount a package
 * with a malformed manifest permission declaration — see
 * `loader/package-loader.ts` — so this is defense in depth for a
 * manifest that reached here some other way, e.g. a test fixture built
 * by hand.)
 *
 * Checks every required permission for the capability and denies if any
 * one of them isn't `allow` — a `prompt` outcome is treated as a denial
 * at this layer, since `ExecutionPipeline.run` has no way to pause
 * mid-execution for user consent (§9's `check` vs. `request` split: this
 * calls `manager.check`, never `manager.request`, so it never triggers a
 * consent prompt on Runtime's behalf — a host that wants prompt-driven
 * execution should resolve `prompt` decisions via `manager.request`
 * *before* calling `Runtime.execute`, e.g. during planning).
 */
export function createPermissionManagerGate(options: PermissionManagerGateOptions): PermissionGate {
  return {
    async check(mountedPackage, capabilityId, _request: ExecutionRequest): Promise<PermissionGateVerdict> {
      const manifestResolution = resolveManifestCapabilityPermissions(mountedPackage.manifest);
      if (!manifestResolution.ok) {
        return {
          allowed: false,
          reason: `"${mountedPackage.name}@${mountedPackage.version}" has malformed permission declaration(s) in its manifest, so capability "${capabilityId}" cannot be authorized: ${manifestResolution.error.join('; ')}`,
        };
      }

      const manifestRequirements = manifestResolution.value.get(capabilityId) ?? [];
      const registryRequirements = options.registry?.resolve(capabilityId) ?? [];
      const requirements: readonly PermissionRequirement[] = [...manifestRequirements, ...registryRequirements];
      if (requirements.length === 0) return { allowed: true };

      const packageId = PackageId(`${mountedPackage.name}@${mountedPackage.version}`);

      for (const requirement of requirements) {
        const decision = await options.manager.check({
          permission: requirement.permission,
          ...(requirement.scope !== undefined ? { scope: requirement.scope } : {}),
          requester: { packageId, capabilityId },
        });
        if (decision.effect !== 'allow') {
          if (requirement.optional) continue;
          return { allowed: false, reason: `Permission "${requirement.permission}" required by capability "${capabilityId}" was not granted: ${decision.reason}` };
        }
      }
      return { allowed: true };
    },
  };
}
