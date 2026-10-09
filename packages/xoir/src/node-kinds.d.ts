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
export type CanonicalXoirNodeKind = 'concept' | 'fact' | 'heuristic' | 'decision_node' | 'reasoning_step' | 'preference' | 'risk_policy' | 'escalation_rule' | 'failure_case' | 'success_pattern' | 'capability' | 'constraint' | 'safety_policy' | 'memory_unit' | 'evaluation_artifact';
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
export type LegacyXoirNodeKind = 'knowledge' | 'reasoning' | 'decision' | 'memory' | 'evaluation' | 'benchmark' | 'prompt_strategy' | 'case_study' | 'metadata' | 'provenance' | 'license' | 'identity' | 'version';
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
export declare const LEGACY_NODE_KIND_MIGRATION: Readonly<Record<LegacyXoirNodeKind, CanonicalXoirNodeKind | undefined>>;
export declare function isLegacyNodeKind(kind: string): kind is LegacyXoirNodeKind;
/** Mechanically migrates a legacy node's `kind`, where the mapping is unambiguous. Returns `undefined` for kinds with no single canonical target (see {@link LEGACY_NODE_KIND_MIGRATION}) or that aren't legacy at all. */
export declare function migrateLegacyNodeKind(kind: LegacyXoirNodeKind): CanonicalXoirNodeKind | undefined;
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
    readonly locator?: string;
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
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly custom: XoirPropertyBag;
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
}
/**
 * Builds a node with its metadata defaults filled in. Does NOT compute
 * `hash` — that's `hashing.ts#hashNode`'s job, since hashing needs to see
 * the fully-assembled node (hashing a node while building it would hash a
 * moving target). `graph.ts#XoirGraph.addNode` is the one call site that
 * chains `createNode` -> `hashNode` -> stores the result, so a node never
 * exists inside a graph without a hash.
 */
export declare function createNode<K extends XoirNodeKind, P extends XoirPropertyBag>(input: CreateNodeInput<K, P>): Omit<XoirNode<K, P>, 'hash'>;
//# sourceMappingURL=node-kinds.d.ts.map