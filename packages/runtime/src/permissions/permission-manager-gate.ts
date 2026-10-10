import { PackageId } from '@xo/types';
import {
  authorizeCapabilityExecution,
  isAuthorizationSubject,
  PERMISSION_FREE,
  resolveDeclaredPermissionIds,
  resolveManifestCapabilityPermissions,
  unresolvedDeclaration,
  type AuthorizationSubject,
  type CapabilityPermissionRegistry,
  type PermissionDeclaration,
  type PermissionManager,
  type PermissionRequirement,
} from '@xo/permissions';
import type { ExecutionRequest } from '../execution/execution-request.js';
import type { PermissionGate, PermissionGateVerdict } from './permission-gate.interface.js';

export interface PermissionManagerGateOptions {
  readonly manager: PermissionManager;
  /**
   * P1.0 M2 — REQUIRED. Who the gated executions are performed for: an
   * `AuthenticatedPrincipal` or a `TrustedExecutionContext`. Verified when
   * the gate is created and again on every check. NOT the requesting
   * package/capability, which the gate derives from the mounted package.
   */
  readonly subject: AuthorizationSubject;
  /**
   * An optional *supplementary* requirement source, for capabilities that
   * aren't backed by a manifest at all (e.g. a built-in Runtime
   * capability with no `.xo` package). The manifest — resolved
   * automatically via `resolveManifestCapabilityPermissions`, see this
   * function's doc comment — is always the primary, automatic source;
   * nothing needs to be registered here for an ordinary manifest-declared
   * capability to be enforced.
   */
  readonly registry?: Pick<CapabilityPermissionRegistry, 'resolve' | 'has'>;
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
  // P1.0 M2: a gate with no verified subject or no policy must not exist.
  if (!isAuthorizationSubject(options.subject)) {
    throw new Error('createPermissionManagerGate requires a verified AuthenticatedPrincipal or TrustedExecutionContext as `subject`');
  }
  if (options.manager === undefined || options.manager === null || typeof options.manager.check !== 'function') {
    throw new Error('createPermissionManagerGate requires a PermissionManager');
  }
  const subject = options.subject;

  return {
    async check(mountedPackage, capabilityId, request: ExecutionRequest): Promise<PermissionGateVerdict> {
      void request;
      const label = `"${mountedPackage.name}@${mountedPackage.version}"`;
      const manifestResolution = resolveManifestCapabilityPermissions(mountedPackage.manifest);
      if (!manifestResolution.ok) {
        return {
          allowed: false,
          reason: `${label} has malformed permission declaration(s) in its manifest, so capability "${capabilityId}" cannot be authorized: ${manifestResolution.error.join('; ')}`,
        };
      }

      // Authoritative declaration sources, all additive:
      //  (1) manifest `permissions[]` entries naming this capability,
      //  (2) this capability's own `execution.requiredPermissionIds`,
      //  (3) the optional host-populated registry.
      // At least ONE source must make an EXPLICIT statement. No statement at
      // all is `unresolved` (denied) — never "permission-free".
      const manifestRequirements = manifestResolution.value.get(capabilityId) ?? [];
      const capabilityDecl = (mountedPackage.manifest.capabilities ?? []).find((c) => c.id === capabilityId);
      const executionIds: unknown = capabilityDecl?.execution?.requiredPermissionIds;
      let executionDeclaration: PermissionDeclaration | undefined;
      if (executionIds !== undefined) {
        executionDeclaration = resolveDeclaredPermissionIds(executionIds, `capability "${capabilityId}" execution.requiredPermissionIds`);
        if (executionDeclaration.kind === 'unresolved') {
          return { allowed: false, reason: `${label}: ${executionDeclaration.reason}` };
        }
      }
      const registryDeclared = options.registry?.has(capabilityId) === true;
      const registryRequirements = options.registry?.resolve(capabilityId) ?? [];

      const requirements: PermissionRequirement[] = [
        ...manifestRequirements,
        ...(executionDeclaration?.kind === 'required' ? executionDeclaration.requirements : []),
        ...registryRequirements,
      ];
      const explicitlyDeclared = manifestRequirements.length > 0 || executionDeclaration !== undefined || registryDeclared;

      const declaration: PermissionDeclaration = !explicitlyDeclared
        ? unresolvedDeclaration(
            `${label} declares no permission requirements for capability "${capabilityId}" (declare execution.requiredPermissionIds: [] to state that none are needed)`,
          )
        : requirements.length === 0
          ? PERMISSION_FREE
          : { kind: 'required', requirements };

      const outcome = await authorizeCapabilityExecution({
        manager: options.manager,
        subject,
        requester: { packageId: PackageId(`${mountedPackage.name}@${mountedPackage.version}`), capabilityId },
        declaration,
      });
      return outcome.allowed ? { allowed: true } : { allowed: false, reason: outcome.reason };
    },
  };
}
