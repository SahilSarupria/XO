import type { CapabilityCostEstimate, ComponentKind, ContentHash } from '@xo/types';
import type { ValidationReport } from '@xo/package-sdk';
import type { ExecutionEnvironment } from '../execution/execution-request.js';
import type { ExecutionPlan, RankedCandidate } from '../execution/execution-plan.js';
import type { PackageRegistry } from '../registry/mounted-package.js';
import type { StructuredResponse, TokenUsage } from '../response/response-assembler.js';
import { ReceiptId, type ExecutionId, type PlanId, type RequestId } from '../ids.js';

export interface ExecutionReceiptPackageRecord {
  readonly name: string;
  readonly version: string;
}

export interface ExecutionReceiptComponentRecord {
  readonly kind: ComponentKind;
  readonly hash: ContentHash;
}

// `TokenUsage` ({ promptTokens, completionTokens }) is defined once, in
// `response/response-assembler.ts` — it started life here (Stage 1's
// original placeholder-shape doc comment used to live at this exact
// spot) but the shape and its owner are the same either way, so it's
// imported from there now rather than declared twice.

/**
 * An immutable record of one execution attempt. In Stage 1, "execution"
 * means the mount-verification + deterministic-planning pipeline itself
 * — there is no prompt assembly, retrieval, or provider call yet for a
 * receipt to describe, so `capabilitiesInvoked` names capabilities that
 * were *selected by planning*, not capabilities that were actually
 * exercised by a model. That distinction is preserved deliberately
 * rather than glossed over: a later runtime stage that adds real
 * execution should be able to tell Stage 1 receipts and its own apart by
 * this field's meaning, not just by which runtime stage produced them.
 */
export interface ExecutionReceipt {
  readonly receiptId: ReceiptId;
  readonly requestId: RequestId;
  readonly planId: PlanId;
  readonly packagesUsed: readonly ExecutionReceiptPackageRecord[];
  readonly componentHashes: readonly ExecutionReceiptComponentRecord[];
  readonly capabilitiesInvoked: readonly string[];
  readonly provider?: string;
  readonly executionDurationMs: number;
  readonly tokenUsage: TokenUsage;
  readonly validationResults: ValidationReport;
  readonly errors: readonly string[];
  readonly createdAt: string;
  /** Stage 2. Absent for a Stage 1 planning-only receipt (`buildReceipt`); present on a Stage 2 execution receipt (`buildExecutionReceipt`) — the executed capability's own `estimatedCost`, not a real provider-billed figure (`@xo/ai-core` is provisional and has no real billing data to report). */
  readonly estimatedCost?: CapabilityCostEstimate;
  /** Stage 2. `true` iff anything degraded before this receipt's response was produced (see `BudgetManager.fit`'s `degraded` flag, or an `L0` `degrade_gracefully` plan). Absent on a Stage 1 receipt. */
  readonly degraded?: boolean;
  /**
   * Capability-authority execution path only (`buildCapabilityAuthorityReceipt`,
   * below) — absent on every Stage 1/Stage 2 (manifest/AI-provider path)
   * receipt. The `@xo/capability-contract` contract id (== the source
   * XOIR capability node's id) this execution's `RuntimeCapabilityDeclaration`
   * was registered from — see `registerResolvedCapabilityBinding`.
   */
  readonly contractId?: string;
  /** Capability-authority execution path only — the `CapabilityBinding.id` (from `@xo/capability-contract`) whose evaluator actually ran. */
  readonly bindingId?: string;
  /**
   * Capability-authority execution path only — every XOIR node id this
   * execution's contract was built from (the capability node plus every
   * linked rule node — see `SemanticCapabilityContract.sourceXoirNodeIds`),
   * preserved verbatim so a receipt can be traced back through the
   * contract to the original compiled XOIR, and from there (via each
   * node's own `sourceRefs`) back to source document evidence — the full
   * chain §8 requires, reusing the existing provenance structures at
   * every step rather than inventing a parallel one.
   */
  readonly sourceXoirNodeIds?: readonly string[];
  /**
   * R5, `'hybrid'`-mode capability executions only (see
   * `execution/hybrid-execution-executor.ts`) — absent for every other
   * execution path, including every `.xo` package compiled before R5.
   * One entry per `HybridExecutionStep` that ran, in declared order,
   * naming which strategy each step used. Intentionally minimal: this is
   * step *identification*, not step-level provenance/tracing (execution
   * IDs, timing, or a per-step receipt are explicitly R6 concerns) — the
   * receipt as a whole (this same `ExecutionReceipt`) remains the one
   * authoritative record of the capability invocation.
   */
  readonly hybridSteps?: readonly ExecutionReceiptHybridStepRecord[];

