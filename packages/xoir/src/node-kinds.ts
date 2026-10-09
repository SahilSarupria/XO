import type { ContentHash } from '@xo/types';
import type { XoirNodeId } from './ids.js';
import type { NodeVersion } from './versioning.js';
import type { XoirPropertyBag, XoirValue } from './values.js';
import type { XoirConfidence } from './confidence.js';

/**
 * The canonical semantic node taxonomy (see `README.md`'s "Canonical node
 * taxonomy" section and the XOIR/EIR V2 reconciliation report). Each kind
 * answers "what semantic role does this piece of expertise play?" — a
 * *domain* classification (e.g. "this Concept is an organization") is a
 * separate axis, carried on `XoirNodeMetadata.subtype`, not a proliferation
 * of top-level kinds. See §4 of the reconciliation report for the
 * kind/subtype split.
 *
 * Serialized identifiers use this package's existing snake_case convention
 * (matching `capability`, `safety_policy`, etc., which predate this
 * taxonomy and are already canonical as-is — no rename was needed for
 * them).
 */
export type CanonicalXoirNodeKind =
  | 'concept'
  | 'fact'
  | 'heuristic'
  | 'decision_node'
  | 'reasoning_step'
  | 'preference'
  | 'risk_policy'
  | 'escalation_rule'
  | 'failure_case'
  | 'success_pattern'
  | 'capability'
  | 'constraint'
  | 'safety_policy'
  | 'memory_unit'
  | 'evaluation_artifact';

/**
 * Pre-reconciliation node kinds. These are NOT deleted — per the
 * reconciliation report §15/§25, deleting them outright would break
 * `capability`/`constraint`/`safety_policy` (already canonical, still
 * used below) and would discard graphs already serialized against schema
 * version 1 without a migration path. Kinds that already have a 1:1
 * canonical equivalent are commented with that equivalent; kinds that
 * belong to the package/manifest layer instead of semantic XOIR (per the
 * reconciliation report §12/§18–20) map to `undefined` in
 * {@link LEGACY_NODE_KIND_MIGRATION} — callers should stop minting new
 * nodes of those kinds and use the XOIR manifest (`manifest.ts`) instead.
 *
 * @deprecated New code should use {@link CanonicalXoirNodeKind}. These
 * remain valid, loadable, and structurally-validated kinds indefinitely
 * (see `validation.ts`), but `migrateLegacyNodeKind` is how a pass
 * upgrades a legacy-kinded node it encounters.
 */
export type LegacyXoirNodeKind =
  | 'knowledge' // -> 'concept' | 'fact' | 'heuristic', decided by content (no single canonical target)
  | 'reasoning' // -> 'reasoning_step'
  | 'decision' // -> 'decision_node'
  | 'memory' // -> 'memory_unit'
  | 'evaluation' // -> 'evaluation_artifact'
  | 'benchmark' // -> 'evaluation_artifact' (subtype: 'benchmark')
  | 'prompt_strategy' // -> derive from 'reasoning_step'/'preference' subgraphs at packaging time; not a semantic node itself
  | 'case_study' // -> 'failure_case' | 'success_pattern' | 'evaluation_artifact', decided by content
  | 'metadata' // -> XOIR manifest (manifest.ts), not a semantic node
  | 'provenance' // -> XoirNodeMetadata.sourceRefs / provenance union (already first-class per-node/edge, not a separate node kind)
  | 'license' // -> XO package `licensing/license.json` (registry/package layer, out of XOIR's scope — see README "XOIR vs Registry")
  | 'identity' // -> XO package identity/publisher record (registry layer, out of XOIR's scope)
  | 'version'; // -> XOIR manifest `passHistory`/XO package `provenance/version_history.json`, not a semantic node

export type KnownXoirNodeKind = CanonicalXoirNodeKind | LegacyXoirNodeKind;

/**
 * Explicit migration mapping from every legacy kind to its canonical
 * successor, per the reconciliation report §15. `undefined` means the
 * legacy kind doesn't correspond to a *semantic* XOIR node at all — it
 * belongs to the package/manifest/registry layer (see the doc comment on
 * {@link LegacyXoirNodeKind} for exactly where each one now lives).
 * `'knowledge'`, `'case_study'`, and `'benchmark'` have no single
 * unambiguous target (content-dependent), so a caller migrating one of
 * those must inspect `properties`/`subtype` itself — this map only
 * documents the *set* of valid destinations via the comment above; the
 * mapping table below encodes only the unambiguous, mechanical cases.
 */
