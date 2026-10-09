import type { XoirEdge, XoirGraph, XoirNode, XoirNodeId } from '@xo/xoir';
import { nodesOfKind } from '@xo/xoir';

/**
 * The XOIR -> XO-package lowering (`EXPERIENCE_COMPILER.md` §9's
 * Packager, the one stage with any knowledge of `SPECIFICATION.md`'s
 * package format). This module does the actual lowering as pure,
 * dependency-free functions over a `XoirGraph`; `../pipeline/packager.ts`
 * is what wires the result into a real signed `.xo` archive via
 * `@xo/package-sdk`.
 *
 * The mapping deliberately does not introduce a new `ComponentKind` —
 * every one of `SPECIFICATION.md`'s existing 10 component kinds already
 * has a legitimate XOIR source, or (for `capability` nodes, which have no
 * dedicated `capabilities.json` slot) folds into the closest existing one
 * as honestly-typed data. This module itself never elevates a `capability`
 * node into a manifest-level `CapabilityDeclaration` — that lowering
 * decision requires resolving an executable binding, which needs
 * `@xo/capability-contract`'s contract/binding machinery, not just a
 * structural XOIR -> JSON projection. See `../pipeline/capability-lowering.ts`
 * (invoked from `../pipeline/packager.ts`, alongside this module, not
 * inside it) for where that actually happens: every `capability` node
 * still lands here, verbatim, as knowledge-graph data — a resolved subset
 * of the same nodes *additionally* appears in `manifest.capabilities`,
 * produced by that sibling module, not this one.
 *
 * Two components this pipeline is architecturally unable to populate
 * today are `prompt_strategies` (no Prompt Optimization pass exists —
 * `EXPERIENCE_COMPILER.md` §4.2's "Prompt Optimization" transform pass is
 * not implemented anywhere in this codebase) and any real content for
 * `benchmark_suite` beyond its required-but-honestly-empty shape (no
 * Benchmark Synthesizer — §7 — exists either, and no extractor in this
 * codebase ever emits an `evaluation_artifact` node, so there is nothing
 * to lower). Neither is faked: `buildBenchmarkSuiteComponent` below
 * returns a structurally valid, zero-item suite and says so in its own
 * `note` field; `prompt_strategies` is simply never produced by
 * `packager.ts` at all.
 */

// ---------------------------------------------------------------------------
// Shared node/edge serialization — deterministic, provenance-preserving
// ---------------------------------------------------------------------------

/** The common shape every serialized node carries, regardless of which component file it ends up in — full provenance/confidence preserved, never summarized away (mirrors `EXPERIENCE_COMPILER.md` §2.3's "provenance is never summarized" principle, applied one layer down at packaging time). */
export interface SerializedXoirNode {
  readonly id: string;
  readonly kind: string;
  readonly subtype?: string;
  readonly properties: XoirNode['properties'];
  readonly confidence: number;
  readonly confidenceDetail?: XoirNode['metadata']['confidenceDetail'];
  readonly sourceRefs: XoirNode['metadata']['sourceRefs'];
  readonly tags: readonly string[];
}

export interface SerializedXoirEdge {
  readonly id: string;
  readonly kind: string;
  readonly from: string;
  readonly to: string;
  /** True when `to` (or `from`, for an inbound-only edge) resolves to a node that was serialized into a *different* component file — see this module's doc comment on cross-component edges. A reader following an `external` edge needs to look in a sibling component, not this one, to find the other endpoint's full node record. */
  readonly external: boolean;
  readonly confidence: number;
  readonly sourceRefs: XoirEdge['metadata']['sourceRefs'];
}

function serializeNode(node: XoirNode): SerializedXoirNode {
  return {
    id: node.id,
    kind: node.kind,
    ...(node.metadata.subtype !== undefined ? { subtype: node.metadata.subtype } : {}),
    properties: node.properties,
    confidence: node.metadata.confidence,
    ...(node.metadata.confidenceDetail !== undefined ? { confidenceDetail: node.metadata.confidenceDetail } : {}),
    sourceRefs: node.metadata.sourceRefs,
    tags: node.metadata.tags,
  };
}