  // --- R6 -----------------------------------------------------------
  // All additive; every existing builder call site that does not
  // explicitly pass these leaves them absent, exactly as this file's
  // prior two extension rounds (Stage 2, R5) already did.

  /** R6. Present on every receipt built by an R6-aware caller — see `engine/execution-attempt-id.ts`/`engine/execution-id.ts`. Absent only for a receipt built by test code that constructs `ExecutionReceipt` by hand without going through a pipeline builder. */
  readonly executionId?: ExecutionId;
  /** R6. Total attempts actually made for this execution — `1` unless retry ran and a later attempt succeeded. Never present alongside a failed/no-receipt outcome; a receipt only exists for a completed (possibly-retried) execution. */
  readonly attempts?: number;
  /** R6. `attempts !== undefined && attempts > 1` — kept as its own boolean so a consumer doesn't have to compare `attempts` to a literal. */
  readonly retried?: boolean;
  /** R6. `true` iff this execution ran under `ExecutionRequest.simulate === true` — see `execution/simulation-gate.ts`. A receipt with `simulated: true` never reflects a real provider/handler call. */
  readonly simulated?: boolean;
  /**
   * R6. The exact effective inputs a strategy actually ran with —
   * `{ input: <effectiveInput> }` for a `'model'`-mode execution,
   * `structuredInput` verbatim for a `'deterministic_rule'` execution.
   * Recorded specifically so `execution/replay.ts` has something
   * concrete to reconstruct from; absent on any receipt not built by an
   * R6-aware call site.
   */
  readonly recordedInputs?: Readonly<Record<string, unknown>>;
  /**
   * R6, `'deterministic_rule'` executions only (via
   * `buildCapabilityAuthorityReceipt`). The handler's raw output,
   * verbatim — this is what lets `execution/replay.ts` reconstruct a
   * deterministic execution's result WITHOUT ever re-invoking the
   * handler (see that file's doc comment: replay never risks a second
   * side effect for this strategy). Never populated for `'model'` or
   * `'hybrid'` receipts — replaying those re-invokes the model call for
   * real instead (see `execution/replay.ts`).
   */
  readonly recordedOutput?: unknown;
  /**
   * R6, `execution/replay.ts` only. Present iff this receipt was itself
   * produced by replaying an earlier execution — names that earlier
   * execution's id. Absent on every ordinarily-produced receipt.
   */
  readonly replayOf?: ExecutionId;
  /** R6, `execution/replay.ts` only — paired with `replayOf`. */
  readonly replayMode?: 'reconstruct-and-rerun-model' | 'recorded-output-only';
  /**
   * R6 — capability-collision observability (§K of the R6 design).
   * Every candidate `CapabilityNegotiator.rank()` considered for this
   * request, best-first, exactly as already computed by Stage 1's
   * negotiator — this is visibility into an existing, deterministic
   * decision, never a second resolution mechanism. A single-candidate
   * list is not "ambiguity", it simply means only one implementation
   * was eligible.
   */
  readonly negotiationCandidates?: readonly ExecutionReceiptNegotiationCandidate[];

  // --- P0.9B, graph identity — all additive ---------------------------

  /**
   * Capability-authority execution path only, and only when the
   * declaration was registered from a *live* `XoirGraph` (see
   * `RuntimeCapabilityDeclaration.graphHash`'s doc comment) — the same
   * `XoirGraph.contentHash()` value cached on that graph's
   * `XoirManifest.graphHash` at compile time. Lets a receipt be traced
   * back to the exact compiled graph it was produced from, independent
   * of `sourceXoirNodeIds` (which names individual nodes, not the graph
   * as a whole). Absent for the installed-package execution path, which
   * has no live graph to hash — an intentional information-boundary
   * difference (see `capability-binding-registration.ts`'s doc comment),
   * not a gap.
   */
  readonly graphHash?: ContentHash;
  /**
   * Capability-authority path only. The semantic content hash of the
   * contract that was executed (`computeContractContentHash`,
   * `@xo/capability-contract`) — present on both the live-graph and the
   * installed-package path, since both have a contract to hash.
   */
  readonly contractContentHash?: ContentHash;
}

/** One entry of `ExecutionReceipt.negotiationCandidates` — see that field's doc comment. `rank` is `0`-based, `0` == the candidate this receipt's execution actually used. */
export interface ExecutionReceiptNegotiationCandidate {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly capabilityId: string;
  readonly reachedLevel: string;
  readonly rank: number;
}

