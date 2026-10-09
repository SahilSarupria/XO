import { err, ok, type Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId, type CanonicalXoirNodeKind, type XoirPropertyBag, type XoirValue } from '@xo/xoir';
import type { ReasoningGraph, ReasoningNode } from '../reasoning/types.js';
import { canonicalKindForReasoningNodeType } from './reasoning-node-kind-mapping.js';
import { isReversedReasoningEdgeType, xoirEdgeKindForReasoningEdgeType } from './reasoning-edge-mapping.js';
import { provenanceToSourceRefs, toXoirConfidence } from './provenance.js';
import { linkRuleSourcesToReferencedNodes, linkMintedRuleCapabilities, type RuleLinkSource } from './rule-capability-linking.js';

export interface ReasoningGraphToXoirOptions {
  readonly graphId?: string;
  /** An existing `XoirGraph` to add these nodes/edges into — same convention as `knowledge-to-xoir.ts`/`capability-to-xoir.ts`'s `into` option. Passing the graph a prior `knowledgeGraphToXoir`/`capabilityGraphToXoir` call produced is what lets `linkReferencedNodes` (below) find real Concept/Capability nodes to point at. */
  readonly into?: XoirGraph;
  /** Best-effort: for every reasoning node's condition/action/outcome text, scan the target graph's existing capability/concept nodes for one whose label appears as a substring, and add a REQUIRES edge when found. Default true. */
  readonly linkReferencedNodes?: boolean;
  readonly now?: () => string;
}

function nowOpt(now: (() => string) | undefined): { now: () => string } | Record<string, never> {
  return now !== undefined ? { now } : {};
}

/**
 * Structured-semantics fields on `ReasoningNode` are already
 * plain-JSON-shaped (built by `@xo/capability-contract`'s
 * `structured-expression-grammar.ts`, which never returns a class
 * instance, `Map`, or `Date` — see that module's `StructuredCondition`
 * union). Round-tripping through `JSON.stringify`/`JSON.parse` here is
 * the same defensive technique `contract-embed.ts` already uses for
 * `semanticCapabilityContract` property bags: it's a no-op for data
 * that's already `XoirValue`-shaped, and it's what guarantees no stray
 * `undefined`-valued key (which `XoirValue` disallows but a hand-built
 * object literal could theoretically contain) ever reaches
 * `target.createAndAddNode` in a validation-breaking shape.
 */
