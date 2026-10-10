import {
  resolveCapabilityBinding,
  STANDARD_BINDING_RESOLVERS,
  type BindingOutcome,
  type BindingResolver,
  type CapabilityBinding,
  type SemanticCapabilityContract,
} from '@xo/capability-contract';
import type { ContentHash } from '@xo/types';
import { ErrorCode, RuntimeError } from '@xo/errors';
import {
  declarationCoversCopy,
  resolveDeclaredPermissionIds,
  type AuthorizationSubject,
  type PermissionContext,
  type PermissionDeclaration,
  type PermissionManager,
} from '@xo/permissions';
import { RuntimeCapabilityRegistry } from './runtime-capability-registry.js';
import { RuntimeCapabilityExecutor, type RuntimeCapabilityExecutionResult } from './runtime-capability-executor.js';
import { registerResolvedCapabilityBinding } from './capability-binding-registration.js';

/**
 * P0.9B Step 4 — the one shared assembly path from a contract to an
 * executed capability:
 *
 *   contract -> binding resolution -> registration -> RuntimeCapabilityExecutor
 *
 * Before this module, that sequence was written out by hand in
 * `apps/api`'s `execute-capability.ts` (twice: execute and resume),
 * `apps/cli`'s `deterministic-router.ts`, and — for the resolution +
 * registration half — `candidate-workflow-bridge.ts`.
 *
 * WHY THIS LIVES IN `@xo/runtime` (and not `@xo/capability-contract`):
 * decided by dependency direction, not convenience. `@xo/runtime`
 * already depends on `@xo/capability-contract` (this file's own imports
 * below); the reverse edge would be a cycle. This sequence's last two
 * steps need `RuntimeCapabilityRegistry` and `RuntimeCapabilityExecutor`,
 * which only exist here, so the helper can only be placed in the package
 * that can already see all of them — the same reason
 * `registerResolvedCapabilityBinding` itself lives here.
 *
 * TWO INFORMATION-BOUNDARY PATHS, ONE ASSEMBLY. What differs between
 * callers is only how they obtain the *contract*, and that difference is
 * a real information boundary, not duplication to be removed:
 *
 *   A. LIVE GRAPH PATH — a caller holding an `XoirGraph` builds the
 *      contract with `buildSemanticCapabilityContract(graph, nodeId)` and
 *      passes `graphHash: graph.contentHash()` (`apps/api`, the workflow
 *      bridge).
 *   B. INSTALLED PACKAGE PATH — a caller holding only a mounted `.xo`
 *      package reads the contract the compiler embedded in
 *      `knowledge_graph.json` via `extractContractFromPropertyBag`
 *      (`@xo/capability-contract`), the intentional package-boundary
 *      adapter (`apps/cli`'s `deterministic-router.ts`). There is no live
 *      `XoirGraph` there, so `graphHash` is simply not supplied — this
 *      module never fabricates one.
 *
 * Everything after "a contract exists" — resolution, registration,
 * executor construction, execution, provenance fields on the result — is
 * this module's, identically for both paths. Permission policy is NOT
 * decided here: the caller supplies its own `PermissionManager`
 * (fail-closed `RuleBasedPolicy([])` for `apps/api`; the manifest-derived
 * manager for `xo run`), because that is a host policy decision.
 */

/**
 * Resolves `contract` to a binding. `resolvers` defaults to the canonical
 * `STANDARD_BINDING_RESOLVERS`; a caller with a deliberately narrower set
 * (`xo run` resolves only `StructuredComparisonBindingResolver`) passes
 * its own — this function never widens what a caller asked for.
 */
export function resolveContractBinding(
  contract: SemanticCapabilityContract,
  resolvers: readonly BindingResolver[] = STANDARD_BINDING_RESOLVERS,
): BindingOutcome {
  return resolveCapabilityBinding(contract, resolvers);
}

