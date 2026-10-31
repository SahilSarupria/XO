import type { DecisionTree } from '@xo/capability-layer';
import type { PolicyKnowledge } from './knowledge.js';
import { buildPolicyKnowledge } from './knowledge.js';
import { extractRules, type RuleSet } from './rules.js';
import { synthesizeSafetyRules, synthesizeStrategies, synthesizeTraces, synthesizeTree } from './synthesize.js';
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
  /** What the extractor understood and what it did not — the thing a human reviews before trusting the tree. */
  readonly review: PolicyReview;
}

export interface PolicyReview {
  readonly decisionSentences: number;
  readonly recognizedSentences: number;
  readonly unrecognized: RuleSet['unrecognized'];
  readonly failClosedPaths: readonly string[];
  readonly treeProblems: readonly string[];
  readonly status: 'unreviewed';
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
  const title = sources[0]?.title ?? 'the policy document';
  const rules = extractRules(entries);
  const synth = synthesizeTree(rules, title);
  const tree = synth.tree !== undefined && synth.treeProblems.length === 0 ? synth.tree : undefined;
  const traces = tree !== undefined ? synthesizeTraces(tree) : '';
  const review: PolicyReview = {
    decisionSentences: rules.decisionSentences,
    recognizedSentences: rules.decisionSentences - rules.unrecognized.length,
    unrecognized: rules.unrecognized,
    failClosedPaths: synth.failClosedPaths,
    treeProblems: synth.treeProblems,
    status: 'unreviewed',
  };
  return {
    entries,
    knowledge,
    ...(tree !== undefined ? { trees: [tree] } : {}),
    ...(traces !== '' ? { reasoningTraces: traces } : {}),
    ...(tree !== undefined ? { promptStrategies: synthesizeStrategies(rules, title, true) } : {}),
    ...(tree !== undefined ? { safetyRules: synthesizeSafetyRules(rules) } : {}),
    review,
  };
}
