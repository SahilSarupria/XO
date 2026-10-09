// No imports from @xo/xoir in this file — see the doc comment above
// SemanticCapabilityContract for why that's a deliberate, load-bearing
// choice, not an oversight.
//
// `structured-expression-grammar.ts` (Phase 2) is a same-package,
// XOIR-independent module, so importing its types here does not violate
// that rule.
import type { StructuredAction, StructuredCondition, StructuredExceptionCondition } from './structured-expression-grammar.js';

/**
 * Deliberately plain `string`, not `@xo/xoir`'s branded `XoirNodeId` /
 * `XoirSourceRef`. `SemanticCapabilityContract` is meant to be read by
 * `@xo/runtime` off a plain-JSON `properties.semanticCapabilityContract`
 * field in a mounted package's `knowledge_graph.json` (see
 * `contract-embed.ts`) — Runtime has no dependency on `@xo/xoir` (see
 * this package's README / the design report that motivated this split),
 * so nothing in this file may reference an `@xo/xoir` type, even at the
 * type-only level. Only `contract-builder.ts` (which genuinely needs a
 * live `XoirGraph` to build a contract in the first place) imports from
 * `@xo/xoir`; every other module in this package, including this one, is
 * pure data/logic with no XOIR dependency.
 */
export interface ContractSourceRef {
  readonly documentPath: string;
  readonly locator?: string;
  readonly pages?: readonly number[];
  readonly sectionPath?: readonly string[];
}

/**
 * A generic, portable projection of a compiler-discovered XOIR `capability`
 * node (plus whatever reasoning nodes are linked to it) into the shape the
 * Runtime capability-authority layer needs to reason about *whether* an
 * implementation can legitimately be bound — without itself granting any
 * execution authority.
 *
 * This is deliberately NOT `@xo/types`' manifest `CapabilityDeclaration`
 * (a package's own self-reported claim) and NOT `@xo/runtime`'s
 * `RuntimeCapabilityDeclaration` (an explicit grant of native execution
 * authority, made only by whoever embeds the Runtime). It sits strictly
 * between the two: everything here is a faithful, lossless projection of
 * what the compiler actually extracted — nothing is invented, and nothing
 * here implies permission to execute.
 *
 * Every field that isn't directly present on the source XOIR capability
 * node is either omitted (empty array) or copied verbatim from a linked
 * node — this builder never fabricates a value the extractor didn't
 * produce, matching `@xo/compiler`'s own `CapabilitySignature` convention
 * of `'unknown'`-over-guessed.
 */
export interface SemanticCapabilityParameter {
  readonly name: string;
  readonly description: string;
  readonly semanticType?: 'string' | 'number' | 'boolean' | 'unknown';
  readonly required?: boolean;
  readonly derivedFrom?: 'declared' | 'rule_derived' | 'unknown';
}

export type ContractDeterminism = 'deterministic' | 'non_deterministic' | 'unknown';

/**
 * One rule/decision structure linked to the capability (a XOIR
 * `decision_node`, `heuristic`, or `constraint` node reached via an
 * outgoing `REQUIRES` edge from the capability node — see
 * `contract-builder.ts`). Carried verbatim; this contract never
 * paraphrases or reinterprets a rule's condition/action/outcome text.
 */
export interface SemanticCapabilityRule {
  readonly sourceNodeId: string;
  readonly kind: 'decision_node' | 'heuristic' | 'constraint';
  /** The condition/question text (decision_node's `question`, heuristic's `condition`, or constraint's `rule`). */
  readonly condition: string;
  /** The outcome/action text, when the source node has one (decision_node's `outcome`, heuristic's `action`). Absent for a bare `constraint`. */
  readonly outcome?: string;
  /** Carried verbatim from a source `heuristic` node's `exceptionConditions` (decision_node/constraint never have this). A non-empty value here is a real signal to a `BindingResolver` that this rule is not a bare single comparison — see `StructuredComparisonBindingResolver`, which treats any rule with a non-empty `exceptionConditions` as unparseable rather than silently ignoring the exception. */
  readonly exceptionConditions: readonly string[];
  readonly confidence: number;
  /**
   * Phase 2, optional and additive. A deterministic structured projection
   * of `condition` — built by `@xo/compiler` at reasoning-extraction time
   * via `structured-expression-grammar.ts#parseStructuredCondition` and
   * carried through XOIR node properties into this rule by
   * `contract-builder.ts`, completely unchanged in meaning. Absent
   * whenever `condition`'s text does not confidently parse into one of
   * this grammar's closed shapes — see that module's doc comment for the
   * "do not guess" discipline this absence encodes. `condition` itself
   * (the raw text) is always present regardless of whether this field is;
   * this is a strictly additive projection, never a replacement.
   */
  readonly structuredCondition?: StructuredCondition;
  /** Same discipline as {@link structuredCondition}, but for `outcome` (built via `parseStructuredAction`). Absent when `outcome` is absent, or when present but not a recognized `<verb> <target>` imperative shape. */
  readonly structuredAction?: StructuredAction;
  /** Best-effort structured projection of each entry in `exceptionConditions`, in the same order — one entry per raw exception, `condition` present only where that specific exception's text independently parses. This field never affects `StructuredComparisonBindingResolver`'s existing "any exception makes the rule unresolved" gate (§ this file's `exceptionConditions` doc comment) — it exists purely so a *consumer that does understand exceptions* (out of this package's current scope, per the Phase 2 brief) has somewhere to read structured exception data from, without this package inventing execution semantics for it. */
  readonly structuredExceptions?: readonly StructuredExceptionCondition[];
}

