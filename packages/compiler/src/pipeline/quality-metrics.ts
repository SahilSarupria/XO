import type { XoirGraph } from '@xo/xoir';
import { lowerCapabilitiesToManifest, type LowerCapabilitiesResult } from './capability-lowering.js';

/**
 * A confidence at or above this line counts as "high confidence" for
 * `SemanticQualityReport.highConfidenceCapabilities`. Not a resolution
 * threshold — `@xo/capability-contract`'s binding resolution is
 * completely independent of this number and is never influenced by it
 * (see `capability-lowering.ts`'s own doc comment on that boundary).
 * Chosen because it is the same value `rule-based-extractor.ts` already
 * assigns to a *true* imperative sentence match (`wordIndex === 0`) —
 * i.e. "high confidence" here means "at least as strong as this
 * package's own best non-command-snippet extraction signal," not an
 * arbitrarily chosen round number.
 */
const HIGH_CONFIDENCE_THRESHOLD = 0.6;

const REASONING_KINDS = new Set(['reasoning_step', 'decision_node', 'heuristic', 'escalation_rule', 'risk_policy']);

export interface SemanticQualityReport {
  /** Every XOIR node in the graph, of any kind — `graph.stats().nodeCount`, reused verbatim, never recomputed. */
  readonly totalSemanticNodes: number;
  /** `graph.stats().nodesByKind`, reused verbatim. */
  readonly nodesByKind: Readonly<Record<string, number>>;
  readonly capabilitiesDiscovered: number;
  readonly highConfidenceCapabilities: number;
  readonly lowConfidenceCapabilities: number;
  /** `decision_node` + `heuristic` + `reasoning_step` + `escalation_rule` + `risk_policy` node counts combined — every canonical XOIR kind Stage 7's reasoning extraction can produce (`reasoning-node-kind-mapping.ts`). */
  readonly reasoningNodes: number;
  readonly constraintNodes: number;
  readonly decisionNodes: number;
  /** From `lowerCapabilitiesToManifest` — present only when `capabilities` was supplied to `computeSemanticQualityReport` (it requires re-running binding resolution, which this module never does implicitly/for free, per `capability-lowering.ts`'s own determinism and "never invented beyond what's asked for" conventions). */
  readonly resolvedCapabilities?: number;
  readonly unresolvedCapabilities?: number;
  readonly ambiguousCapabilities?: number;
  readonly deniedCapabilities?: number;
  /** Fraction (0-1) of all XOIR nodes carrying at least one `sourceRef` — i.e. traceable back to a specific span of source material, not asserted with no provenance. `1` for an empty graph (vacuously true), never `NaN`. */
  readonly provenanceCoverage: number;
  /** Every `REQUIRES` edge `reasoning-to-xoir.ts#linkReferencedNodes` added to/from a `capability`/`concept` node — i.e. every semantic link `semantic-link.ts` found sufficient evidence for, of any tier (including {@link structuralLinks}). Reuses `graph.allEdges()`, never a separate link store. */
  readonly semanticLinks: number;
  /** The `exact_label` tier — see `semantic-link.ts`. A subset of `semanticLinks`. */
  readonly highConfidenceLinks: number;
  /** The `same_unit_term_overlap` tier — see `semantic-link.ts`. A subset of `semanticLinks`, disjoint from `highConfidenceLinks`. */
  readonly mediumConfidenceLinks: number;
  /** The `rule_capability_derivation` tier (M1.1) — a minted rule-level capability's single, deterministic edge back to its own originating rule (`rule-capability-linking.ts#linkMintedRuleCapabilities`), never a heuristic text-overlap guess. A subset of `semanticLinks`, disjoint from both other tiers — `semanticLinks === highConfidenceLinks + mediumConfidenceLinks + structuralLinks` always holds. */
  readonly structuralLinks: number;
}

