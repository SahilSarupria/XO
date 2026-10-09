import { err, ok, type Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import {
  XoirGraph,
  XoirGraphId,
  XoirNodeId,
  XoirEdgeId,
  type CanonicalXoirNodeKind,
  type XoirPropertyBag,
} from '@xo/xoir';
import type { KnowledgeGraph, KnowledgeNode } from '../knowledge/types.js';
import { canonicalKindForKnowledgeNodeType } from './node-kind-mapping.js';
import { xoirEdgeKindForKnowledgeEdgeType } from './edge-mapping.js';
import { provenanceToSourceRefs, toXoirConfidence } from './provenance.js';
import type { RuleLinkSource } from './rule-capability-linking.js';

export interface KnowledgeGraphToXoirOptions {
  readonly graphId?: string;
  /** An existing `XoirGraph` to add these nodes/edges into (e.g. one a prior `capabilityGraphToXoir` call already populated), rather than creating a fresh one. Lets Stage 4 and Stage 5 output converge into a single combined graph — see the package README's "Combining Stage 4 and Stage 5 output." */
  readonly into?: XoirGraph;
  readonly now?: () => string;
}

function nowOpt(now: (() => string) | undefined): { now: () => string } | Record<string, never> {
  return now !== undefined ? { now } : {};
}

/**
 * Builds the XOIR properties bag for a canonical node kind out of a Stage
 * 4 `KnowledgeNode`, satisfying whatever that kind's required properties
 * are (`@xo/xoir`'s `validation.ts#REQUIRED_PROPERTIES_BY_KNOWN_KIND`)
 * using the node's own `canonicalLabel`/`metadata` — never a fabricated
 * value. `metadata` (Stage 4's free-form `Record<string,string>`) is
 * always spread in last, so an extractor's own explicit metadata key
 * (e.g. a `severity` an extractor actually determined) wins over any
 * derived default below.
 */
function buildProperties(kind: CanonicalXoirNodeKind, node: KnowledgeNode): XoirPropertyBag {
  const metadata = node.metadata as unknown as XoirPropertyBag;
  switch (kind) {
    case 'concept':
      return { definition: node.canonicalLabel, aliases: node.aliases, ...metadata };
    case 'fact':
      return { statement: node.canonicalLabel, domain: node.semanticType, ...metadata };
    case 'constraint':
      // 'severity' has no Stage 4 equivalent field; 'warning' is a documented, conservative structural
      // default (a mid-severity placeholder), not a claim about what the source material said — an
      // extractor that determines real severity should set metadata.severity, which wins via the spread above.
      return { rule: node.canonicalLabel, severity: 'warning', ...metadata };
    default:
      // Every KNOWLEDGE_NODE_TYPE_TO_CANONICAL_KIND entry only ever resolves to 'concept' | 'fact' | 'constraint' — see node-kind-mapping.ts.
      return { definition: node.canonicalLabel, aliases: node.aliases, ...metadata };
  }
}

/**
 * Converts a Stage 4 `KnowledgeGraph` into canonical XOIR (reconciliation
 * report §16). Preserves, losslessly:
 * - **identity**: a `KnowledgeNode.id`/`KnowledgeEdge.id` is reused
 *   verbatim as the XOIR node/edge id, so the same deterministic Stage 4
 *   id space carries through unchanged.
 * - **aliases**: carried in `concept` properties.
 * - **provenance**: every `KnowledgeProvenance` becomes a `XoirSourceRef`
 *   (`provenance.ts#provenanceToSourceRefs`) — nothing is summarized away.
 * - **confidence**: the bare Stage 4 `confidence` number becomes
 *   `metadata.confidence` (unchanged) AND a full `XoirConfidence` derived
 *   from real provenance-count corroboration (`provenance.ts#toXoirConfidence`).
 * - **semantic subtype**: `KnowledgeNode.semanticType` is preserved
 *   verbatim as `metadata.subtype`, regardless of which canonical `kind`
 *   it was classified into (`node-kind-mapping.ts`) — this is the
 *   specific mechanism that keeps Stage 4's richer 22-type vocabulary
 *   from being lost.
 * - **relationships**: every `KnowledgeEdge` becomes a XOIR edge via
 *   `edge-mapping.ts`'s total, 1:1 type mapping.
 *
 * Deterministic: given the same `KnowledgeGraph` and the same `now`
 * (defaulted to wall-clock time, override for tests), this always
 * produces the same set of nodes/edges/ids — only the `createdAt`/
 * `updatedAt` timestamps vary run-to-run with the default `now`, and
 * those never affect any content hash (see `@xo/xoir`'s hashing.ts).
 */
export function knowledgeGraphToXoir(graph: KnowledgeGraph, options: KnowledgeGraphToXoirOptions = {}): Result<XoirGraph, XoError> {
  const target = options.into ?? XoirGraph.create(XoirGraphId(options.graphId ?? 'knowledge-graph'));

  for (const node of graph.nodes) {
    const kind = canonicalKindForKnowledgeNodeType(node.semanticType);
    const confidenceDetail = toXoirConfidence(node.confidence, node.provenance);
    const result = target.createAndAddNode({
      id: XoirNodeId(node.id),
      kind,
      properties: buildProperties(kind, node),
      confidence: node.confidence,
      confidenceDetail,
      sourceRefs: provenanceToSourceRefs(node.provenance),
      subtype: node.semanticType,
      ...(node.producedBy !== undefined ? { producedBy: node.producedBy } : {}),
      ...nowOpt(options.now),
    });
    if (!result.ok) return err(result.error);
  }

  for (const edge of graph.edges) {
    // A node conflict (e.g. this KnowledgeGraph being merged into an `into` graph that already
    // has a node under this edge's endpoint id, from a different source) is not this adapter's
    // job to resolve — mergeGraphs (@xo/xoir/merge.ts) is. If either endpoint isn't present yet,
    // skip the edge rather than fail the whole conversion; a caller combining multiple sources
    // should convert all of them before relying on edges being complete.
    if (!target.hasNode(XoirNodeId(edge.fromNodeId)) || !target.hasNode(XoirNodeId(edge.toNodeId))) continue;
    const result = target.createAndAddEdge({
      id: XoirEdgeId(edge.id),
      kind: xoirEdgeKindForKnowledgeEdgeType(edge.type),
      fromId: XoirNodeId(edge.fromNodeId),
      toId: XoirNodeId(edge.toNodeId),
      confidence: edge.confidence,
      confidenceDetail: toXoirConfidence(edge.confidence, edge.provenance),
      sourceRefs: provenanceToSourceRefs(edge.provenance),
      ...nowOpt(options.now),
    });
    if (!result.ok) return err(result.error);
  }

  return ok(target);
}

/**
 * Collects Stage 4 "rule" nodes — every `KnowledgeNode` whose
 * `semanticType` maps to canonical kind `constraint`
 * (`constraint`/`obligation`/`exception`; see
 * `node-kind-mapping.ts#KNOWLEDGE_NODE_TYPE_TO_CANONICAL_KIND` — the same
 * single source of truth `knowledgeGraphToXoir` itself uses, so this can
 * never drift out of sync with what actually becomes a XOIR `constraint`
 * node) — as candidate `RuleLinkSource`s for
 * `rule-capability-linking.ts#linkRuleSourcesToReferencedNodes`.
 *
 * Pure and independent of any XOIR conversion: reads only the original
 * `KnowledgeGraph`, so a caller can compute this *before*
 * `knowledgeGraphToXoir` runs and apply the actual linking only *after*
 * capability nodes exist in the combined graph — see
 * `pipeline/compile.ts`'s `convertToXoir` doc comment, which explains why
 * ordering matters here for exactly the same reason it already does for
 * Stage 7's reasoning nodes.
 *
 * `searchableText` is the node's own `canonicalLabel` — the exact text
 * that becomes the resulting XOIR `constraint` node's `rule` property
 * (see `buildProperties` above) — never anything invented beyond what
 * the node already carries. `unitId` is the node's first
 * `KnowledgeProvenance.experienceUnitId`, the identical "first source
 * reference" convention `reasoning-to-xoir.ts` already uses for its own
 * rule sources.
 */
export function collectKnowledgeRuleSources(graph: KnowledgeGraph): readonly RuleLinkSource[] {
  const sources: RuleLinkSource[] = [];
  for (const node of graph.nodes) {
    if (canonicalKindForKnowledgeNodeType(node.semanticType) !== 'constraint') continue;
    sources.push({ nodeId: node.id, searchableText: node.canonicalLabel, unitId: node.provenance[0]?.experienceUnitId });
  }
  return sources;
}
