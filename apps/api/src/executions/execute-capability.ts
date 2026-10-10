import { lowerCapabilitiesToManifest } from '@xo/compiler';
import { fromJson, XoirNodeId, type XoirGraph, type XoirGraphJson } from '@xo/xoir';
import { ContentHash } from '@xo/types';
import {
  buildSemanticCapabilityContract,
  validateCapabilityInput,
  type CapabilityBinding,
  type SemanticCapabilityContract,
} from '@xo/capability-contract';
import { authorizeContractExecution, executeResolvedContract, resolveContractBinding, NATIVE_CAPABILITY_REQUESTER } from '@xo/runtime';
import { authorizeCapabilityExecution } from '@xo/permissions';
import type { ExecutionAuthorization } from './authorization.js';
import { declaredPermissionsForNode } from './authorization.js';
import { ErrorCode } from '@xo/errors';

/**
 * P0.9B Steps 2 and 4 — binding resolution goes through
 * `resolveContractBinding` (`@xo/runtime`), which defaults to the one
 * canonical `STANDARD_BINDING_RESOLVERS` (`@xo/capability-contract`), and
 * register -> executor -> execute goes through `executeResolvedContract`
 * (`@xo/runtime`). This file is the LIVE GRAPH information-boundary path:
 * it rebuilds each contract from the stored graph JSON, so it can and
 * does supply `graphHash`. The permission policy stays this host's own
 * decision, below.
 */

export type CapabilityExecutionOutcome =
  | {
      readonly kind: 'succeeded';
      readonly output: unknown;
      readonly contractId?: string;
      readonly bindingId?: string;
      readonly sourceXoirNodeIds?: readonly string[];
      readonly graphHash?: string;
      readonly contractContentHash?: string;
    }
  | {
      readonly kind: 'waiting_for_human';
      readonly output: unknown;
      readonly contractId?: string;
      readonly bindingId?: string;
      readonly sourceXoirNodeIds?: readonly string[];
      readonly graphHash?: string;
      readonly contractContentHash?: string;
    }
  | { readonly kind: 'unresolved'; readonly status: 'unresolved' | 'ambiguous' | 'denied'; readonly reason: string }
  | { readonly kind: 'invalid_input'; readonly issues: readonly { readonly path: string; readonly message: string }[] }
  | { readonly kind: 'error'; readonly errorCode: string; readonly errorMessage: string };

/** Same shape as `CapabilityExecutionOutcome`'s failure variants, plus the two real resume terminals — see `resume-human-task.ts`'s doc comment for what `'succeeded'`/`'rejected'` mean here. */
export type CapabilityResumeOutcome =
  | {
      readonly kind: 'succeeded';
      readonly output: unknown;
      readonly contractId?: string;
      readonly bindingId?: string;
      readonly sourceXoirNodeIds?: readonly string[];
      readonly graphHash?: string;
      readonly contractContentHash?: string;
    }
  | { readonly kind: 'rejected'; readonly output: unknown; readonly contractId?: string; readonly bindingId?: string }
  | { readonly kind: 'unresolved'; readonly status: 'unresolved' | 'ambiguous' | 'denied'; readonly reason: string }
  | { readonly kind: 'invalid_input'; readonly issues: readonly { readonly path: string; readonly message: string }[] }
  | { readonly kind: 'error'; readonly errorCode: string; readonly errorMessage: string };

interface RebuiltContract {
  readonly contract: SemanticCapabilityContract;
  readonly binding: CapabilityBinding;
}

type RebuildResult =
  | { readonly ok: true; readonly value: RebuiltContract }
  | { readonly ok: false; readonly outcome: CapabilityExecutionOutcome | CapabilityResumeOutcome };

/**
 * Shared by both `executeApprovedCapability` and `resumeCapabilityExecution`
 * — re-derives the exact contract+binding for one capability from an
 * already-compiled graph. Never re-compiles the source; never re-runs
 * `packageXoirGraph`'s full-graph capability lowering (that stays a
 * separate, cheap, whole-graph call each caller makes only for the one
 * field it actually needs — the input/decision-data schema — via
 * `lowerCapabilitiesToManifest`, in `findInputSchema` below).
 */