export const LEGACY_NODE_KIND_MIGRATION: Readonly<Record<LegacyXoirNodeKind, CanonicalXoirNodeKind | undefined>> = {
  knowledge: undefined, // ambiguous — see doc comment; use migrateKnowledgeKind-style content inspection at the call site
  reasoning: 'reasoning_step',
  decision: 'decision_node',
  memory: 'memory_unit',
  evaluation: 'evaluation_artifact',
  benchmark: 'evaluation_artifact',
  prompt_strategy: undefined,
  case_study: undefined, // ambiguous — see doc comment
  metadata: undefined,
  provenance: undefined,
  license: undefined,
  identity: undefined,
  version: undefined,
};

export function isLegacyNodeKind(kind: string): kind is LegacyXoirNodeKind {
  return Object.prototype.hasOwnProperty.call(LEGACY_NODE_KIND_MIGRATION, kind);
}

/** Mechanically migrates a legacy node's `kind`, where the mapping is unambiguous. Returns `undefined` for kinds with no single canonical target (see {@link LEGACY_NODE_KIND_MIGRATION}) or that aren't legacy at all. */
export function migrateLegacyNodeKind(kind: LegacyXoirNodeKind): CanonicalXoirNodeKind | undefined {
  return LEGACY_NODE_KIND_MIGRATION[kind];
}

export type CustomXoirNodeKind = `custom:${string}`;
export type XoirNodeKind = KnownXoirNodeKind | CustomXoirNodeKind;

/**
 * Full provenance for a piece of extracted expertise. `documentPath` is
 * the only field required for backward compatibility with schema-version-1
 * callers that only ever set it; every other field is additive and mirrors
 * Stage 4's `KnowledgeProvenance` shape (`packages/compiler/src/knowledge/types.ts`)
 * so `KnowledgeGraph -> XOIR` (see `@xo/compiler`'s `xoir/` adapters) is a
 * lossless, typed conversion rather than a stringify-and-hope.
 */
export interface XoirSourceRef {
  readonly documentPath: string;
  readonly locator?: string; // e.g. a section heading, line range, or clause id within documentPath
  /** The id of the source-adapter-produced unit this ref traces back to (e.g. Stage 3's Experience Unit id). Opaque to XOIR itself. */
  readonly experienceUnitId?: string;
  readonly pages?: readonly number[];
  readonly sectionPath?: readonly string[];
  readonly charOffsetRange?: readonly [number, number];
  /** This *source's* confidence in the extraction, distinct from the node/edge's own overall `metadata.confidence` (which may combine several sources — see hashing.ts/validation.ts). */
  readonly sourceConfidence?: number;
}

/**
 * Fields every node carries regardless of kind (SPECIFICATION.md's "Every
 * node should have..." list), minus `id`/`kind`/`properties`, which are
 * declared directly on {@link XoirNode} so they stay required and
 * non-optional at the type level.
 */