/**
 * Composes existing infrastructure — `XoirGraph.stats()` (structural
 * counts) and, optionally, an already-computed `LowerCapabilitiesResult`
 * (`capability-lowering.ts`'s resolved/unresolved/ambiguous/denied
 * breakdown) — into one report a caller (a CLI command, this
 * repository's own quality benchmark, a future dashboard) can render
 * without re-deriving any of it itself. Deliberately not a second
 * analytics system: every number here is either read straight off
 * `graph.stats()` or computed by one pass over `graph.allNodes()` using
 * only `metadata.confidence`/`metadata.sourceRefs`, fields every XOIR
 * node already carries — no new node/edge kind, no new stored field, no
 * hidden state.
 *
 * Pass `capabilities` (the same `LowerCapabilitiesResult` `packageXoirGraph`
 * / `lowerCapabilitiesToManifest` already produced for this graph, if the
 * caller has one) to also populate the resolved/unresolved/ambiguous/
 * denied breakdown; omit it to get a purely structural report with no
 * binding resolution performed as a side effect.
 */
export function computeSemanticQualityReport(graph: XoirGraph, capabilities?: LowerCapabilitiesResult): SemanticQualityReport {
  const stats = graph.stats();
  const capabilityNodes = graph.allNodes().filter((n) => n.kind === 'capability');

  let highConfidenceCapabilities = 0;
  let lowConfidenceCapabilities = 0;
  for (const node of capabilityNodes) {
    if (node.metadata.confidence >= HIGH_CONFIDENCE_THRESHOLD) highConfidenceCapabilities += 1;
    else lowConfidenceCapabilities += 1;
  }

  const reasoningNodes = [...REASONING_KINDS].reduce((sum, kind) => sum + (stats.nodesByKind[kind] ?? 0), 0);
  const constraintNodes = stats.nodesByKind['constraint'] ?? 0;
  const decisionNodes = stats.nodesByKind['decision_node'] ?? 0;

  const allNodes = graph.allNodes();
  const withProvenance = allNodes.filter((n) => n.metadata.sourceRefs.length > 0).length;
  const provenanceCoverage = allNodes.length === 0 ? 1 : withProvenance / allNodes.length;

  const referenceableKinds = new Set(['capability', 'concept']);
  const linkEdges = graph.allEdges().filter((e) => {
    if (e.kind !== 'REQUIRES') return false;
    const evidenceKind = e.metadata.custom['evidenceKind'];
    if (evidenceKind === undefined) return false; // a REQUIRES edge from some other source (e.g. a Capability's own declared `dependencies`) — not a semantic-link edge, see semantic-link.ts
    const toNode = graph.getNode(e.toId);
    return toNode.ok && referenceableKinds.has(toNode.value.kind);
  });
  const highConfidenceLinks = linkEdges.filter((e) => e.metadata.custom['evidenceKind'] === 'exact_label').length;
  const mediumConfidenceLinks = linkEdges.filter((e) => e.metadata.custom['evidenceKind'] === 'same_unit_term_overlap').length;
  const structuralLinks = linkEdges.filter((e) => e.metadata.custom['evidenceKind'] === 'rule_capability_derivation').length;

  const resolution = capabilities
    ? {
        resolvedCapabilities: capabilities.resolvedCount,
        unresolvedCapabilities: capabilities.outcomes.filter((o) => o.status === 'unresolved').length,
        ambiguousCapabilities: capabilities.outcomes.filter((o) => o.status === 'ambiguous').length,
        deniedCapabilities: capabilities.outcomes.filter((o) => o.status === 'denied').length,
      }
    : {};

  return {
    totalSemanticNodes: stats.nodeCount,
    nodesByKind: stats.nodesByKind,
    capabilitiesDiscovered: capabilityNodes.length,
    highConfidenceCapabilities,
    lowConfidenceCapabilities,
    reasoningNodes,
    constraintNodes,
    decisionNodes,
    provenanceCoverage,
    semanticLinks: linkEdges.length,
    highConfidenceLinks,
    mediumConfidenceLinks,
    structuralLinks,
    ...resolution,
  };
}

/** Convenience: computes the report by first running `lowerCapabilitiesToManifest(graph)` itself, for a caller that has no already-computed `LowerCapabilitiesResult` on hand (e.g. `xo compile`'s pre-package view) and doesn't mind paying for binding resolution again. Deterministic (same graph, same resolvers) — see `capability-lowering.ts`. */
export function computeSemanticQualityReportWithResolution(graph: XoirGraph): SemanticQualityReport {
  return computeSemanticQualityReport(graph, lowerCapabilitiesToManifest(graph));
}