function rebuildContractAndBinding(compiledGraphJson: unknown, capabilityId: string): RebuildResult {
  const graphResult = fromJson(compiledGraphJson as XoirGraphJson);
  if (!graphResult.ok)
    return { ok: false, outcome: { kind: 'error', errorCode: graphResult.error.code, errorMessage: graphResult.error.message } };
  const graph = graphResult.value;

  const contractResult = buildSemanticCapabilityContract(graph, XoirNodeId(capabilityId));
  if (!contractResult.ok)
    return { ok: false, outcome: { kind: 'error', errorCode: contractResult.error.code, errorMessage: contractResult.error.message } };
  const contract = contractResult.value;

  // Re-resolving the binding at RESUME time (not just at original
  // execution time) is itself part of "re-check authorization... not
  // only at initial execution time" — a contract whose evidence has
  // somehow become ambiguous/denied since the original execution is
  // caught here, honestly, rather than assumed still valid because it
  // resolved once before.
  const bindingOutcome = resolveContractBinding(contract);
  if (bindingOutcome.status !== 'resolved') {
    return { ok: false, outcome: { kind: 'unresolved', status: bindingOutcome.status, reason: bindingOutcome.reason } };
  }
  return { ok: true, value: { contract, binding: bindingOutcome.binding } };
}

function findInputSchema(graph: XoirGraph, contractId: string) {
  const lowered = lowerCapabilitiesToManifest(graph);
  const loweredOutcome = lowered.outcomes.find((o) => o.contractId === contractId);
  return loweredOutcome?.declaration?.execution?.inputSchema;
}

/**
 * P1.0 M2 remediation — AUTHORIZATION PREFLIGHT for the direct execution route.
 *
 * Decides, against the PERSISTED compiled graph's authoritative capability
 * declaration and the server-side `PermissionManager`, whether this principal may
 * execute this capability — WITHOUT creating, registering, executing or
 * persisting anything. The route calls it BEFORE `ExecutionStore.create`, so a
 * denied attempt leaves no record (the M2 "rejected before side effects"
 * criterion), and an authenticated-but-unauthorized caller cannot grow storage.
 *
 * It uses the SAME decision `executeResolvedContract` makes
 * (`authorizeContractExecution`: same provenance check, same contract-copy
 * cross-check, same `authorizeCapabilityExecution`), never a second
 * implementation. It is NOT the security boundary: `executeApprovedCapability`
 * always re-authorizes at the execution boundary, and a `kind: 'authorized'`
 * here grants nothing to a later call.
 *
 * TOCTOU: the route hands this function and `executeApprovedCapability` the SAME
 * in-memory graph read once from the store (no second read between check and use),
 * and the execution boundary RE-DERIVES the declaration from the graph it actually
 * runs rather than reusing this decision — so a stricter declaration on the graph
 * that is executed is always enforced. As an extra tie the result carries
 * `graph.contentHash()`; passing it as `preflightGraphHash` makes execution refuse
 * a DIFFERENT graph (different node/edge hashes). LIMIT (verified by test): `fromJson`
 * trusts each node's stored `hash`, so `contentHash()` does not detect an edit to a
 * node's properties that left its stored hash untouched — that case is covered by the
 * re-derivation above, not by the hash.
 *
 * Only authorization failures are `denied`; a graph or contract that cannot be
 * built at all is `error` — also refused before any record exists, since an
 * authorization decision could not be established (fail closed).
 */
export type AuthorizationPreflightOutcome =
  | { readonly kind: 'authorized'; readonly graphHash: ContentHash; readonly contractId: string }
  | { readonly kind: 'denied'; readonly errorCode: string; readonly errorMessage: string }
  | { readonly kind: 'error'; readonly errorCode: string; readonly errorMessage: string };

export async function preflightCapabilityAuthorization(
  compiledGraphJson: unknown,
  capabilityId: string,
  authorization: ExecutionAuthorization,
): Promise<AuthorizationPreflightOutcome> {
  try {
    const graphResult = fromJson(compiledGraphJson as XoirGraphJson);
    if (!graphResult.ok) return { kind: 'error', errorCode: graphResult.error.code, errorMessage: graphResult.error.message };
    const graph = graphResult.value;
    const graphHash = ContentHash(graph.contentHash());

    const contractResult = buildSemanticCapabilityContract(graph, XoirNodeId(capabilityId));
    if (!contractResult.ok) return { kind: 'error', errorCode: contractResult.error.code, errorMessage: contractResult.error.message };
    const contract = contractResult.value;

    const decision = await authorizeContractExecution(contract, {
      permissionManager: authorization.permissionManager,
      subject: authorization.subject,
      permissionDeclaration: declaredPermissionsForNode(graph, contract.id),
    });
    if (!decision.allowed) {
      return {
        kind: 'denied',
        errorCode: ErrorCode.RUNTIME_PERMISSION_DENIED,
        errorMessage: `capability "${capabilityId}" was not authorized: ${decision.reason}`,
      };
    }
    return { kind: 'authorized', graphHash, contractId: contract.id };
  } catch (cause) {
    // Never an "allow" on a throw.
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      kind: 'denied',
      errorCode: ErrorCode.RUNTIME_PERMISSION_DENIED,
      errorMessage: `authorization could not be evaluated: ${message}`,
    };
  }
}