export interface XoirNodeMetadata {
  /**
   * 0.0–1.0. Kept as the primary, always-present numeric field for
   * backward compatibility (every existing caller of `metadata.confidence`
   * keeps working unchanged) — mirrors `confidenceDetail.score` when
   * `confidenceDetail` is present; see `confidence.ts#scoreOf`.
   */
  readonly confidence: number;
  /** The canonical, semantically-explicit confidence representation (§9 of the reconciliation report). Optional so schema-version-1 data without it remains valid; new writers should always set it. */
  readonly confidenceDetail?: XoirConfidence;
  readonly sourceRefs: readonly XoirSourceRef[];
  readonly tags: readonly string[];
  readonly createdAt: string; // ISO-8601
  readonly updatedAt: string; // ISO-8601
  readonly custom: XoirPropertyBag; // free-form extension point, distinct from `properties` (the node's domain data)
  /**
   * The domain/entity classification within `kind`'s semantic role — e.g.
   * `kind: 'concept', subtype: 'organization'`. This is where Stage 4's
   * richer classification set (organization, technology, metric, event,
   * obligation, ...) lives once converted into XOIR, per the
   * reconciliation report §4. Free-form (not a closed union) on purpose:
   * subtypes are a profession/domain concern, and XOIR's core operations
   * never switch on it.
   */
  readonly subtype?: string;
  /**
   * P0.9A area A (Assertion / Attribution, minimal scope). The stable
   * identifier of the extractor/pass that originally produced this node
   * — e.g. `'structured-operation'` (see `CapabilityExtractor.name` in
   * `@xo/compiler`'s `capabilities/extractor-types.ts` and its
   * implementations), or a knowledge extractor's own equivalent stable
   * name. NOT a log of every pass that later touched the node (that is
   * `pass_history`-shaped bookkeeping, out of scope here) — only who
   * *created* it. Absent when no genuinely identifiable producer exists
   * (e.g. hand-built XOIR in tests) rather than fabricated. Deliberately
   * separate from `sourceRefs` (evidence/location) and
   * `confidence`/`confidenceDetail` (evidence basis/strength) — this
   * field answers "who made this claim", not "where" or "how sure".
   * Included in this node's content hash (`hashing.ts#hashNode`) — like
   * `subtype`, this is a permanent fact about the node set once at
   * creation, not a mutable lifecycle field.
   */
  readonly producedBy?: string;
  /**
   * P0.9A area A (Assertion / Attribution, minimal scope). The semantic
   * review lifecycle of this claim, independent of `confidence` (which
   * describes evidence strength, not human sign-off) and independent of
   * the runtime's execution-time `human_in_the_loop` approval (which
   * approves a *workflow step running*, never a semantic claim — no code
   * path in this milestone sets this field from that mechanism). Absent
   * is the backward-compatible equivalent of `'unreviewed'`: every graph
   * produced before this field existed, and every graph where no review
   * has ever happened, is correctly read as unreviewed without a
   * migration. No API to transition a node to `'human_confirmed'` exists
   * yet (deferred to a later milestone) — this field is only the
   * representation a future review workflow will need.
   * Deliberately EXCLUDED from this node's content hash
   * (`hashing.ts#hashNode`), unlike `producedBy`: a future review action
   * is expected to set this field on an *existing* node without forking
   * its identity, the same reasoning `hashNode`'s doc comment already
   * gives for excluding `updatedAt`.
   */
  readonly reviewStatus?: 'unreviewed' | 'human_confirmed';
}

/**
 * A XOIR node. Immutable by convention — every field is `readonly`, and
 * every operation that "changes" a node (see graph.ts, pass.ts) produces a
 * new object rather than mutating this one in place, so a node reference
 * held by one pass is never silently rewritten by another.
 *
 * `hash` is a derived field (see hashing.ts's `hashNode`), included here
 * because SPECIFICATION.md's node model requires every node to *carry* its
 * hash, not just be hashable on demand — callers can compare `node.hash`
 * without recomputing it, and `validation.ts` checks that the carried hash
 * still matches a fresh computation.
 */
export interface XoirNode<K extends XoirNodeKind = XoirNodeKind, P extends XoirPropertyBag = XoirPropertyBag> {
  readonly id: XoirNodeId;
  readonly kind: K;
  readonly properties: P;
  readonly metadata: XoirNodeMetadata;
  readonly version: NodeVersion;
  readonly hash: ContentHash;
}

// --- Per-kind property shapes -------------------------------------------------
// These are the "at minimum include" node types from the module spec. Each
// is deliberately small: XOIR carries structured, typed domain data, not a
// generic bag — richer per-kind shapes are additive extensions a future
// module can widen without breaking existing graphs (adding an optional
// field is backward compatible; the schema-version machinery in
// versioning.ts exists for the rare case a change isn't).

// --- Capability Signature (absorbed from Stage 5's `CapabilitySignature`) -----
// Preserved verbatim in spirit from `packages/compiler/src/capabilities/types.ts`:
// every field an extractor can't honestly infer from text alone is `'unknown'`
// (or an empty array) rather than a guessed value. See the reconciliation
// report §5.

export type XoirDeterminism = 'deterministic' | 'non_deterministic' | 'unknown';
export type XoirExecutionMode = 'sync' | 'async' | 'unknown';
export type XoirCostEstimate = 'low' | 'medium' | 'high' | 'unknown';

