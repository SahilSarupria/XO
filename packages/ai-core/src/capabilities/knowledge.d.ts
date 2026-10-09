/** Stage 5's target shape: extractKnowledge(). Facts, definitions, rules, concepts, relationships, and dependencies between them. */
export type KnowledgeItemType = 'fact' | 'definition' | 'rule' | 'concept';
export interface ExtractedKnowledgeItem {
    readonly id: string;
    readonly type: KnowledgeItemType;
    readonly statement: string;
    readonly domain: string;
    readonly confidence: number;
}
export type KnowledgeRelationType = 'depends_on' | 'derived_from' | 'contradicts' | 'references';
export interface ExtractedRelationship {
    readonly type: KnowledgeRelationType;
    readonly fromItemId: string;
    readonly toItemId: string;
}
export interface KnowledgeExtractionInput {
    readonly domainHint?: string;
}
export interface KnowledgeExtractionOutput {
    readonly items: readonly ExtractedKnowledgeItem[];
    readonly relationships: readonly ExtractedRelationship[];
}
//# sourceMappingURL=knowledge.d.ts.map