import { establishTrustedExecutionContext, type TrustedExecutionContext } from '@xo/permissions';
export { allowAllPermissionGate } from '../src/permissions/permission-gate.interface.js';

/**
 * P1.0 M2 test fixtures. A `TrustedExecutionContext` is the explicit,
 * non-principal subject for tests that exercise runtime mechanics and are
 * NOT about who is acting; tests of authorization itself build their own
 * principals/contexts and assert denials explicitly.
 */
export function testSubject(): TrustedExecutionContext {
  return establishTrustedExecutionContext('local-operator');
}

import { resolveDeclaredPermissionIds, type PermissionDeclaration } from '@xo/permissions';
/** Test-only: the authoritative declaration for a contract-backed capability, taken from its own `requiredPermissions` array (what a host resolves from the node property). */
export function declaredFrom(contract: { readonly id: string; readonly requiredPermissions: readonly string[] }): PermissionDeclaration {
  return resolveDeclaredPermissionIds(contract.requiredPermissions, `contract ${contract.id}`);
}

import { CapabilityPermissionRegistry } from '@xo/permissions';
/** Test-only: a host registry that EXPLICITLY declares the named capabilities as having no registry-level requirements (manifest-declared permissions still apply on top). */
export function explicitNoneRegistry(...capabilityIds: string[]): CapabilityPermissionRegistry {
  const registry = new CapabilityPermissionRegistry();
  for (const id of capabilityIds) registry.register(id, []);
  return registry;
}