export interface CapabilityNodeProps extends XoirPropertyBag {
  readonly name: string;
  readonly description: string;
  readonly inputSchemaRef?: string;
  readonly outputSchemaRef?: string;
  readonly category?: string;
  /** JSON-encodable per §5's `inputs`/`outputs` — kept as a plain string array (name/description pairs flattened to `"name: description"`) since `XoirPropertyBag` values must be `XoirValue`-shaped; richer structure belongs in a future typed extension. */
  readonly inputs?: readonly string[];
  readonly outputs?: readonly string[];
  /**
   * P0.9A area B (Semantic I/O independence): this is that "future typed
   * extension" the `inputs`/`outputs` doc comment above anticipated —
   * additive, not a replacement. Genuine structured type info for a
   * subset of `inputs`' names (e.g. `{amount: "number"}`), populated
   * only when a real structured/OpenAPI source declared it (see
   * `@xo/compiler`'s `structured-operation-extractor.ts`); absent for
   * ordinary prose/PDF-derived capabilities rather than guessed.
   * `outputs` deliberately has no equivalent field yet — see the
   * `inputTypes` doc comment in `@xo/compiler`'s `capabilities/types.ts`
   * for why this pass scoped itself to inputs only.
   */
  readonly inputTypes?: Readonly<Record<string, string>>;
  readonly sideEffects?: readonly string[];
  readonly requiredResources?: readonly string[];
  readonly determinism?: XoirDeterminism;
  readonly idempotent?: boolean | 'unknown';
  readonly executionMode?: XoirExecutionMode;
  readonly estimatedCost?: XoirCostEstimate;
  readonly requiredPermissions?: readonly string[];
  readonly invocationHints?: readonly string[];
  /** Other Capability node ids this one depends on. The canonical way to express this is a `requires`/`REQUIRES` edge (graph.ts#dependenciesOf) — this property is a convenience mirror for callers reading a single node in isolation, and adapters MUST keep it consistent with the actual edges they emit. */
  readonly dependencies?: readonly string[];
  /**
   * A plain-JSON projection of this capability (plus any linked
   * decision_node/heuristic/constraint rule nodes) into a
   * `@xo/capability-contract` `SemanticCapabilityContract`, embedded by
   * `@xo/compiler` at compile time. Deliberately typed as a loose
   * `Record<string, XoirValue>` here rather than importing
   * `SemanticCapabilityContract` from `@xo/capability-contract` —
   * `@xo/xoir` must not depend on `@xo/capability-contract` (that package
   * already depends on `@xo/xoir`; a cycle would follow). This is a plain
   * data field: `xoir-to-package.ts` (Packager) already copies
   * `node.properties` through untouched (`serializeNode`'s
   * `properties: node.properties`), so adding this field required no
   * change there, and it rides through into a package's
   * `knowledge_graph.json` for free. Optional and additive — a
   * capability node with no discovered/embeddable contract simply omits
   * it, same as any other optional `CapabilityNodeProps` field.
   */
  readonly semanticCapabilityContract?: Readonly<Record<string, XoirValue>>;
}

export interface ConceptNodeProps extends XoirPropertyBag {
  readonly definition: string;
  readonly aliases?: readonly string[];
  readonly ontologyPosition?: string;
}

export interface FactNodeProps extends XoirPropertyBag {
  readonly statement: string;
  readonly domain: string;
  readonly sourceStrength?: 'weak' | 'moderate' | 'strong';
}

export interface HeuristicNodeProps extends XoirPropertyBag {
  readonly condition: string;
  readonly action: string;
  readonly exceptionConditions?: readonly string[];
  /** Phase 2, optional and additive — a deterministic structured projection of `condition`/`action`, built by `@xo/compiler`'s reasoning extraction (`structured-semantics.ts`) via `@xo/capability-contract`'s `structured-expression-grammar.ts`. Plain JSON-shaped data (never a class instance), consistent with every other `XoirValue`-typed property on this bag. Absent whenever the source text does not confidently parse into one of that grammar's closed shapes — see its doc comment. */
  readonly structuredCondition?: Readonly<Record<string, XoirValue>>;
  readonly structuredAction?: Readonly<Record<string, XoirValue>>;
  readonly structuredExceptions?: readonly Readonly<Record<string, XoirValue>>[];
}