/** Optional hardening for `executeApprovedCapability` — see `preflightCapabilityAuthorization`. */
export interface ExecuteApprovedCapabilityOptions {
  /** The graph content hash a preflight authorized. If the graph loaded here has a different content hash, execution is refused (see `preflightCapabilityAuthorization` for what the hash does and does not detect). */
  readonly preflightGraphHash?: ContentHash;
}

/**
 * Executes exactly one capability from an already-compiled, already-
 * approved graph, through the real, unmodified `@xo/runtime`
 * capability-authority path — no `@xo/workflow-composer` dependency at
 * all (see this milestone's completion report's "runtime path reused"
 * section for why that's correct, not a shortcut).
 *
 * Sequence, each step reusing an existing, unmodified function:
 *
 *   1. `fromJson` (`@xo/xoir`) — rebuild the exact graph this
 *      compilation persisted (P0.5's addition to P0.4's stored result;
 *      see `compilations/compilation.ts`'s `CompilationSuccessInput.graph`
 *      doc comment) — never a fresh recompile, so execution is always
 *      against precisely what was reviewed/approved.
 *   2. `buildSemanticCapabilityContract` + `resolveCapabilityBinding`
 *      (`@xo/capability-contract`) — re-derive the contract and its
 *      resolved binding (including the callable `evaluate` closure,
 *      which a serialized manifest declaration can't carry — this is
 *      why step 3 below is a *second*, cheap call rather than reusing
 *      P0.4's already-computed `LowerCapabilitiesResult`).
 *   3. `lowerCapabilitiesToManifest` (`@xo/compiler`) — same call
 *      `compile-source.ts` already makes via `packageXoirGraph`, run
 *      again here (whole-graph, not per-capability — there is no
 *      single-capability variant) purely to obtain this capability's
 *      manifest-level `declaration.execution.inputSchema` for
 *      `validateCapabilityInput`.
 *   4. `registerResolvedCapabilityBinding` (`@xo/runtime`) — the one
 *      "explicit conversion model" this repo uses to turn a resolved
 *      semantic binding into an executable `RuntimeCapabilityDeclaration`
 *      (see that function's own doc comment on why this conversion is
 *      never implicit).
 *   5. `RuntimeCapabilityExecutor.execute` — the real execution call.
 *      Authorization (P1.0 M2): the caller's `ExecutionAuthorization`
 *      (authenticated principal + the server's deny-by-default
 *      `PermissionManager`) and the capability node's own persisted
 *      `requiredPermissions` declaration. Formerly a fresh empty
 *      `RuleBasedPolicy([])` per call — the same fail-closed-by-default
 *      pattern `apps/cli`'s `workflow-pipeline.ts` already uses (see
 *      this milestone's completion report's "permission-gate behavior"
 *      section for why this is NOT the `/runtime/execute` route's known
 *      `allowAllPermissionGate` fail-open behavior).
 */