function byId(a: { readonly id: string }, b: { readonly id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Every edge touching at least one node in `nodeIdsInThisComponent`,
 * sorted deterministically. Cross-component edges (one endpoint outside
 * this component) are included and flagged `external: true` rather than
 * dropped — see the module doc comment's "cross-component edges"
 * paragraph. This means a genuinely cross-cutting edge is duplicated
 * across the two components it touches; that is a deliberate, documented
 * trade-off (no data loss, no new component kind to hold a
 * "cross-references" file) rather than an oversight.
 */
function edgesTouching(allEdges: readonly XoirEdge[], nodeIdsInThisComponent: ReadonlySet<XoirNodeId>): readonly SerializedXoirEdge[] {
  const touching = allEdges.filter((e) => nodeIdsInThisComponent.has(e.fromId) || nodeIdsInThisComponent.has(e.toId));
  return touching
    .map((e) => ({
      id: e.id,
      kind: e.kind,
      from: e.fromId,
      to: e.toId,
      external: !(nodeIdsInThisComponent.has(e.fromId) && nodeIdsInThisComponent.has(e.toId)),
      confidence: e.metadata.confidence,
      sourceRefs: e.metadata.sourceRefs,
    }))
    .sort(byId);
}

function nodeIdSet(nodes: readonly XoirNode[]): ReadonlySet<XoirNodeId> {
  return new Set(nodes.map((n) => n.id));
}

// ---------------------------------------------------------------------------
// knowledge/graph.json  <-  concept, fact, heuristic, preference, capability
// ---------------------------------------------------------------------------

export interface KnowledgeGraphComponent {
  readonly nodes: readonly SerializedXoirNode[];
  readonly edges: readonly SerializedXoirEdge[];
}

const KNOWLEDGE_GRAPH_KINDS = ['concept', 'fact', 'heuristic', 'preference', 'capability'] as const;

/**
 * `SPECIFICATION.md`'s `knowledge/graph.json` example shape (`{id, type,
 * label}` nodes + `{from, to, relation}` edges) is illustrative, not a
 * closed schema `PackageValidator` enforces (confirmed by reading
 * `package-validator.ts` — it validates manifest/hash/signature
 * structure, never component *content* shape). This serializer is
 * deliberately richer than that minimal example: it carries full
 * confidence/provenance rather than collapsing to a bare label, which is
 * what "preserve provenance/confidence" requires.
 *
 * `capability` nodes are included here as data unconditionally — see this
 * module's top doc comment for where a *resolved subset* of them
 * additionally becomes a manifest-level `CapabilityDeclaration` (not this
 * function's concern).
 */
export function buildKnowledgeGraphComponent(graph: XoirGraph): KnowledgeGraphComponent | undefined {
  const nodes = KNOWLEDGE_GRAPH_KINDS.flatMap((kind) => nodesOfKind(graph, kind));
  if (nodes.length === 0) return undefined;
  const sortedNodes = [...nodes].sort(byId).map(serializeNode);
  const edges = edgesTouching(graph.allEdges(), nodeIdSet(nodes));
  return { nodes: sortedNodes, edges };
}

// ---------------------------------------------------------------------------
// reasoning/decision_trees.json  <-  decision_node
// ---------------------------------------------------------------------------

export interface DecisionTreesComponent {
  readonly nodes: readonly SerializedXoirNode[];
  readonly edges: readonly SerializedXoirEdge[];
}

/** 1:1 with `EXPERIENCE_COMPILER.md` §9.1's table: `reasoning/decision_trees.json` <- Decision Graph view. Returns `undefined` (component omitted entirely) rather than an empty file when there is genuinely nothing to lower — `decision_trees` is `required: false`, so omission is the honest, spec-conformant choice for "this XO's compiled content has no decision structure," distinct from `benchmark_suite`'s honestly-empty-but-present shape (`required: true` there, so it can't simply be absent). */
export function buildDecisionTreesComponent(graph: XoirGraph): DecisionTreesComponent | undefined {
  const nodes = nodesOfKind(graph, 'decision_node');
  if (nodes.length === 0) return undefined;
  const sortedNodes = [...nodes].sort(byId).map(serializeNode);
  const edges = edgesTouching(graph.allEdges(), nodeIdSet(nodes));
  return { nodes: sortedNodes, edges };
}

// ---------------------------------------------------------------------------
// reasoning/reasoning_traces.jsonl  <-  reasoning_step
// ---------------------------------------------------------------------------

/** One JSONL line per trace, matching `SPECIFICATION.md` §1.1's "one trace per line, streamable" format note. `undefined` (component omitted) when there are no `reasoning_step` nodes, same reasoning as `buildDecisionTreesComponent`. */
export function buildReasoningTracesComponent(graph: XoirGraph): string | undefined {
  const nodes = nodesOfKind(graph, 'reasoning_step');
  if (nodes.length === 0) return undefined;
  const sorted = [...nodes].sort(byId);
  return sorted.map((n) => JSON.stringify(serializeNode(n))).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// reasoning/case_library.json  <-  failure_case, success_pattern
// ---------------------------------------------------------------------------

export interface CaseLibraryComponent {
  readonly nodes: readonly SerializedXoirNode[];
}

/** No extractor in this codebase currently emits `failure_case`/`success_pattern` nodes (confirmed by reading every `*-to-xoir.ts` mapping table), so this returns `undefined` for every real compilation today — included for forward compatibility with the day an extractor does produce these, not dead code: `case_library` is `required: false`, so an always-omitted-today component is the correct, non-fabricating behavior rather than shipping a permanently-empty file. */
export function buildCaseLibraryComponent(graph: XoirGraph): CaseLibraryComponent | undefined {
  const nodes = [...nodesOfKind(graph, 'failure_case'), ...nodesOfKind(graph, 'success_pattern')];
  if (nodes.length === 0) return undefined;
  return { nodes: [...nodes].sort(byId).map(serializeNode) };
}

// ---------------------------------------------------------------------------
// memory/long_term_graph.json  <-  memory_unit
// ---------------------------------------------------------------------------

export interface LongTermMemoryGraphComponent {
  readonly nodes: readonly SerializedXoirNode[];
}

/** Same "no producer exists yet, so omit rather than fabricate" reasoning as `buildCaseLibraryComponent` — no extractor emits `memory_unit` nodes today. */
export function buildLongTermMemoryGraphComponent(graph: XoirGraph): LongTermMemoryGraphComponent | undefined {
  const nodes = nodesOfKind(graph, 'memory_unit');
  if (nodes.length === 0) return undefined;
  return { nodes: [...nodes].sort(byId).map(serializeNode) };
}

// ---------------------------------------------------------------------------
// safety/rules.json  <-  constraint, safety_policy, risk_policy, escalation_rule
// ---------------------------------------------------------------------------

export interface SafetyRulesComponent {
  readonly nodes: readonly SerializedXoirNode[];
  readonly edges: readonly SerializedXoirEdge[];
}

const SAFETY_RULE_KINDS = ['constraint', 'safety_policy', 'risk_policy', 'escalation_rule'] as const;

/**
 * `safety_rules` is `required: true` per `SPECIFICATION.md`'s baseline
 * policy, so unlike the optional components above this always returns a
 * (possibly empty-nodes) component rather than `undefined` — a Runtime
 * negotiating this XO needs the component to exist to satisfy the
 * required-component check (`XO_PROTOCOL.md` §10.3), even if this
 * particular compiled document happened to yield zero safety-relevant
 * nodes. In practice, real documents compiled by this pipeline do
 * currently produce `constraint` nodes (Stage 4/7's obligation/exception/
 * prohibition/policy extraction all map here — see
 * `node-kind-mapping.ts`/`reasoning-node-kind-mapping.ts`), so this is
 * rarely actually empty; `safety_policy` is included in the source-kind
 * list for forward compatibility even though no current extractor emits
 * it.
 */
export function buildSafetyRulesComponent(graph: XoirGraph): SafetyRulesComponent {
  const nodes = SAFETY_RULE_KINDS.flatMap((kind) => nodesOfKind(graph, kind));
  const sortedNodes = [...nodes].sort(byId).map(serializeNode);
  const edges = edgesTouching(graph.allEdges(), nodeIdSet(nodes));
  return { nodes: sortedNodes, edges };
}

// ---------------------------------------------------------------------------
// evaluation/benchmark_suite.json  <-  evaluation_artifact
// ---------------------------------------------------------------------------

export interface BenchmarkSuiteComponent {
  readonly categories: readonly { readonly name: string; readonly items: readonly SerializedXoirNode[] }[];
  readonly totalItems: number;
  /** Present, and only present, when this suite has zero items — an honest statement of *why*, not a fabricated score. Absent once a real Benchmark Synthesizer (`EXPERIENCE_COMPILER.md` §7) exists and this stops being universally true. */
  readonly note?: string;
}

/**
 * `required: true`, same as `safety_rules`, so this always returns a
 * component — but per this module's top doc comment, no Benchmark
 * Synthesizer exists in this codebase and no extractor ever emits an
 * `evaluation_artifact` node, so `categories`/`totalItems` are honestly
 * `[]`/`0` for every real compilation today. This is the direct
 * implementation of "do not implement benchmark synthesis beyond what
 * the current architecture actually supports, do not fabricate": the
 * component exists (satisfying the required-component structural
 * contract), its content does not lie about what was measured.
 */
export function buildBenchmarkSuiteComponent(graph: XoirGraph): BenchmarkSuiteComponent {
  const items = nodesOfKind(graph, 'evaluation_artifact');
  if (items.length === 0) {
    return { categories: [], totalItems: 0, note: 'No evaluation_artifact nodes present — this pipeline has no Benchmark Synthesizer (EXPERIENCE_COMPILER.md §7) yet, so no benchmark items were generated. This is an honestly-empty suite, not a placeholder score.' };
  }
  const sorted = [...items].sort(byId).map(serializeNode);
  return { categories: [{ name: 'generated', items: sorted }], totalItems: sorted.length };
}