export interface DecisionNodeNodeProps extends XoirPropertyBag {
  readonly question: string;
  readonly outcome: string;
  readonly rationale: string;
  /** Phase 2, optional and additive — see {@link HeuristicNodeProps.structuredCondition}. Here `structuredCondition` projects `question` and `structuredAction` projects `outcome`. */
  readonly structuredCondition?: Readonly<Record<string, XoirValue>>;
  readonly structuredAction?: Readonly<Record<string, XoirValue>>;
}

export interface ReasoningStepNodeProps extends XoirPropertyBag {
  readonly premise: string;
  readonly conclusion: string;
  readonly justification?: string;
  /** Other ReasoningStep node ids this step depends on — mirror of a `requires`/`REQUIRES` edge, same caveat as `CapabilityNodeProps.dependencies`. */
  readonly dependsOn?: readonly string[];
}

export interface PreferenceNodeProps extends XoirPropertyBag {
  readonly dimension: string;
  readonly value: string;
  readonly strength?: 'weak' | 'moderate' | 'strong';
}

export interface RiskPolicyNodeProps extends XoirPropertyBag {
  readonly domain: string;
  readonly toleranceLevel: string;
  readonly overrideConditions?: readonly string[];
}

export interface EscalationRuleNodeProps extends XoirPropertyBag {
  readonly triggerCondition: string;
  readonly escalationTarget: string;
}

export interface FailureCaseNodeProps extends XoirPropertyBag {
  readonly scenario: string;
  readonly rootCause: string;
  readonly correctivePattern?: string;
}

export interface SuccessPatternNodeProps extends XoirPropertyBag {
  readonly scenario: string;
  readonly contributingFactors?: readonly string[];
}

export interface ConstraintNodeProps extends XoirPropertyBag {
  readonly rule: string;
  readonly severity: 'info' | 'warning' | 'blocking';
  /** Phase 2, optional and additive — see {@link HeuristicNodeProps.structuredCondition}. Here `structuredCondition` projects `rule` (a `constraint` node has no separate action/outcome slot — see `reasoning-to-xoir.ts`). */
  readonly structuredCondition?: Readonly<Record<string, XoirValue>>;
}

export interface SafetyPolicyNodeProps extends XoirPropertyBag {
  readonly policy: string;
  readonly trigger: string;
  readonly action: 'allow' | 'block' | 'redact';
  readonly enforcementLevel?: string;
}

export interface MemoryUnitNodeProps extends XoirPropertyBag {
  readonly content: string;
  readonly scope: 'short_term' | 'long_term';
  readonly decayPolicy?: string;
}

export interface EvaluationArtifactNodeProps extends XoirPropertyBag {
  readonly input: string;
  readonly expectedBehavior: string;
  readonly difficulty?: string;
}

// --- Legacy node property shapes (retained; see LegacyXoirNodeKind) ----------

export interface KnowledgeNodeProps extends XoirPropertyBag {
  readonly statement: string;
  readonly domain: string;
}

export interface ReasoningNodeProps extends XoirPropertyBag {
  readonly premise: string;
  readonly conclusion: string;
}

export interface MemoryNodeProps extends XoirPropertyBag {
  readonly content: string;
  readonly scope: 'short_term' | 'long_term';
}

export interface EvaluationNodeProps extends XoirPropertyBag {
  readonly criterion: string;
  readonly method: string;
}

export interface BenchmarkNodeProps extends XoirPropertyBag {
  readonly category: string;
  readonly metric: string;
}

export interface PromptStrategyNodeProps extends XoirPropertyBag {
  readonly role: string;
  readonly template: string;
}

export interface CaseStudyNodeProps extends XoirPropertyBag {
  readonly scenario: string;
  readonly outcome: string;
}

export interface MetadataNodeProps extends XoirPropertyBag {
  readonly key: string;
  readonly value: string;
}

export interface ProvenanceNodeProps extends XoirPropertyBag {
  readonly contributor: string;
  readonly role: string;
}

export interface LicenseNodeProps extends XoirPropertyBag {
  readonly tier: string;
  readonly royaltyBasisPoints: number;
}

export interface IdentityNodeProps extends XoirPropertyBag {
  readonly did: string;
  readonly role: string;
}

export interface VersionNodeProps extends XoirPropertyBag {
  readonly semver: string;
  readonly changelog: string;
}

