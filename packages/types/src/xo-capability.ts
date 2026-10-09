import type { ComponentKind, ModelFamily } from './compatibility.js';

/** How a capability's `confidence.score` was arrived at — matters for how much a negotiator should trust it. `self_reported` (the only kind a creator can produce unilaterally) is the weakest; `benchmark`/`expert_review` correspond to the verification paths SPECIFICATION.md §3 describes for the package as a whole, applied at the individual-capability grain. */
export type CapabilityConfidenceBasis = 'self_reported' | 'benchmark' | 'expert_review';

export interface CapabilityConfidence {
  /** 0 (no confidence) to 1 (fully verified). */
  readonly score: number;
  readonly basis: CapabilityConfidenceBasis;
}

/**
 * How a capability should actually be run — the "R1" authoritative
 * execution decision point. Widened in R5 to a third member, `'hybrid'`
 * — see `HybridExecutionStep`'s doc comment for what that means. Widened
 * again (Human-in-the-Loop Execution Class Lowering milestone) to a
 * fourth member, `'human_in_the_loop'`: this is the manifest-level
 * counterpart of `@xo/capability-contract`'s `ActionEscalationBindingResolver`,
 * which already produces a `CapabilityBinding` with
 * `implementationClass: 'human_in_the_loop'` (Action Capability Binding
 * v1, unchanged by this addition) and which `@xo/runtime`'s
 * capability-authority registration path already accepts and executes
 * (also unchanged). Prior to this member existing, a capability whose
 * binding resolved to `human_in_the_loop` had no valid `mode` value to be
 * lowered into a manifest declaration with, and so was never promoted
 * past discovery — this addition closes exactly that gap, adding no new
 * semantic judgment of its own. `R4`'s `ExecutionStrategyRouter`
 * (`@xo/runtime`) is the sole place a `CapabilityExecutionMode` value is
 * turned into a decision about which executor runs; nothing about that
 * seam changes here — this type only grows one more recognized value for
 * it to resolve.
 *
 * Lives on `CapabilityDeclaration` (not as a parallel runtime-only
 * structure) because a `CapabilityDeclaration` is already the
 * authoritative, manifest-carried, package-format representation of a
 * capability (`SPECIFICATION.md`'s capability model) — the compiler's
 * `Packager` (`EXPERIENCE_COMPILER.md` §9) already lowers a `Capability`
 * XOIR node into one of these; teaching it to also carry an `execution`
 * field is an additive lowering, not a new abstraction. This field is
 * OPTIONAL specifically so every `.xo` package that predates it —
 * including ones already compiled — keeps validating and loading exactly
 * as before; a runtime that finds it absent falls back to whatever
 * discovery mechanism it used before this field existed.
 */
export type CapabilityExecutionMode = 'deterministic_rule' | 'model' | 'hybrid' | 'human_in_the_loop';

/**
 * The strategy a single hybrid step runs as. Deliberately NOT
 * `CapabilityExecutionMode` itself: a hybrid step can never be `'hybrid'`
 * — R5 is a small, fixed-depth ordered sequence of the two atomic
 * strategies R1 already established, not a recursively composable one.
 * This narrower type makes that invariant a compile-time fact for any
 * caller building a declaration with normal TypeScript-checked code,
 * exactly the same "closed union forecloses the question" discipline
 * `ExecutionStrategyName` already uses in `@xo/runtime`.
 */
export type HybridStepStrategy = 'deterministic_rule' | 'model';

/**
 * Where one hybrid step's input value comes from. `'request'` means the
 * capability invocation's own input (the request's `structuredInput` for
 * a `'deterministic_rule'` step, or its free-text `input` for a
 * `'model'` step — the exact same request-level values R1/R2's
 * single-strategy paths already read). `'step'` means the named prior
 * step's own output, threaded forward.
 *
 * A plain, JSON-serializable, `kind`-discriminated shape — no closures,
 * no expression language — mirroring `WorkflowCondition`'s own
 * `'expression'`-vs-`'predicate'` convention (`@xo/runtime`'s
 * `workflow-graph.ts`) so a compiler could emit this shape directly, the
 * same way it could emit a `WorkflowCondition`. Deliberately does not
 * support a field-path *into* a step's output (e.g. "step A's `.foo`
 * field") — only the whole prior output — because R5 threads whole
 * values between exactly two strategy shapes (a deterministic step's
 * structured object, a model step's response text), and a sub-field
 * reference would be solving a problem R5 doesn't have yet.
 */