function toXoirStructuredValue<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Builds the XOIR properties bag for a canonical node kind out of a Stage
 * 7 `ReasoningNode`. Every required property a canonical kind's
 * validation rule demands is present - where a `ReasoningNode` field the
 * pattern that produced it didn't set is needed, it falls back to
 * `canonicalLabel` (a real, already-known summary of the node - never a
 * fabricated new value) rather than an empty placeholder.
 *
 * Phase 2: `structuredCondition`/`structuredAction` are attached only for
 * `heuristic`/`decision_node`/`constraint` — the three kinds
 * `node-kinds.ts` actually declares a slot for, matching exactly what
 * `@xo/capability-contract`'s `contract-builder.ts` consumes. See
 * `../reasoning/structured-semantics.ts`'s doc comment for why this
 * function's own condition/action field selection (`node.condition ??
 * fallback`, `node.action ?? node.condition ?? fallback`, etc.) is what
 * that module deliberately mirrors, rather than re-deriving independently.
 */
function buildProperties(kind: CanonicalXoirNodeKind, node: ReasoningNode): XoirPropertyBag {
  const fallback = node.canonicalLabel;
  const structuredCondition = toXoirStructuredValue(node.structuredCondition) as Readonly<Record<string, XoirValue>> | undefined;
  const structuredAction = toXoirStructuredValue(node.structuredAction) as Readonly<Record<string, XoirValue>> | undefined;
  const structuredExceptions = toXoirStructuredValue(node.structuredExceptions) as readonly Readonly<Record<string, XoirValue>>[] | undefined;
  switch (kind) {
    case 'heuristic':
      return {
        condition: node.condition ?? fallback,
        action: node.action ?? fallback,
        exceptionConditions: node.exceptionConditions,
        ...(structuredCondition !== undefined ? { structuredCondition } : {}),
        ...(structuredAction !== undefined ? { structuredAction } : {}),
        ...(structuredExceptions !== undefined ? { structuredExceptions } : {}),
      };
    case 'constraint':
      return {
        rule: node.action ?? node.condition ?? fallback,
        severity: (node.metadata.severity as 'info' | 'warning' | 'blocking' | undefined) ?? (node.nodeType === 'prohibition' ? 'blocking' : 'warning'),
        ...(structuredCondition !== undefined ? { structuredCondition } : {}),
      };
    case 'decision_node':
      return {
        question: node.condition ?? fallback,
        outcome: node.outcome ?? fallback,
        rationale: node.rationale ?? '',
        ...(structuredCondition !== undefined ? { structuredCondition } : {}),
        ...(structuredAction !== undefined ? { structuredAction } : {}),
      };
    case 'reasoning_step':
      return { premise: node.rationale ?? fallback, conclusion: node.outcome ?? fallback };
    case 'escalation_rule':
      return { triggerCondition: node.condition ?? fallback, escalationTarget: node.action ?? fallback };
    case 'risk_policy':
      return { domain: node.metadata.metric ?? node.condition ?? fallback, toleranceLevel: node.condition ?? fallback, overrideConditions: node.exceptionConditions };
    default:
      return { condition: node.condition ?? fallback, action: node.action ?? fallback, exceptionConditions: node.exceptionConditions };
  }
}

/**
 * Converts a Stage 7 ReasoningGraph into canonical XOIR. Preserves,
 * losslessly: identity (ReasoningNode/Edge ids reused verbatim), kind +
 * subtype (every KnownReasoningNodeType maps to its exact canonical XOIR
 * home, no new node kind needed), provenance/confidence (shared helpers
 * with Stage 4/5), exceptionConditions, and relationships (every
 * KnownReasoningEdgeType maps 1:1 onto an existing XOIR edge kind except
 * alternative_to, the one genuine addition; leads_to is emitted reversed
 * - see reasoning-edge-mapping.ts).
 *
 * Deterministic given the same ReasoningGraph and the same `now`, for the
 * identical reason the Stage 4/5 adapters are.
 */
export function reasoningGraphToXoir(graph: ReasoningGraph, options: ReasoningGraphToXoirOptions = {}): Result<XoirGraph, XoError> {
  const target = options.into ?? XoirGraph.create(XoirGraphId(options.graphId ?? 'reasoning-graph'));
  const searchableTextByNodeId = new Map<string, string>();
  const unitIdByNodeId = new Map<string, string | undefined>();

  for (const node of graph.nodes) {
    const kind = canonicalKindForReasoningNodeType(node.nodeType);
    const confidenceDetail = toXoirConfidence(node.confidence, node.provenance);
    const result = target.createAndAddNode({
      id: XoirNodeId(node.id),
      kind,
      properties: buildProperties(kind, node),
      confidence: node.confidence,
      confidenceDetail,
      sourceRefs: provenanceToSourceRefs(node.provenance),
      subtype: node.nodeType,
      ...nowOpt(options.now),
    });
    if (!result.ok) return err(result.error);
    searchableTextByNodeId.set(node.id, [node.condition, node.action, node.outcome].filter((v): v is string => v !== undefined).join(' \u0000 '));
    unitIdByNodeId.set(node.id, node.provenance[0]?.experienceUnitId);
  }

  for (const edge of graph.edges) {
    if (!target.hasNode(XoirNodeId(edge.fromNodeId)) || !target.hasNode(XoirNodeId(edge.toNodeId))) continue;
    const reversed = isReversedReasoningEdgeType(edge.type);
    const fromId = reversed ? edge.toNodeId : edge.fromNodeId;
    const toId = reversed ? edge.fromNodeId : edge.toNodeId;
    const result = target.createAndAddEdge({
      id: XoirEdgeId(edge.id),
      kind: xoirEdgeKindForReasoningEdgeType(edge.type),
      fromId: XoirNodeId(fromId),
      toId: XoirNodeId(toId),
      confidence: edge.confidence,
      confidenceDetail: toXoirConfidence(edge.confidence, edge.provenance),
      sourceRefs: provenanceToSourceRefs(edge.provenance),
      ...nowOpt(options.now),
    });
    if (!result.ok) return err(result.error);
  }

  if (options.linkReferencedNodes ?? true) {
    const ruleSources: RuleLinkSource[] = [];
    for (const [nodeId, searchableText] of searchableTextByNodeId) {
      ruleSources.push({ nodeId, searchableText, unitId: unitIdByNodeId.get(nodeId) });
    }
    linkRuleSourcesToReferencedNodes(target, ruleSources, options.now);
  }

  // M1.1 — always link a minted rule-level capability (see
  // `../capabilities/rule-capability-minter.ts`) back to its own
  // originating rule. This is a structural fact of how the capability
  // was created, not a best-effort content scan, so it runs
  // unconditionally rather than being gated behind
  // `linkReferencedNodes` — a minted capability with `linkReferencedNodes:
  // false` would otherwise be unreachable by any REQUIRES edge at all.
  linkMintedRuleCapabilities(target, options.now);

  return ok(target);
}
