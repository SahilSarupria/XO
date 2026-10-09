import { err, ok, type Result } from '@xo/types';
import type { ContentHash } from '@xo/types';
import { ErrorCode, RuntimeError } from '@xo/errors';
import { parsePermissionId, type PermissionRequirement } from '@xo/permissions';
import { computeContractContentHash, type CapabilityBinding, type SemanticCapabilityContract } from '@xo/capability-contract';
import type { RuntimeCapabilityHandler } from './runtime-capability-declaration.js';
import type { RuntimeCapabilityRegistry } from './runtime-capability-registry.js';

/**
 * This module is the *only* bridge in this codebase between
 * `@xo/capability-contract`'s discovery/resolution world and
 * `@xo/runtime`'s execution-authority world — and it is a bridge that
 * must be walked explicitly, once, by a caller who has already decided
 * to grant execution authority. Nothing in `@xo/capability-contract`
 * calls into this file, and nothing here runs automatically when a
 * package is mounted or a contract is discovered.
 *
 * This is precisely the semantic-discovery/execution-authority boundary
 * the brief requires (§4, §9, §12): a `SemanticCapabilityContract` with a
 * `resolved` `CapabilityBinding` is still just data — a *candidate* for
 * execution — until a caller here explicitly calls
 * `registerResolvedCapabilityBinding`, at which point (and only at which
 * point) it becomes reachable through `RuntimeCapabilityExecutor`.
 */

export interface RegisterResolvedBindingOptions {
  /**
   * Additional permission requirements the host wants enforced on top of
   * whatever `contract.requiredPermissions` already specifies (which will
   * typically be empty — see `SemanticCapabilityContract`'s own doc
   * comment on why the compiler rarely populates this). This is the
   * host's opportunity to require more than the semantic layer knew to
   * ask for; it is never a way to require *less* (there is no mechanism
   * here to strip a permission the contract itself declared).
   */
  readonly additionalRequiredPermissions?: readonly PermissionRequirement[];
  /** Overrides the registered capability id (default: `contract.id`, i.e. the source XOIR capability node's id) — for a host that wants its own native id-space independent of XOIR ids. */
  readonly capabilityId?: string;
  /**
   * P0.9B — the compiled `XoirGraph`'s own content-addressable identity
   * (`XoirGraph.contentHash()`, cached at compile time on
   * `XoirManifest.graphHash`), supplied by a caller that has a *live*
   * graph to hash (the "live graph" information-boundary path — see
   * this module's own top doc comment). Omitted by callers on the
   * installed-package path, which resolves a contract from an archive's
   * embedded property bag and has no live `XoirGraph` — that omission is
   * intentional, not a caller oversight this function should try to
   * work around (e.g. by re-deriving a hash from the embedded property
   * bag, which would be a *second*, non-equivalent graph identity).
   * Threaded straight onto the registered `RuntimeCapabilityDeclaration`,
   * exactly like `contractId`/`bindingId`/`sourceXoirNodeIds` below.
   */
  readonly graphHash?: ContentHash;
}

/** `implementationClass`es this bridge can directly register, because `@xo/capability-contract`'s own resolvers for both attach a pure, synchronous `evaluate` callable (see `CapabilityBinding.evaluate`'s doc comment). `'human_in_the_loop'` bindings register and gate identically to `'deterministic_rule'` ones — same wrapping, same confidence/permission enforcement at execution time (`RuntimeCapabilityExecutor`) — the only difference is what `evaluate` itself returns: a `'human_in_the_loop'` binding's `evaluate` never performs the underlying action, only produces an escalation record (see `ActionEscalationBindingResolver`). Every other `implementationClass` remains rejected below, unchanged. */
const REGISTERABLE_IMPLEMENTATION_CLASSES: ReadonlySet<CapabilityBinding['implementationClass']> = new Set(['deterministic_rule', 'human_in_the_loop']);

function wrapEvaluatorAsHandler(binding: CapabilityBinding): RuntimeCapabilityHandler {
  return async (input) => {
    if (!binding.evaluate) {
      return err(new RuntimeError(ErrorCode.RUNTIME_CAPABILITY_HANDLER_UNAVAILABLE, `Binding "${binding.id}" (implementationClass "${binding.implementationClass}") has no callable evaluator — only bindings from this codebase's own resolvers ('deterministic_rule', 'human_in_the_loop') are directly executable this way`));
    }
    if (typeof input !== 'object' || input === null) {
      return err(new RuntimeError(ErrorCode.RUNTIME_CAPABILITY_DECLARATION_INVALID, `Binding "${binding.id}" requires a plain object input, got ${typeof input}`));
    }
    const result = binding.evaluate(input as Readonly<Record<string, unknown>>);
    if (!result.ok) {
      return err(new RuntimeError(ErrorCode.RUNTIME_CAPABILITY_HANDLER_UNAVAILABLE, result.error));
    }
    return ok(result.value);
  };
}

