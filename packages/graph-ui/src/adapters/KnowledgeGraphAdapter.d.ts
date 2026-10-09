import type { GraphMetadata } from '../model/types.js';
import type { GraphAdapter } from './types.js';
export interface KnowledgeGraphEntity {
    readonly id: string;
    readonly label: string;
    readonly kind?: 'entity' | 'concept';
    readonly metadata?: GraphMetadata;
}
export interface KnowledgeGraphRelation {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly label?: string;
    readonly type?: string;
    readonly metadata?: GraphMetadata;
}
export interface KnowledgeGraphSource {
    readonly entities: readonly KnowledgeGraphEntity[];
    readonly relations: readonly KnowledgeGraphRelation[];
}
/** Converts an entity/relation knowledge graph into a generic GraphModel. */
export declare const KnowledgeGraphAdapter: GraphAdapter<KnowledgeGraphSource>;
//# sourceMappingURL=KnowledgeGraphAdapter.d.ts.map