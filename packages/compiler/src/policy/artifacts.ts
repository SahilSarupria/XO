import type { DecisionTree } from '@xo/capability-layer';
import type { PolicyKnowledge } from './knowledge.js';
import { buildPolicyKnowledge } from './knowledge.js';
import { segmentPolicyText, type PolicyEntry } from './segment.js';

/**
 * Everything the policy-synthesis stage contributes to a package, in exactly the formats `@xo/capability-layer`
 * executes. Every part is optional: a document that yields no rules yields no tree, and the packager simply omits it.
 */
export interface PolicySafetyRule {
  readonly id: string;
  readonly description: string;
  readonly applies_to: 'input' | 'output';
  readonly when: string;
  readonly action: 'block' | 'warn';
  readonly message: string;
  readonly override_output?: Readonly<Record<string, unknown>>;
}

export interface PolicyPromptStrategies {
  readonly persona: string;
  readonly fragments: readonly { readonly id: string; readonly text: string; readonly requires?: 'tool_use' }[];
}

export interface PolicyArtifacts {
  readonly entries: readonly PolicyEntry[];
  readonly knowledge: PolicyKnowledge;
  /** Executable trees (`@xo/capability-layer` format). Absent when no decidable rules were found. */
  readonly trees?: readonly DecisionTree[];
  /** One JSON object per line (worked examples). */
  readonly reasoningTraces?: string;
  readonly promptStrategies?: PolicyPromptStrategies;
  readonly safetyRules?: readonly PolicySafetyRule[];
}

export interface PolicySource {
  readonly text: string;
  readonly title?: string;
  readonly sourcePath?: string;
}

export function synthesizePolicyArtifacts(sources: readonly PolicySource[]): PolicyArtifacts {
  const entries: PolicyEntry[] = [];
  for (const s of sources) {
    const segmented = segmentPolicyText(s.text);
    for (const e of segmented) entries.push({ ...e, index: entries.length });
  }
  const knowledge = buildPolicyKnowledge(entries, sources.map((s) => s.sourcePath ?? s.title ?? 'policy').join(', '));
  return { entries, knowledge };
}