/**
 * One linked XOIR `concept` node the compiler itself classified as
 * operational action/process content — `metadata.subtype === 'action'`
 * or `'process'` (see `@xo/compiler`'s `action-process-detector.ts` for
 * how a bare sentence earns that classification, and
 * `xoir/node-kind-mapping.ts` for why it lands on a `concept`-kind node
 * rather than a dedicated XOIR node kind: this milestone does not
 * introduce a new node kind). Reached via the exact same `REQUIRES` edge
 * traversal (either direction, same `linkEdgeKind`) as `rules` — see
 * `BuildContractOptions.linkEdgeKind`'s doc comment in
 * `contract-builder.ts` for why both directions are independently real
 * evidence — never a separate, looser search.
 *
 * This is the sole generic, evidence-based signal a `BindingResolver` may
 * use to decide "this capability is grounded in a real, source-detected
 * operational action" (see `ActionEscalationBindingResolver`). It is
 * deliberately NOT derived from `category`, `name`, or any verb/keyword
 * matched against capability text — that would make binding eligibility
 * depend on marketing-ish free text this package must never pattern-match
 * on for an execution decision. It is derived only from a real graph edge
 * the compiler already materialized for an independent reason (Phase 1
 * same-unit/content-mention linking, or `capability-to-xoir.ts`'s
 * `requiredKnowledgeNodeIds` pass), exactly the same evidence discipline
 * `rules` already uses.
 */
export interface ActionKnowledgeRef {
  readonly sourceNodeId: string;
  /** Carried verbatim from the linked node's `metadata.subtype` — always `'action'` or `'process'` in practice (see this interface's doc comment), but not narrowed to a closed union here: this package reads XOIR's `subtype` as the free-form string it is (per `@xo/xoir`'s own doc comment on `subtype`) rather than asserting a closed set XOIR itself does not enforce. */
  readonly subtype: string;
}

export interface SemanticCapabilityContract {
  /**
   * Reused verbatim from the source XOIR capability node's id — never a
   * freshly minted id — so a contract's identity is exactly as
   * deterministic as `computeCapabilityId` (`@xo/compiler`) already made
   * the capability itself: same source, same contract id, every time.
   */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category?: string;
  readonly inputs: readonly SemanticCapabilityParameter[];
  readonly outputs: readonly SemanticCapabilityParameter[];
  /** Copied from the capability node's `requiredPermissions` property — empty unless the compiler extraction actually populated it (see `@xo/compiler`'s own doc comment: "empty for now — no permission model exists yet" at the extraction layer). This contract never invents a permission requirement the compiler didn't extract; a host is still free to require additional permissions at binding-registration time (see `@xo/runtime`'s `registerResolvedCapabilityBinding`). */
  readonly requiredPermissions: readonly string[];
  readonly determinism: ContractDeterminism;
  /** Every rule/decision node linked to this capability via an outgoing `REQUIRES` edge, in deterministic (sorted-by-id) order. Empty for a capability with no linked reasoning structure — a legitimate, non-error outcome (see `contract-builder.ts`). */
  readonly rules: readonly SemanticCapabilityRule[];
  /** Every linked `concept` node classified as action/process content — see {@link ActionKnowledgeRef}. Deterministic (sorted-by-id) order, same convention as `rules`. Empty for a capability with no such linkage — a legitimate, non-error outcome, exactly like an empty `rules`. Orthogonal to `rules`: a contract can have rules, action refs, both, or neither; nothing in this builder treats them as mutually exclusive. */
  readonly actionKnowledgeRefs: readonly ActionKnowledgeRef[];
  readonly confidence: number;
  readonly sourceRefs: readonly ContractSourceRef[];
  /** Every XOIR node id this contract was projected from — the capability node plus every linked rule node plus every linked action-knowledge node — for provenance chains that need to point back through the contract to XOIR (see `@xo/runtime`'s execution receipt). Plain strings (a XOIR node id's own wire representation), not `@xo/xoir`'s branded `XoirNodeId` — see this file's top doc comment. */
  readonly sourceXoirNodeIds: readonly string[];
  /**
   * P0.9B, optional and additive. `computeContractContentHash(this)`
   * (`contract-hash.ts`) — a hash over this contract's semantic content
   * only (never `id`, `confidence`, `sourceRefs`, `sourceXoirNodeIds`, or
   * this field itself). Set where a contract is embedded into a packaged
   * knowledge graph (`contract-embed.ts`), so a contract read back off an
   * installed package carries its own hash. Absent on a freshly built
   * contract and on any package compiled before P0.9B; every consumer
   * that needs the value recomputes it rather than trusting this field.
   */
  readonly contentHash?: string;
}