/**
 * Converts `contract.requiredPermissions` (plain strings, verbatim from
 * whatever the compiler extracted — see `SemanticCapabilityContract`'s
 * doc comment) into `@xo/permissions`' `PermissionRequirement[]`, via the
 * same `parsePermissionId` every other permission-id string in this
 * codebase goes through — never a bespoke parser for this one call site.
 * A string that fails to parse as a valid `PermissionId` is a hard error
 * (`CONTRACT_MALFORMED`-shaped `RuntimeError`), not silently dropped —
 * silently dropping a permission requirement here would be exactly the
 * "capability discovery implying execution authority" failure mode §4
 * warns against, just inverted (weakening gating instead of granting it).
 */
function parseRequiredPermissions(raw: readonly string[]): Result<readonly PermissionRequirement[], RuntimeError> {
  const requirements: PermissionRequirement[] = [];
  for (const value of raw) {
    const parsed = parsePermissionId(value);
    if (!parsed.ok) {
      return err(new RuntimeError(ErrorCode.RUNTIME_CAPABILITY_DECLARATION_INVALID, `Contract-declared required permission "${value}" is not a valid PermissionId: ${parsed.error}`));
    }
    requirements.push({ permission: parsed.value.id });
  }
  return ok(requirements);
}

/**
 * Registers a `resolved` `CapabilityBinding` (from
 * `resolveCapabilityBinding`) against `registry`, making it — and only
 * it, and only from this point forward — reachable through
 * `RuntimeCapabilityExecutor`. This is the one and only place in the
 * codebase where a `SemanticCapabilityContract`/`CapabilityBinding` pair
 * crosses into execution authority.
 *
 * Only bindings whose `implementationClass` is in
 * `REGISTERABLE_IMPLEMENTATION_CLASSES` (currently `'deterministic_rule'`
 * and, as of Action Capability Binding v1, `'human_in_the_loop'` — the
 * two classes `@xo/capability-contract`'s own resolvers produce) are
 * directly registerable this way — the handler wraps `binding.evaluate`
 * identically for both. Any other `implementationClass` is rejected here
 * with `RUNTIME_CAPABILITY_DECLARATION_INVALID`, since this function has
 * no generic way to turn e.g. an `ai_provider`-class binding into a
 * `RuntimeCapabilityHandler` without host-specific wiring this codebase
 * doesn't have yet (see the brief's §17 "do not overbuild" and this
 * package's own README on which `implementationClass`es are
 * implemented).
 *
 * Registering a `'human_in_the_loop'` binding grants it no more, and no
 * less, execution authority than a `'deterministic_rule'` one: it still
 * must pass M1.4 confidence gating and every registered permission check
 * inside `RuntimeCapabilityExecutor` before its handler ever runs. What
 * differs is only what the handler *does* once those gates pass — see
 * `ActionEscalationBindingResolver`'s doc comment for the safety
 * boundary this preserves (a successful execution is an escalation
 * record, never a claim the underlying action was performed).
 */
export function registerResolvedCapabilityBinding(registry: RuntimeCapabilityRegistry, contract: SemanticCapabilityContract, binding: CapabilityBinding, options: RegisterResolvedBindingOptions = {}): Result<void, RuntimeError> {
  if (!REGISTERABLE_IMPLEMENTATION_CLASSES.has(binding.implementationClass)) {
    return err(new RuntimeError(ErrorCode.RUNTIME_CAPABILITY_DECLARATION_INVALID, `Binding "${binding.id}" has implementationClass "${binding.implementationClass}" — only ${[...REGISTERABLE_IMPLEMENTATION_CLASSES].map((c) => `'${c}'`).join(', ')} bindings can be registered by this function`));
  }

  const contractPermissions = parseRequiredPermissions(contract.requiredPermissions);
  if (!contractPermissions.ok) return err(contractPermissions.error);

  const requiredPermissions = [...contractPermissions.value, ...(options.additionalRequiredPermissions ?? [])];

  return registry.register({
    declaration: {
      capabilityId: options.capabilityId ?? contract.id,
      inputContract: { description: `Auto-derived from SemanticCapabilityContract "${contract.id}" (${contract.name}): ${contract.description}` },
      outputContract: { description: `{matched: boolean, ruleSourceNodeId?: string, outcome?: string} — see binding "${binding.id}"'s derivation for the underlying rule set.` },
      handler: wrapEvaluatorAsHandler(binding),
      contractId: contract.id,
      bindingId: binding.id,
      sourceXoirNodeIds: contract.sourceXoirNodeIds,
      ...(options.graphHash !== undefined ? { graphHash: options.graphHash } : {}),
      // P0.9B: always recomputed from the contract being registered (both
      // information-boundary paths have one), never read from `contract.contentHash`.
      contractContentHash: computeContractContentHash(contract),
    },
    ...(requiredPermissions.length > 0 ? { requiredPermissions } : {}),
  });
}