export type HybridStepInputSource = { readonly kind: 'request' } | { readonly kind: 'step'; readonly stepId: string };

/**
 * One step of a `'hybrid'`-mode capability's ordered execution sequence
 * (`CapabilityExecutionDeclaration.hybridSteps`). Everything a
 * `'deterministic_rule'` step needs to run is the same subset of fields
 * `CapabilityExecutionDeclaration` itself already carries for a
 * single-strategy deterministic capability (R1) — `bindingId`,
 * `contractId`, `inputSchema` — reused verbatim rather than
 * reinvented, so a hybrid deterministic step is validated and executed
 * through the exact same `@xo/capability-contract`/
 * `RuntimeCapabilityExecutor` path a non-hybrid one already is. A
 * `'model'` step needs no extra fields at all: it reuses whatever
 * context/prompt-assembly the capability's own retrieval already
 * produced, exactly as the single-strategy `'model'` path does.
 */
export interface HybridExecutionStep {
  /** Unique within one declaration's `hybridSteps` list. Referenced by a later step's `HybridStepInputSource` (`{ kind: 'step', stepId }`) — a step may only reference a step that runs strictly before it. */
  readonly stepId: string;
  readonly strategy: HybridStepStrategy;
  readonly input: HybridStepInputSource;
  /** `'deterministic_rule'` steps only — see `CapabilityExecutionDeclaration.bindingId`'s own doc comment; identical meaning, scoped to this one step. */
  readonly bindingId?: string;
  /** `'deterministic_rule'` steps only — see `CapabilityExecutionDeclaration.contractId`'s own doc comment; identical meaning, scoped to this one step. */
  readonly contractId?: string;
  /** `'deterministic_rule'` steps only — see `CapabilityExecutionDeclaration.inputSchema`'s own doc comment; identical meaning (R2 validation applies per-step), scoped to this one step. */
  readonly inputSchema?: CapabilityInputSchema;
}

/** Primitive types this runtime's deterministic evaluators can validate against — deliberately not a general JSON Schema (see `CapabilityInputSchema`'s doc comment). */
export type CapabilityInputPropertyType = 'string' | 'number' | 'boolean';

/**
 * A minimal, flat, object-only input contract — deliberately not a
 * general-purpose JSON Schema (no nesting, no `$ref`, no numeric ranges,
 * no string patterns). This mirrors `@xo/ai-core`'s `JsonSchema` in
 * spirit (same "smallest correct subset" philosophy that package
 * documents for its own, unrelated concern of provider *output* shape
 * hinting) but is intentionally a distinct, smaller type here: a
 * deterministic capability's input is a flat property bag by
 * construction (`StructuredComparisonBindingResolver`'s evaluator reads
 * `input[fieldKey]` directly, never a nested path), so a schema capable
 * of describing nested/array shapes would claim more than this runtime's
 * current deterministic evaluators can actually enforce. Widen this only
 * when an evaluator that needs the extra shape exists.
 */
export interface CapabilityInputSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, { readonly type: CapabilityInputPropertyType }>>;
  readonly required: readonly string[];
}