export interface ExecuteResolvedContractRequest {
  /** The host's own permission policy — never defaulted here. */
  readonly permissionManager: PermissionManager;
  /**
   * P1.0 M2 — REQUIRED. Who this execution is performed for (verified at
   * the executor). Never inferred from the contract, package or input.
   */
  readonly subject: AuthorizationSubject;
  /**
   * P1.0 M2 — REQUIRED. The capability's authoritative permission
   * declaration, resolved by the host from the capability node's own
   * `requiredPermissions` property (`resolveDeclaredPermissionIds`). It is
   * cross-checked against `contract.requiredPermissions`; a disagreement or
   * an `unresolved` declaration denies execution before anything is
   * registered or run. Not a caller-supplied list: hosts read it from the
   * persisted graph / installed package, never from a request.
   */
  readonly permissionDeclaration: PermissionDeclaration;
  readonly input: unknown;
  /** Live-graph path only — see this module's doc comment. Omit on the installed-package path. */
  readonly graphHash?: ContentHash;
  /** Forwarded to `RuntimeCapabilityExecutor.execute` for permission-check audit attribution; does not change what is checked. */
  readonly requesterPackageId?: string;
  readonly context?: PermissionContext;
}

/**
 * `stage` tells a caller *which* step failed so each caller can keep its
 * own, pre-existing error wording (e.g. `xo run`'s "Failed to register
 * resolved binding: ..." vs. its `[CODE] message` execution error).
 */
export type ExecuteResolvedContractOutcome =
  | { readonly ok: true; readonly value: RuntimeCapabilityExecutionResult }
  | { readonly ok: false; readonly stage: 'registration' | 'authorization' | 'execution'; readonly error: RuntimeError };

/**
 * Registers `binding` for `contract` in a fresh `RuntimeCapabilityRegistry`
 * (via `registerResolvedCapabilityBinding` — the registry primitive itself
 * is untouched), builds a `RuntimeCapabilityExecutor` over it with the
 * caller's `PermissionManager`, and executes once. A throw from the
 * executor is deliberately NOT caught here — callers that want a
 * defensive catch (`apps/api`) keep theirs, exactly as before.
 */
export async function executeResolvedContract(
  contract: SemanticCapabilityContract,
  binding: CapabilityBinding,
  request: ExecuteResolvedContractRequest,
): Promise<ExecuteResolvedContractOutcome> {
  // P1.0 M2 — resolve the permission declaration BEFORE registering anything
  // or building an executor. Unresolved/conflicting ⇒ denied, no side effect.
  const declaration = declarationCoversCopy(
    request.permissionDeclaration ?? resolveDeclaredPermissionIds(undefined, `capability "${contract.id}"`),
    resolveDeclaredPermissionIds(contract.requiredPermissions, `contract "${contract.id}" requiredPermissions`),
    `capability "${contract.id}"`,
  );
  if (declaration.kind === 'unresolved') {
    return {
      ok: false,
      stage: 'authorization',
      error: new RuntimeError(
        ErrorCode.RUNTIME_PERMISSION_DENIED,
        `Capability "${contract.id}" cannot be authorized: ${declaration.reason}`,
      ),
    };
  }

  const registry = new RuntimeCapabilityRegistry();
  const registered = registerResolvedCapabilityBinding(registry, contract, binding, {
    ...(request.graphHash !== undefined ? { graphHash: request.graphHash } : {}),
    // The authoritative declaration may be STRICTER than the contract copy (e.g. manifest-declared extras); enforce all of it.
    ...(declaration.kind === 'required' ? { additionalRequiredPermissions: declaration.requirements } : {}),
  });
  if (!registered.ok) return { ok: false, stage: 'registration', error: registered.error };

  let executor: RuntimeCapabilityExecutor;
  try {
    executor = new RuntimeCapabilityExecutor({ registry, permissionManager: request.permissionManager, subject: request.subject });
  } catch (cause) {
    // Missing/unverifiable subject or policy ⇒ denial, never a fail-open fallback.
    return {
      ok: false,
      stage: 'authorization',
      error:
        cause instanceof RuntimeError
          ? cause
          : new RuntimeError(
              ErrorCode.RUNTIME_PERMISSION_DENIED,
              `authorization could not be established: ${cause instanceof Error ? cause.message : String(cause)}`,
            ),
    };
  }
  const result = await executor.execute({
    capabilityId: contract.id,
    input: request.input,
    ...(request.requesterPackageId !== undefined ? { requesterPackageId: request.requesterPackageId } : {}),
    ...(request.context !== undefined ? { context: request.context } : {}),
  });
  if (!result.ok) return { ok: false, stage: 'execution', error: result.error };
  return { ok: true, value: result.value };
}