export async function executeApprovedCapability(
  compiledGraphJson: unknown,
  capabilityId: string,
  input: unknown,
  authorization: ExecutionAuthorization,
  options: ExecuteApprovedCapabilityOptions = {},
): Promise<CapabilityExecutionOutcome> {
  const graphResult = fromJson(compiledGraphJson as XoirGraphJson);
  if (!graphResult.ok) return { kind: 'error', errorCode: graphResult.error.code, errorMessage: graphResult.error.message };
  const graph = graphResult.value;
  // Identity of the graph as loaded — captured before `findInputSchema`'s `lowerCapabilitiesToManifest` can embed contracts into it (idempotent for a graph `compile-source.ts` already lowered, but not for one persisted otherwise).
  const loadedGraphHash = ContentHash(graph.contentHash());
  // TOCTOU: a decision made by `preflightCapabilityAuthorization` is tied to one graph identity. Authorization is ALSO re-derived from the graph this
  // call actually runs (inside `executeResolvedContract`); if the graph's content hash is not the one a preflight authorized, refuse rather than run it.
  if (options.preflightGraphHash !== undefined && options.preflightGraphHash !== loadedGraphHash) {
    return {
      kind: 'error',
      errorCode: ErrorCode.RUNTIME_PERMISSION_DENIED,
      errorMessage: 'the compiled graph changed between the authorization preflight and execution — refused',
    };
  }

  const rebuilt = rebuildContractAndBinding(compiledGraphJson, capabilityId);
  if (!rebuilt.ok) return rebuilt.outcome as CapabilityExecutionOutcome;
  const { contract, binding } = rebuilt.value;

  const inputSchema = findInputSchema(graph, contract.id);
  if (inputSchema !== undefined) {
    const validation = validateCapabilityInput(inputSchema, input);
    if (!validation.valid) {
      return { kind: 'invalid_input', issues: validation.issues.map((issue) => ({ path: issue.property, message: issue.message })) };
    }
  }

  try {
    const execResult = await executeResolvedContract(contract, binding, {
      permissionManager: authorization.permissionManager,
      subject: authorization.subject,
      permissionDeclaration: declaredPermissionsForNode(graph, contract.id),
      input,
      graphHash: loadedGraphHash,
    });
    if (!execResult.ok) return { kind: 'error', errorCode: execResult.error.code, errorMessage: execResult.error.message };

    const output = execResult.value.output;
    const isEscalation =
      typeof output === 'object' && output !== null && (output as Record<string, unknown>)['status'] === 'escalation_required';
    const shared = {
      output,
      ...(execResult.value.contractId !== undefined ? { contractId: execResult.value.contractId } : {}),
      ...(execResult.value.bindingId !== undefined ? { bindingId: execResult.value.bindingId } : {}),
      ...(execResult.value.sourceXoirNodeIds !== undefined ? { sourceXoirNodeIds: execResult.value.sourceXoirNodeIds } : {}),
      ...(execResult.value.graphHash !== undefined ? { graphHash: execResult.value.graphHash } : {}),
      ...(execResult.value.contractContentHash !== undefined ? { contractContentHash: execResult.value.contractContentHash } : {}),
    };
    return isEscalation ? { kind: 'waiting_for_human', ...shared } : { kind: 'succeeded', ...shared };
  } catch (cause) {
    // Defensive, same posture as `compile-source.ts`'s own catch — a
    // runtime-internal throw is still an honest failure, never an
    // uncaught 500 or a fabricated success.
    const message = cause instanceof Error ? cause.message : String(cause);
    return { kind: 'error', errorCode: ErrorCode.UNKNOWN, errorMessage: `runtime execution threw unexpectedly: ${message}` };
  }
}

/**
 * Resumes a `waiting_for_human` execution given a real human decision —
 * see `resume-human-task.ts`'s doc comment for the full architecture
 * rationale (why this re-derives the contract/binding from the
 * PERSISTED compiled graph rather than recompiling, why reject never
 * invokes the runtime at all, and what "succeeded" honestly means for
 * the one binding type — `ActionEscalationBindingResolver` — every
 * production capability in this codebase currently resolves to).
 *
 * `originalInput` is the input the ORIGINAL execution ran with (already
 * persisted on the `ExecutionRecord`) — never re-supplied by the
 * resolver, so a client resolving a task cannot smuggle a different
 * business input in through the decision request.
 */
