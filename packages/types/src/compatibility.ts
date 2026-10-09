/**
 * Mirrors SPECIFICATION.md §2.2. L0 is the lowest common denominator
 * (prompt-only); each higher level requires a stronger host capability and
 * a richer component the host can consume.
 */
export type CompatibilityLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

export type HostCapability = 'chat' | 'tool_use' | 'long_context' | 'fine_tuning';

export type ModelFamily = 'gpt' | 'claude' | 'gemini' | 'llama' | 'mistral' | 'qwen' | 'deepseek' | 'generic';

export type ComponentKind =
  | 'knowledge_graph'
  | 'long_term_memory_graph'
  | 'decision_trees'
  | 'reasoning_traces'
  | 'case_library'
  | 'prompt_strategies'
  | 'lora'
  | 'finetune'
  | 'safety_rules'
  | 'benchmark_suite';

export interface ModelFamilyCompatibility {
  readonly family: ModelFamily;
  readonly minCapability: readonly HostCapability[];
  readonly consumes: readonly ComponentKind[];
}

export type FallbackPolicy = 'degrade_gracefully' | 'reject';

export interface CompatibilityDeclaration {
  readonly modelFamilies: readonly ModelFamilyCompatibility[];
  readonly fallbackPolicy: FallbackPolicy;
}