// ---------------------------------------------------------------------------
// Binding resolution
// ---------------------------------------------------------------------------

/**
 * What a `BindingResolver` decided about a `SemanticCapabilityContract`.
 * Modeled as a closed union (not a boolean) so "no implementation exists"
 * (`unresolved`), "more than one candidate implementation and no tiebreak"
 * (`ambiguous`), and "an implementation exists but this host/policy refuses
 * to bind it" (`denied`) are three distinct, inspectable outcomes — never
 * collapsed into a single generic failure, and never silently defaulted to
 * `resolved`.
 */
export type BindingOutcome =
  | { readonly status: 'resolved'; readonly binding: CapabilityBinding }
  | { readonly status: 'unresolved'; readonly reason: string }
  | { readonly status: 'ambiguous'; readonly reason: string; readonly candidateCount: number }
  | { readonly status: 'denied'; readonly reason: string };

/**
 * An explicit, inspectable record of *where* a contract's executable
 * implementation comes from. Deliberately data, not just a function — a
 * `CapabilityBinding` can be logged, displayed, and audited before anyone
 * decides to register it as a `RuntimeCapabilityDeclaration`; resolving a
 * binding is not the same act as authorizing it for execution (that
 * authorization only happens if/when a caller registers it against a
 * `RuntimeCapabilityRegistry` — see `@xo/runtime`).
 */
export interface CapabilityBinding {
  readonly id: string;
  readonly contractId: string;
  /**
   * Which class of implementation this binding resolved to.
   * `deterministic_rule` (`StructuredComparisonBindingResolver`) and
   * `human_in_the_loop` (`ActionEscalationBindingResolver`) are the two
   * classes this package's own resolvers implement — both produce a
   * callable `evaluate` (see below). `runtime_registered`, `ai_provider`,
   * and `external_tool` remain named-but-unimplemented extension points
   * the architecture leaves room for, per the brief's §5 ("do not
   * implement all of these now").
   */
  readonly implementationClass: 'deterministic_rule' | 'runtime_registered' | 'ai_provider' | 'external_tool' | 'human_in_the_loop';
  readonly resolverName: string;
  readonly description: string;
  /**
   * The actual callable, present for `implementationClass:
   * 'deterministic_rule'` and `implementationClass: 'human_in_the_loop'`
   * bindings this package resolves itself — a pure, synchronous function
   * over parsed input, never an I/O side effect. For `human_in_the_loop`,
   * "evaluating" the binding never performs (and never claims to
   * perform) the underlying real-world action; it deterministically
   * produces an escalation record describing that a human must act — see
   * `ActionEscalationBindingResolver`'s own doc comment for the full
   * safety-boundary rationale. Absent for binding classes that name an
   * implementation source without this package being the one that
   * invokes it (e.g. `runtime_registered`, where the handler already
   * lives in a `RuntimeCapabilityRegistry` and this binding is only
   * pointing at it by id).
   */
  readonly evaluate?: (input: Readonly<Record<string, unknown>>) => Result_LikeUnknown;
  /** Deterministic, content-derived metadata about *how* `evaluate` was constructed — e.g. which rule nodes and comparison expressions it compiles down to. Never opaque: this is what makes a `deterministic_rule` binding inspectable rather than a black box. */
  readonly derivation: Readonly<Record<string, unknown>>;
}

/**
 * A minimal `{ok, value}` / `{ok, error}` shape, spelled out locally
 * (rather than importing `@xo/types`' `Result`) purely to avoid this
 * synchronous callback type needing a generic error parameter threaded
 * through every call site — the caller (`@xo/runtime`'s
 * `RuntimeCapabilityHandler` wrapper) is what maps this onto the real
 * `Result<unknown, RuntimeError>` the Runtime capability-authority layer
 * requires.
 */
export type Result_LikeUnknown = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

/**
 * One candidate source of implementations. `resolve` is synchronous and
 * pure — no I/O, no randomness, no timestamps — so binding resolution is
 * exactly as deterministic as contract-building itself (brief §10). A
 * resolver that has no opinion about a contract returns `undefined` rather
 * than an `unresolved` outcome, so `resolveCapabilityBinding` can
 * distinguish "this resolver doesn't apply" from "this resolver looked and
 * found nothing."
 */
export interface BindingResolver {
  readonly name: string;
  resolve(contract: SemanticCapabilityContract): BindingOutcome | undefined;
}