export async function resumeCapabilityExecution(
  compiledGraphJson: unknown,
  capabilityId: string,
  originalInput: unknown,
  decision: 'approve' | 'reject',
  decisionData: Readonly<Record<string, unknown>> | undefined,
  authorization: ExecutionAuthorization,
): Promise<CapabilityResumeOutcome> {
  const graphResult = fromJson(compiledGraphJson as XoirGraphJson);
  if (!graphResult.ok) return { kind: 'error', errorCode: graphResult.error.code, errorMessage: graphResult.error.message };
  const graph = graphResult.value;
  // Identity of the graph as loaded — captured before `findInputSchema`'s `lowerCapabilitiesToManifest` can embed contracts into it (idempotent for a graph `compile-source.ts` already lowered, but not for one persisted otherwise).
  const loadedGraphHash = ContentHash(graph.contentHash());

  const rebuilt = rebuildContractAndBinding(compiledGraphJson, capabilityId);
  if (!rebuilt.ok) return rebuilt.outcome as CapabilityResumeOutcome;
  const { contract, binding } = rebuilt.value;

  // P1.0 M2: resolving a human task (approve OR reject) is a protected action
  // performed by the RESOLVER (not the initiator). Authorization is decided
  // here, once, before any outcome — a reject must not be a way around the gate.
  const declaration = declaredPermissionsForNode(graph, contract.id);
  const authorized = await authorizeCapabilityExecution({
    manager: authorization.permissionManager,
    subject: authorization.subject,
    requester: { packageId: NATIVE_CAPABILITY_REQUESTER, capabilityId: contract.id },
    declaration,
  });
  if (!authorized.allowed)
    return {
      kind: 'error',
      errorCode: ErrorCode.RUNTIME_PERMISSION_DENIED,
      errorMessage: `resolver was not authorized: ${authorized.reason}`,
    };

  if (decision === 'reject') {
    // "Do not execute the pending capability action" — no
    // `RuntimeCapabilityExecutor` call at all for reject; this is a
    // pure, structured, business-level rejection record.
    return {
      kind: 'rejected',
      output: {
        status: 'rejected_by_human',
        capabilityId: contract.id,
        capabilityName: contract.name,
        decision: 'reject',
        ...(decisionData !== undefined ? { decisionData } : {}),
      },
      contractId: contract.id,
      bindingId: binding.id,
    };
  }

  // approve: decision data is validated against the SAME contract-
  // derived schema `executeApprovedCapability` validates ordinary input
  // against — the natural, existing extension point for "derive allowed
  // fields from the existing capability contract" (no HITL capability in
  // this codebase declares one today; this milestone's test-only fixture
  // does, specifically to exercise this path).
  const decisionSchema = findInputSchema(graph, contract.id);
  if (decisionSchema !== undefined) {
    const validation = validateCapabilityInput(decisionSchema, decisionData ?? {});
    if (!validation.valid) {
      return { kind: 'invalid_input', issues: validation.issues.map((issue) => ({ path: issue.property, message: issue.message })) };
    }
  }

  // `executeResolvedContract` builds a genuinely fresh registry,
  // `RuntimeCapabilityExecutor`, and (below) a genuinely fresh
  // `PermissionManager`/`RuleBasedPolicy([])` on every call — nothing
  // cached from the original execution — so the permission gate is truly
  // re-checked here, not merely re-labeled as re-checked.

  // The one genuine re-invocation of the binding's `evaluate`, with the
  // human's decision merged into input as an additive field
  // (`humanDecision`) — never replacing or discarding the original
  // input (see this function's own doc comment). For
  // `ActionEscalationBindingResolver`'s binding this changes nothing
  // (that binding is documented pure/stateless and does not branch on
  // it — see `resume-human-task.ts`); for a binding that DOES branch on
  // `input.humanDecision` (this milestone's test-only fixture), this is
  // what makes a materially different result possible.
  const mergedInput = {
    ...(typeof originalInput === 'object' && originalInput !== null ? originalInput : {}),
    humanDecision: { decision: 'approve', data: decisionData ?? {} },
  };

  try {
    const execResult = await executeResolvedContract(contract, binding, {
      permissionManager: authorization.permissionManager,
      subject: authorization.subject,
      permissionDeclaration: declaredPermissionsForNode(graph, contract.id),
      input: mergedInput,
      graphHash: loadedGraphHash,
    });
    if (!execResult.ok) return { kind: 'error', errorCode: execResult.error.code, errorMessage: execResult.error.message };

    const rawOutput = execResult.value.output;
    const isStillEscalating =
      typeof rawOutput === 'object' && rawOutput !== null && (rawOutput as Record<string, unknown>)['status'] === 'escalation_required';
    // For a binding whose `evaluate` still (deterministically) reports
    // an escalation even with the human's decision merged into input —
    // exactly what `ActionEscalationBindingResolver` always does — the
    // human-in-the-loop TASK this execution represents is nonetheless
    // genuinely complete: the system correctly identified this needed a
    // human, and a human has now authoritatively confirmed it. That
    // completion, not a fabricated automated computation, is what
    // `'succeeded'` means here — the original escalation is preserved
    // verbatim (`originalEscalation`) so nothing is hidden or implied
    // that didn't happen.
    const output = isStillEscalating
      ? {
          status: 'human_confirmed',
          capabilityId: contract.id,
          capabilityName: contract.name,
          decision: 'approve',
          originalEscalation: rawOutput,
          ...(decisionData !== undefined ? { decisionData } : {}),
        }
      : rawOutput;

    return {
      kind: 'succeeded',
      output,
      ...(execResult.value.contractId !== undefined ? { contractId: execResult.value.contractId } : {}),
      ...(execResult.value.bindingId !== undefined ? { bindingId: execResult.value.bindingId } : {}),
      ...(execResult.value.sourceXoirNodeIds !== undefined ? { sourceXoirNodeIds: execResult.value.sourceXoirNodeIds } : {}),
      ...(execResult.value.graphHash !== undefined ? { graphHash: execResult.value.graphHash } : {}),
      ...(execResult.value.contractContentHash !== undefined ? { contractContentHash: execResult.value.contractContentHash } : {}),
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { kind: 'error', errorCode: ErrorCode.UNKNOWN, errorMessage: `runtime resume threw unexpectedly: ${message}` };
  }
}