function toNegotiationCandidates(candidates: readonly RankedCandidate[]): readonly ExecutionReceiptNegotiationCandidate[] {
  return candidates.map((candidate) => ({
    packageName: candidate.capability.packageName,
    packageVersion: candidate.capability.packageVersion,
    capabilityId: candidate.capability.declaration.id,
    reachedLevel: candidate.compatibility.reachedLevel,
    rank: candidate.rank,
  }));
}

/** One entry of `ExecutionReceipt.hybridSteps` — see that field's doc comment. */
export interface ExecutionReceiptHybridStepRecord {
  readonly stepId: string;
  readonly strategy: 'deterministic_rule' | 'model';
}

export interface BuildReceiptParams {
  readonly plan: ExecutionPlan;
  readonly registry: PackageRegistry;
  readonly validationResults: ValidationReport;
  readonly executionDurationMs: number;
  readonly environment?: ExecutionEnvironment;
  readonly errors?: readonly string[];
  readonly now?: () => Date;
}

/**
 * Assembles the receipt for one planning attempt. Pulls
 * `packagesUsed`/`componentHashes` from the plan's `selected` candidate
 * (if any) resolved back against `registry` — never from the request or
 * the caller, so a receipt can't claim a package was used that wasn't
 * actually the one the negotiator selected.
 */
export function buildReceipt(params: BuildReceiptParams): ExecutionReceipt {
  const { plan, registry, validationResults, executionDurationMs, environment, errors = [], now = () => new Date() } = params;
  const selectedMount = plan.selected ? registry.get(plan.selected.capability.packageName, plan.selected.capability.packageVersion) : undefined;

  return Object.freeze({
    receiptId: ReceiptId(`receipt_${plan.planId}_${now().getTime()}`),
    requestId: plan.requestId,
    planId: plan.planId,
    packagesUsed: selectedMount ? [{ name: selectedMount.name, version: selectedMount.version }] : [],
    componentHashes: selectedMount ? Object.entries(selectedMount.manifest.components).map(([kind, entry]) => ({ kind: kind as ComponentKind, hash: entry.hash })) : [],
    capabilitiesInvoked: plan.selected ? [plan.selected.capability.declaration.id] : [],
    ...(environment?.provider !== undefined ? { provider: environment.provider } : {}),
    executionDurationMs,
    tokenUsage: { promptTokens: 0, completionTokens: 0 },
    validationResults,
    errors,
    createdAt: now().toISOString(),
  });
}

// --- Stage 2 -------------------------------------------------------
// Everything above (including `buildReceipt`) is unmodified in behavior
// — `ExecutionReceipt` only gained two new *optional* fields, which
// `buildReceipt` never sets. `buildExecutionReceipt` below is new: it
// builds a receipt for a completed AI Capability Layer call, not just a
// plan.

export interface BuildExecutionReceiptParams {
  readonly plan: ExecutionPlan;
  readonly registry: PackageRegistry;
  readonly response: StructuredResponse;
  readonly validationResults: ValidationReport;
  readonly executionDurationMs: number;
  readonly environment?: ExecutionEnvironment;
  readonly errors?: readonly string[];
  readonly now?: () => Date;
  // --- R6, all optional/additive ---
  readonly executionId?: ExecutionId;
  readonly attempts?: number;
  readonly simulated?: boolean;
  readonly recordedInputs?: Readonly<Record<string, unknown>>;
  readonly recordedOutput?: unknown;
}

/**
 * Builds the receipt for a completed Stage 2 execution — same shape as
 * {@link buildReceipt}, but `tokenUsage`/`estimatedCost` come from the
 * real `StructuredResponse` the AI Capability Layer produced rather than
 * `buildReceipt`'s fixed `{0, 0}` placeholder, and `degraded` reflects
 * whatever `ExecutionPipeline` observed (budget trimming, `L0` fallback).
 */
