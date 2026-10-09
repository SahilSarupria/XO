import type { CapabilityDescriptor } from '../capability/capability-descriptor.js';
import type { MergedKnowledgeGraph } from '../retrieval/knowledge-graph-merge.js';
import type { RetrievedSlice } from '../retrieval/retrieved-slice.js';

/**
 * Stage 2's "Context Assembly" output — a superset of `@xo/runtime-core`'s
 * `AssembledContext` (`systemPromptFragments`/`slices`, minus that
 * interface's `toolSchemas` — see below): this flattens
 * `systemPromptFragments` into one `systemPrompt` string (what
 * `PromptAssembler` folds into the first `ProviderMessage`) and keeps
 * `slices` in this package's own richer, package-attributed
 * `RetrievedSlice` shape rather than `runtime-core`'s un-attributed one,
 * for the same reason described in `retrieval/retrieved-slice.ts`.
 *
 * No `toolSchemas` field: the real `@xo/ai-core`'s `ModelProvider` layer
 * (`provider-types.ts`) has no tool-calling concept at all — only
 * `responseSchema`-driven structured output — so there's nothing for a
 * tool schema to plug into downstream. An earlier version of this class
 * extracted tool schemas from a `prompt_strategies` component; that was
 * built against a provisional stand-in `@xo/ai-core` that invented
 * tool-calling on its own, not something the real package provides.
 */
export interface AssembledContext {
  readonly systemPrompt: string;
  readonly slices: readonly RetrievedSlice[];
  readonly mergedKnowledgeGraph?: MergedKnowledgeGraph;
}

export interface AssembleContextParams {
  readonly capability: CapabilityDescriptor;
  readonly slices: readonly RetrievedSlice[];
  readonly mergedKnowledgeGraph?: MergedKnowledgeGraph;
}

/**
 * Builds the system prompt a capability's declaration and retrieved
 * slices imply. Deterministic: the same inputs always produce the same
 * `systemPrompt` string (fixed fragment order — capability framing, then
 * safety rules, then prompting guidance, then the merged knowledge
 * graph).
 */
export class ContextAssembler {
  assemble(params: AssembleContextParams): AssembledContext {
    const fragments: string[] = [`You are executing the "${params.capability.declaration.name}" capability: ${params.capability.declaration.description}`];

    for (const slice of params.slices) {
      if (slice.componentKind === 'safety_rules') fragments.push(`Safety rules:\n${slice.content}`);
    }
    for (const slice of params.slices) {
      if (slice.componentKind === 'prompt_strategies') fragments.push(`Prompting guidance:\n${slice.content}`);
    }
    if (params.mergedKnowledgeGraph) {
      fragments.push(
        `Knowledge graph (${params.mergedKnowledgeGraph.nodes.length} nodes, ${params.mergedKnowledgeGraph.edges.length} edges, merged from ${params.mergedKnowledgeGraph.sourceCount} source(s)):\n${JSON.stringify(params.mergedKnowledgeGraph.nodes)}`,
      );
    }

    return Object.freeze({
      systemPrompt: fragments.join('\n\n'),
      slices: params.slices,
      ...(params.mergedKnowledgeGraph ? { mergedKnowledgeGraph: params.mergedKnowledgeGraph } : {}),
    });
  }
}