export interface CapabilityExecutionDeclaration {
  readonly mode: CapabilityExecutionMode;
  /** Identifies which resolved `CapabilityBinding` (`@xo/capability-contract`) this declaration refers to, for a runtime that has already resolved one and wants to confirm it's authorized to skip re-resolution. Optional: a `mode` alone is enough to make the deterministic-vs-model routing decision even before a binding has been resolved. */
  readonly bindingId?: string;
  /** Identifies the `SemanticCapabilityContract` (`@xo/capability-contract`) a runtime should fetch to actually resolve/execute this capability's binding — typically, but not necessarily, equal to the capability's own `id`. Kept separate from `id` because a future compiler could legitimately lower one XOIR capability into a contract stored under a different, more stable identifier. */
  readonly contractId?: string;
  /** P0.9B, optional and additive. The `computeContractContentHash` (`@xo/capability-contract`) of the contract `contractId` names — a hash over that contract's semantic content only (not its id, confidence, or provenance), so a consumer can tell whether the contract it fetches is the same content this declaration was lowered from. Absent on any package compiled before P0.9B. */
  readonly contractContentHash?: string;
  /** Present only for `mode: 'deterministic_rule'` — a runtime MUST validate input against this before executing, per R2. Absent means no structural validation is possible from this declaration alone (the runtime may still fall back to whatever validation the resolved binding itself performs). */
  readonly inputSchema?: CapabilityInputSchema;
  /** Permission ids (`@xo/permissions`' `PermissionId` string form) this specific execution mode needs — distinct from, and additive to, whatever the manifest's own `permissions[]` array declares for this capability id. Most packages should prefer declaring permissions via the manifest's `permissions[]` (see `ManifestPermissionDeclaration`) rather than here; this field exists for a permission requirement that's intrinsic to the *execution mode itself* (e.g. "any deterministic-rule execution needs `runtime.execute`") rather than to the specific capability's business logic. */
  readonly requiredPermissionIds?: readonly string[];
  /**
   * R5. Present, and meaningful, only when `mode === 'hybrid'` — an
   * ordered, non-empty list of steps this capability's single invocation
   * runs in sequence, each step's output available to every later step
   * via `HybridExecutionStep.input`'s `{ kind: 'step' }` reference. The
   * capability invocation as a whole still produces exactly one
   * `ExecutionResult`/`ExecutionReceipt` — see `@xo/runtime`'s
   * `HybridExecutionExecutor`. Absent for every non-`'hybrid'` mode,
   * including every `.xo` package compiled before R5, which keeps
   * validating and loading exactly as before (purely additive field, per
   * this interface's existing R1-era fields' own convention).
   */
  readonly hybridSteps?: readonly HybridExecutionStep[];
}

export interface CapabilityCostEstimate {
  /** ISO 4217 currency code, e.g. "USD". */
  readonly currency: string;
  /** Estimated cost of one invocation of this capability. */
  readonly amount: number;
}

/**
 * A single capability an XO package declares it can perform (e.g.
 * `contract_analysis`, `fraud_detection`), as data the package itself
 * carries in its manifest — not something a host or runtime infers from
 * `metadata.json`'s free-text `domain`/`scope`. This is what
 * `@xo/runtime`'s capability registry and negotiator index and rank
 * against; a package that doesn't declare a capability here does not
 * expose it, regardless of what its metadata says about itself.
 *
 * `requiredComponents` and `providerCompatibility` are capability-level
 * refinements of the package-level `components`/`compatibility` a
 * manifest already declares: a package can bundle components or declare
 * host-family support broader than any single one of its capabilities
 * actually needs, so each capability states its own subset.
 */
export interface CapabilityDeclaration {
  /** Stable identifier, unique within the manifest that declares it (e.g. "contract_analysis"). Not globally unique across packages — a runtime distinguishes same-id capabilities from different packages by package name + version, not by capability id alone. */
  readonly id: string;
  readonly name: string;
  /** Free-text semantic description a negotiator can match a request against (Runtime Stage 1 does this by exact/substring match only — no embedding or reasoning-based matching, per the "pure deterministic planning" requirement; that's a later runtime stage). */
  readonly description: string;
  /** Model families this specific capability supports — a subset of the families listed in the manifest's own `compatibility.modelFamilies`. */
  readonly providerCompatibility: readonly ModelFamily[];
  /** Component kinds this capability needs present to function. Every entry must correspond to a component the manifest actually declares (checked by `@xo/package-sdk`'s `PackageValidator`) — a capability cannot require a component the package doesn't carry. */
  readonly requiredComponents: readonly ComponentKind[];
  readonly estimatedCost: CapabilityCostEstimate;
  readonly estimatedLatencyMs: number;
  /** Self-declared (or, once benchmarked/reviewed, externally attested) confidence in this capability, independent of the package's overall trust/verification state. */
  readonly confidence: CapabilityConfidence;
  /**
   * The authoritative execution-strategy decision point (R1). Optional
   * and additive: absent on every `.xo` package compiled before this
   * field existed, and a runtime encountering an absent `execution`
   * must fall back to its own prior discovery mechanism (documented at
   * the specific fallback call site — see `apps/cli`'s
   * `deterministic-router.ts`) rather than failing. Present means the
   * runtime can skip that fallback entirely and go straight to
   * authorization + execution.
   */
  readonly execution?: CapabilityExecutionDeclaration;
}
