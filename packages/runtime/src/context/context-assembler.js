/**
 * Builds the system prompt a capability's declaration and retrieved
 * slices imply. Deterministic: the same inputs always produce the same
 * `systemPrompt` string (fixed fragment order — capability framing, then
 * safety rules, then prompting guidance, then the merged knowledge
 * graph).
 */
export class ContextAssembler {
    assemble(params) {
        const fragments = [`You are executing the "${params.capability.declaration.name}" capability: ${params.capability.declaration.description}`];
        for (const slice of params.slices) {
            if (slice.componentKind === 'safety_rules')
                fragments.push(`Safety rules:\n${slice.content}`);
        }
        for (const slice of params.slices) {
            if (slice.componentKind === 'prompt_strategies')
                fragments.push(`Prompting guidance:\n${slice.content}`);
        }
        if (params.mergedKnowledgeGraph) {
            fragments.push(`Knowledge graph (${params.mergedKnowledgeGraph.nodes.length} nodes, ${params.mergedKnowledgeGraph.edges.length} edges, merged from ${params.mergedKnowledgeGraph.sourceCount} source(s)):\n${JSON.stringify(params.mergedKnowledgeGraph.nodes)}`);
        }
        return Object.freeze({
            systemPrompt: fragments.join('\n\n'),
            slices: params.slices,
            ...(params.mergedKnowledgeGraph ? { mergedKnowledgeGraph: params.mergedKnowledgeGraph } : {}),
        });
    }
}
//# sourceMappingURL=context-assembler.js.map