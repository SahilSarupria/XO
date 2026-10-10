import { err, ok, type Result } from '@xo/types';
import { ErrorCode, RuntimeError } from '@xo/errors';
import { CapabilityPermissionRegistry, PERMISSION_FREE, unresolvedDeclaration, type PermissionDeclaration } from '@xo/permissions';
import type { RuntimeCapabilityDeclaration, RuntimeCapabilityRegistration } from './runtime-capability-declaration.js';

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
  private readonly declarations = new Map<string, RuntimeCapabilityDeclaration>();
  /** Capabilities registered with an explicit `requiredPermissions: []`. */
  private readonly permissionFree = new Set<string>();

  /** Deliberately reused, not duplicated: the same `@xo/permissions` class `PermissionManagerGate` already knows how to read for a manifest-backed capability's supplementary requirements — see `permission-manager-gate.ts`'s `options.registry`. A native capability's requirements land in the exact same object, just via this registry's own `register()` instead of manual manifest authoring, so one `PermissionManager`-backed check (`RuntimeCapabilityExecutor`) works identically whether the requirement came from a manifest or from here. */
  readonly permissions = new CapabilityPermissionRegistry();

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
  register(registration: RuntimeCapabilityRegistration): Result<void, RuntimeError> {
    const { declaration, requiredPermissions } = registration;

    // P1.0 M2: the permission declaration must be explicit. `[]` = permission-free;
    // absent/non-array is a malformed registration, not "no requirements".
    if (!Array.isArray(requiredPermissions)) {
      return err(
        new RuntimeError(
          ErrorCode.RUNTIME_CAPABILITY_DECLARATION_INVALID,
          `Capability "${declaration?.capabilityId ?? ''}": requiredPermissions must be declared explicitly (use [] for a permission-free capability)`,
        ),
      );
    }

    if (declaration.capabilityId.trim().length === 0) {
      return err(
        new RuntimeError(ErrorCode.RUNTIME_CAPABILITY_DECLARATION_INVALID, 'RuntimeCapabilityDeclaration.capabilityId must not be empty'),
      );
    }
    if (typeof declaration.handler !== 'function') {
      return err(
        new RuntimeError(
          ErrorCode.RUNTIME_CAPABILITY_DECLARATION_INVALID,
          `Capability "${declaration.capabilityId}": handler must be a function`,
        ),
      );
    }
    if (declaration.inputContract.description.trim().length === 0) {
      return err(
        new RuntimeError(
          ErrorCode.RUNTIME_CAPABILITY_DECLARATION_INVALID,
          `Capability "${declaration.capabilityId}": inputContract.description must not be empty`,
        ),
      );
    }
    if (declaration.outputContract.description.trim().length === 0) {
      return err(
        new RuntimeError(
          ErrorCode.RUNTIME_CAPABILITY_DECLARATION_INVALID,
          `Capability "${declaration.capabilityId}": outputContract.description must not be empty`,
        ),
      );
    }

    this.declarations.set(declaration.capabilityId, declaration);
    this.permissionFree.delete(declaration.capabilityId);

    if (requiredPermissions.length === 0) {
      // Re-registering an id replaces its prior permission declaration too
      // (the permission registry itself merges additively; an explicit
      // permission-free declaration must not inherit stale requirements, nor vice versa).
      this.permissionFree.add(declaration.capabilityId);
    } else {
      const registered = this.permissions.register(declaration.capabilityId, requiredPermissions);
      if (!registered.ok) {
        // Roll back the declaration too — a capability whose permission
        // requirements couldn't be recorded must not become resolvable
        // (that would be a capability the executor could reach without
        // its intended gating ever being registered at all).
        this.declarations.delete(declaration.capabilityId);
        return err(
          new RuntimeError(
            ErrorCode.RUNTIME_CAPABILITY_DECLARATION_INVALID,
            `Capability "${declaration.capabilityId}": ${registered.error.message}`,
          ),
        );
      }
    }

    return ok(undefined);
  }

  /** Fails closed (`RUNTIME_CAPABILITY_NOT_FOUND`) rather than returning `undefined` — every caller of this method is about to make an authorization/execution decision, so "not found" should be exactly as hard to accidentally ignore as any other denial. Use `has()` first for a non-failing existence check. */
  resolve(capabilityId: string): Result<RuntimeCapabilityDeclaration, RuntimeError> {
    const declaration = this.declarations.get(capabilityId);
    if (!declaration) {
      return err(
        new RuntimeError(ErrorCode.RUNTIME_CAPABILITY_NOT_FOUND, `No Runtime capability declaration registered for id "${capabilityId}"`),
      );
    }
    return ok(declaration);
  }

  /**
   * P1.0 M2 — the capability's authoritative permission declaration.
   * `unresolved` for an unregistered capability or one whose registration
   * never carried an explicit declaration; never `none` by default.
   */
  permissionDeclaration(capabilityId: string): PermissionDeclaration {
    if (!this.declarations.has(capabilityId))
      return unresolvedDeclaration(`no Runtime capability declaration registered for id "${capabilityId}"`);
    // Requirements win over a later permission-free re-registration: the
    // permission registry merges additively, and re-registering must never
    // LOOSEN an earlier requirement (fail closed to the stricter declaration).
    const requirements = this.permissions.resolve(capabilityId);
    if (requirements.length > 0) return { kind: 'required', requirements };
    if (this.permissionFree.has(capabilityId)) return PERMISSION_FREE;
    return unresolvedDeclaration(`capability "${capabilityId}" has no explicit permission declaration`);
  }

  has(capabilityId: string): boolean {
    return this.declarations.has(capabilityId);
  }

  /** Every registered capability id — deterministic order (insertion order, i.e. registration order), matching `CapabilityPermissionRegistry.registeredCapabilities`'s own convention. */
  registeredCapabilities(): readonly string[] {
    return [...this.declarations.keys()];
  }

  get size(): number {
    return this.declarations.size;
  }
}