export function buildExecutionReceipt(params: BuildExecutionReceiptParams): ExecutionReceipt {
  const { plan, registry, response, validationResults, executionDurationMs, environment, errors = [], now = () => new Date(), executionId, attempts, simulated, recordedInputs, recordedOutput } = params;
  const selectedMount = plan.selected ? registry.get(plan.selected.capability.packageName, plan.selected.capability.packageVersion) : undefined;

  return Object.freeze({
    receiptId: ReceiptId(`receipt_${plan.planId}_${now().getTime()}`),
    requestId: plan.requestId,
    planId: plan.planId,
    packagesUsed: selectedMount ? [{ name: selectedMount.name, version: selectedMount.version }] : [],
    componentHashes: selectedMount ? Object.entries(selectedMount.manifest.components).map(([kind, entry]) => ({ kind: kind as ComponentKind, hash: entry.hash })) : [],
    capabilitiesInvoked: [response.capabilityId],
    ...(environment?.provider !== undefined ? { provider: environment.provider } : {}),
    executionDurationMs,
    tokenUsage: response.usage,
    validationResults,
    errors,
    createdAt: now().toISOString(),
    ...(plan.selected ? { estimatedCost: plan.selected.capability.declaration.estimatedCost } : {}),
    degraded: response.degraded,
    ...(executionId !== undefined ? { executionId } : {}),
    ...(attempts !== undefined ? { attempts, retried: attempts > 1 } : {}),
    ...(simulated !== undefined ? { simulated } : {}),
    ...(recordedInputs !== undefined ? { recordedInputs } : {}),
    ...(recordedOutput !== undefined ? { recordedOutput } : {}),
    ...(plan.candidates.length > 0 ? { negotiationCandidates: toNegotiationCandidates(plan.candidates) } : {}),
  });
}

// --- Capability authority (semantic discovery -> binding -> execution) ---
// A third, deliberately separate builder, for the native
// RuntimeCapabilityExecutor path (@xo/capability-contract's discovered
// contracts + resolved bindings — see capability-authority/capability-
// binding-registration.ts). This path has no ExecutionPlan/PackageRegistry
// to pull packagesUsed/componentHashes from — a native capability may have
// no backing package at all (see NATIVE_CAPABILITY_REQUESTER's own doc
// comment) — so this builder takes its inputs directly from a
// RuntimeCapabilityExecutionResult plus the contract/binding that produced
// it, rather than a plan. Per §8 ("reuse existing provenance structures, do
// not invent a parallel system"), the *type* being built is still the same
// ExecutionReceipt — only the three new optional fields above are ever set
// here, and only here.

export interface BuildCapabilityAuthorityReceiptParams {
  readonly requestId: RequestId;
  readonly planId: PlanId;
  readonly capabilityId: string;
  readonly contractId: string;
  readonly bindingId: string;
  readonly sourceXoirNodeIds: readonly string[];
  readonly executionDurationMs: number;
  readonly errors?: readonly string[];
  readonly now?: () => Date;
  // --- R6, all optional/additive ---
  readonly executionId?: ExecutionId;
  readonly attempts?: number;
  readonly simulated?: boolean;
  readonly recordedInputs?: Readonly<Record<string, unknown>>;
  readonly recordedOutput?: unknown;
  // --- P0.9B, all optional/additive ---
  readonly graphHash?: ContentHash;
  readonly contractContentHash?: ContentHash;
}

/**
 * Builds a receipt for one `RuntimeCapabilityExecutor.execute()` call made
 * against a binding `registerResolvedCapabilityBinding` registered.
 * `packagesUsed`/`componentHashes` are always empty and `validationResults`
 * is always a trivial passing report — there is no package or component
 * validation involved in this path (the contract this execution traces
 * back to was validated, if at all, when its source package was mounted,
 * not at execution time) — never a fabricated validation result standing
 * in for one that didn't actually run.
 */
export function buildCapabilityAuthorityReceipt(params: BuildCapabilityAuthorityReceiptParams): ExecutionReceipt {
  const { requestId, planId, capabilityId, contractId, bindingId, sourceXoirNodeIds, executionDurationMs, errors = [], now = () => new Date(), executionId, attempts, simulated, recordedInputs, recordedOutput, graphHash, contractContentHash } = params;

  return Object.freeze({
    receiptId: ReceiptId(`receipt_${planId}_${now().getTime()}`),
    requestId,
    planId,
    packagesUsed: [],
    componentHashes: [],
    capabilitiesInvoked: [capabilityId],
    executionDurationMs,
    tokenUsage: { promptTokens: 0, completionTokens: 0 },
    validationResults: { valid: true, issues: [] },
    errors,
    createdAt: now().toISOString(),
    contractId,
    bindingId,
    sourceXoirNodeIds,
    ...(graphHash !== undefined ? { graphHash } : {}),
    ...(contractContentHash !== undefined ? { contractContentHash } : {}),
    ...(executionId !== undefined ? { executionId } : {}),
    ...(attempts !== undefined ? { attempts, retried: attempts > 1 } : {}),
    ...(simulated !== undefined ? { simulated } : {}),
    ...(recordedInputs !== undefined ? { recordedInputs } : {}),
    ...(recordedOutput !== undefined ? { recordedOutput } : {}),
  });
}
