import type { Brand } from '@xo/types';

export type KnowledgeNodeId = Brand<string, 'KnowledgeNodeId'>;

/**
 * Node types the compiler spec asked for. Open-ended via `custom:<name>`
 * (the same pattern `@xo/xoir`'s `XoirNodeKind` and Stage 3's
 * `SemanticType` use) — not every listed type is populated by the
 * extractors this stage ships (see the package README's "Known
 * limitations" for exactly which ones are and aren't), but all of them
 * are valid, well-typed targets for a future extractor to produce.
 */
export type KnownKnowledgeNodeType =
  | 'concept'
  | 'definition'
  | 'entity'
  | 'actor'
  | 'organization'
  | 'product'
  | 'technology'
  | 'metric'
  | 'risk'
  | 'opportunity'
  | 'constraint'
  | 'obligation'
  | 'exception'
  | 'jurisdiction'
  | 'financial_instrument'
  | 'document'
  | 'reference'
  | 'time_period'
  | 'event'
  | 'process'
  | 'action'
  | 'input'
  | 'output';
export type KnowledgeNodeType = KnownKnowledgeNodeType | `custom:${string}`;

export type KnownKnowledgeEdgeType =
  | 'defines'
  | 'references'
  | 'depends_on'
  | 'implements'
  | 'requires'
  | 'supports'
  | 'contradicts'
  | 'belongs_to'
  | 'part_of'
  | 'causes'
  | 'mitigates'
  | 'measures'
  | 'governs'
  | 'owned_by'
  | 'uses'
  | 'produces'
  | 'consumes'
  | 'located_in'
  | 'derived_from'
  | 'version_of'
  | 'supersedes';
export type KnowledgeEdgeType = KnownKnowledgeEdgeType | `custom:${string}`;

/**
 * Full traceability back to the source document — required on every
 * node and every edge, per the compiler spec's provenance requirement.
 * `charOffsetRange` is populated "where possible": rule-based entity
 * detection (capitalized-run-detector.ts) knows exact offsets into the
 * unit's content; a whole-unit-derived node's range is the unit's entire
 * content; an AI-extracted item has no offsets at all (`@xo/ai-core`'s
 * `extractKnowledge` capability doesn't return them) and is `undefined`
 * rather than a guessed value.
 */
export interface KnowledgeProvenance {
  readonly experienceUnitId: string;
  readonly documentPath: string;
  readonly pages: readonly number[];
  readonly sectionPath: readonly string[];
  readonly charOffsetRange: readonly [number, number] | undefined;
  readonly confidence: number;
}

export interface KnowledgeNode {
  readonly id: KnowledgeNodeId;
  readonly semanticType: KnowledgeNodeType;
  readonly canonicalLabel: string;
  readonly aliases: readonly string[];
  readonly confidence: number;
  readonly provenance: readonly KnowledgeProvenance[];
  readonly metadata: Readonly<Record<string, string>>;
  /** P0.9A area A: the extractor whose `.name` produced this node — set only when every merged candidate (see `merge.ts`) came from the same extractor; left absent when candidates from different extractors merged into one node, since attributing a single producer to a multi-source merge would be a fabrication, not a fact. */
  readonly producedBy?: string;
}

export interface KnowledgeEdge {
  readonly id: string;
  readonly type: KnowledgeEdgeType;
  readonly fromNodeId: KnowledgeNodeId;
  readonly toNodeId: KnowledgeNodeId;
  readonly confidence: number;
  readonly provenance: readonly KnowledgeProvenance[];
}

/**
 * Stage 4's output artifact. Immutable (every field `readonly`, every
 * array `readonly`), deterministic (see `node-id.ts`), hashable
 * (`graph.ts#hashKnowledgeGraph`), and serializable
 * (`graph.ts#serializeKnowledgeGraph`/`deserializeKnowledgeGraph`) —
 * shaped deliberately close to what Stage 10 will need to lower into a
 * real `@xo/xoir` graph (a `KnowledgeNode` maps naturally onto a
 * `XoirNode`, a `KnowledgeEdge` onto a `XoirEdge`), though this stage
 * does not itself depend on or produce XOIR.
 */
export interface KnowledgeGraph {
  readonly nodes: readonly KnowledgeNode[];
  readonly edges: readonly KnowledgeEdge[];
}