/** Maps each known kind to its property shape, for callers that want a precisely-typed node (`XoirNode<'capability', CapabilityNodeProps>`) via {@link TypedXoirNode}. */
export interface KnownNodePropsByKind {
  // Canonical
  readonly concept: ConceptNodeProps;
  readonly fact: FactNodeProps;
  readonly heuristic: HeuristicNodeProps;
  readonly decision_node: DecisionNodeNodeProps;
  readonly reasoning_step: ReasoningStepNodeProps;
  readonly preference: PreferenceNodeProps;
  readonly risk_policy: RiskPolicyNodeProps;
  readonly escalation_rule: EscalationRuleNodeProps;
  readonly failure_case: FailureCaseNodeProps;
  readonly success_pattern: SuccessPatternNodeProps;
  readonly capability: CapabilityNodeProps;
  readonly constraint: ConstraintNodeProps;
  readonly safety_policy: SafetyPolicyNodeProps;
  readonly memory_unit: MemoryUnitNodeProps;
  readonly evaluation_artifact: EvaluationArtifactNodeProps;
  // Legacy
  readonly knowledge: KnowledgeNodeProps;
  readonly reasoning: ReasoningNodeProps;
  readonly decision: DecisionNodeNodeProps;
  readonly memory: MemoryNodeProps;
  readonly evaluation: EvaluationNodeProps;
  readonly benchmark: BenchmarkNodeProps;
  readonly prompt_strategy: PromptStrategyNodeProps;
  readonly case_study: CaseStudyNodeProps;
  readonly metadata: MetadataNodeProps;
  readonly provenance: ProvenanceNodeProps;
  readonly license: LicenseNodeProps;
  readonly identity: IdentityNodeProps;
  readonly version: VersionNodeProps;
}

export type TypedXoirNode<K extends KnownXoirNodeKind> = XoirNode<K, KnownNodePropsByKind[K]>;

export interface CreateNodeInput<K extends XoirNodeKind, P extends XoirPropertyBag> {
  readonly id: XoirNodeId;
  readonly kind: K;
  readonly properties: P;
  readonly confidence?: number;
  /** The canonical confidence representation. When provided without `confidence`, `metadata.confidence` defaults to `confidenceDetail.score` (see `confidence.ts#scoreOf`) so the two never silently disagree. */
  readonly confidenceDetail?: XoirConfidence;
  readonly sourceRefs?: readonly XoirSourceRef[];
  readonly tags?: readonly string[];
  readonly custom?: XoirPropertyBag;
  readonly subtype?: string;
  readonly version?: NodeVersion;
  readonly now?: () => string;
  /** P0.9A area A: see `XoirNodeMetadata.producedBy`'s doc comment. */
  readonly producedBy?: string;
  /** P0.9A area A: see `XoirNodeMetadata.reviewStatus`'s doc comment. Never set by this constructor on its own initiative — callers pass it explicitly, and its absence (the default) is unreviewed. */
  readonly reviewStatus?: 'unreviewed' | 'human_confirmed';
}

/**
 * Builds a node with its metadata defaults filled in. Does NOT compute
 * `hash` — that's `hashing.ts#hashNode`'s job, since hashing needs to see
 * the fully-assembled node (hashing a node while building it would hash a
 * moving target). `graph.ts#XoirGraph.addNode` is the one call site that
 * chains `createNode` -> `hashNode` -> stores the result, so a node never
 * exists inside a graph without a hash.
 */
export function createNode<K extends XoirNodeKind, P extends XoirPropertyBag>(
  input: CreateNodeInput<K, P>,
): Omit<XoirNode<K, P>, 'hash'> {
  const now = input.now ?? (() => new Date().toISOString());
  const timestamp = now();
  const confidence = input.confidence ?? input.confidenceDetail?.score ?? 1;
  return {
    id: input.id,
    kind: input.kind,
    properties: input.properties,
    version: input.version ?? 1,
    metadata: {
      confidence,
      ...(input.confidenceDetail ? { confidenceDetail: input.confidenceDetail } : {}),
      sourceRefs: input.sourceRefs ?? [],
      tags: input.tags ?? [],
      createdAt: timestamp,
      updatedAt: timestamp,
      custom: input.custom ?? {},
      ...(input.subtype !== undefined ? { subtype: input.subtype } : {}),
      ...(input.producedBy !== undefined ? { producedBy: input.producedBy } : {}),
      ...(input.reviewStatus !== undefined ? { reviewStatus: input.reviewStatus } : {}),
    },
  };
}