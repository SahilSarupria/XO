import type { DecisionTree } from '@xo/capability-layer';
import type { PolicyKnowledge } from './knowledge.js';
import { buildPolicyKnowledge } from './knowledge.js';
import { extractProgram, type Extraction, type UnrecognizedClause } from './extract.js';
import type { PolicyProgram } from './program.js';
import { synthesizeSafetyRules, synthesizeStrategies, synthesizeTraces, synthesizeTree } from './synthesize.js';
import type { PolicyTable } from './from-document.js';
import { segmentPolicyText, type PolicyEntry } from './segment.js';
import { buildClassificationSpec, type ClassificationGlossaryInput, type ClassificationReport } from './classification.js';
import { applyLedger, type ReviewLedger } from './review.js';
import { emitPolicyWorkflows, type WorkflowEmission, type WorkflowEmitOptions } from './workflow-emit.js';

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
  /** The domain-neutral program the tree was built from — what a reviewer reads and what model proposals are checked against. */
  readonly program: PolicyProgram;
  /** Executable trees (`@xo/capability-layer` format). Absent when no decidable rules were found. */
  readonly trees?: readonly DecisionTree[];
  /** One JSON object per line (worked examples). */
  readonly reasoningTraces?: string;
  readonly promptStrategies?: PolicyPromptStrategies;
  readonly safetyRules?: readonly PolicySafetyRule[];
  /** What the extractor understood and what it did not — the thing a human reviews before trusting the tree. */
  readonly review: PolicyReview;
  /** The `workflows` component lowered from this policy, with its determinism/provenance report. Absent when there is no tree or emission failed. */
  readonly workflows?: WorkflowEmission;
  /** Why no workflow was emitted, when one was expected (emission never fails a compilation). */
  readonly workflowProblems?: readonly string[];
}

export interface PolicyReview {
  readonly decisionSentences: number;
  readonly recognizedSentences: number;
  readonly unrecognized: readonly UnrecognizedClause[];
  readonly failClosedPaths: readonly string[];
  /**
   * Rules with a recognized approving outcome that is held while any decision sentence is unreviewed: cases that would be
   * approved escalate (`APPROVAL_HELD_UNREVIEWED_RULES`) instead. Empty when nothing is held. Resolving every review
   * item (accept, edit or reject it in a `ReviewLedger`) releases the hold.
   */
  readonly heldApprovals: readonly string[];
  readonly treeProblems: readonly string[];
  /** For each closed-set input with a glossary: what the document defines, what it does not, and what the model alone decides. */
  readonly classification?: ClassificationReport;
  readonly status: 'unreviewed';
}

export interface PolicySource {
  readonly text: string;
  /** tables found in the source (pulled out of `text` by `policyTextFromParsed`) */
  readonly tables?: readonly PolicyTable[];
  readonly title?: string;
  readonly sourcePath?: string;
}

export interface PolicyOptions {
  /** Customer-supplied glossary for closed-set inputs the document does not define (labelled `operator` in provenance). */
  readonly glossary?: ClassificationGlossaryInput;
  /**
   * Clause proposals to use INSTEAD OF the pattern extraction (already verified by `checkProposal`, see
   * model-extract.ts) — or merged with it by the caller. When absent the deterministic extraction is used.
   */
  readonly extraction?: Extraction;
  /**
   * Reviewer decisions (accepted / edited / rejected clauses, see review.ts) replayed over the pattern extraction, so a
   * human can resolve review items from a file. Ignored when `extraction` is given (the caller already applied them).
   */
  readonly ledger?: ReviewLedger;
  /** Workflow emission runs by default when a tree was synthesized; `false` skips it. */
  readonly workflows?: false | WorkflowEmitOptions;
}

export function synthesizePolicyArtifacts(sources: readonly PolicySource[], options: PolicyOptions = {}): PolicyArtifacts {
  const entries: PolicyEntry[] = [];
  for (const s of sources) {
    const segmented = segmentPolicyText(s.text);
    for (const e of segmented) entries.push({ ...e, index: entries.length });
  }
  const built = buildPolicyKnowledge(entries, sources.map((s) => s.sourcePath ?? s.title ?? 'policy').join(', '));
  // a table's figures must be retrievable as knowledge, not only compiled into a lookup
  const tableNodes = sources
    .flatMap((s) => s.tables ?? [])
    .map((t, i) => ({
      id: `table_${i + 1}`,
      kind: 'rule' as const,
      properties: {
        title: t.caption.replace(/\*\*/g, '').trim().slice(0, 80) || `Table ${i + 1}`,
        section: 'Tables',
        text: `${t.caption.replace(/\*\*/g, '').trim()} ${t.rows.map((r) => `${t.header[0] ?? 'row'} ${r[0]}: ${t.header[1] ?? 'value'} ${r.slice(1).join(' / ')}`).join('; ')}.`,
      },
      confidence: 1,
      provenance: { source: sources[0]?.sourcePath ?? 'policy', origin: 'policy-synthesis' as const, entry: -1 },
    }));
  const knowledge = tableNodes.length === 0 ? built : { ...built, nodes: [...built.nodes, ...tableNodes] };
  const title = sources[0]?.title ?? /^#\s+(.+?)\s*$/m.exec(sources[0]?.text ?? '')?.[1] ?? 'the policy document';
  const extraction =
    options.extraction ??
    (() => {
      const patterns = extractProgram(
        entries,
        title,
        sources.flatMap((s) => s.tables ?? []),
      );
      return options.ledger !== undefined ? applyLedger(patterns, options.ledger) : patterns;
    })();
  const program = extraction.program;
  // An approval must not silently ignore a rule the compiler did not understand: while any decision sentence is open, approvals are held.
  const synth = synthesizeTree(program, { holdApprovals: extraction.unrecognized.length > 0 });
  let tree = synth.tree !== undefined && synth.treeProblems.length === 0 ? synth.tree : undefined;

  let classificationReport: ClassificationReport | undefined;
  if (tree !== undefined) {
    // the closed-set input a glossary classifies: the one the glossary names, else the string input with the most classes
    const candidates = tree.inputs.filter((i) => i.type === 'string' && i.enum !== undefined && i.name !== program.kindVar);
    const field =
      options.glossary?.field !== undefined
        ? candidates.find((i) => i.name === options.glossary!.field)
        : candidates.sort((a, b) => b.enum!.length - a.enum!.length)[0];
    if (field !== undefined && field.enum !== undefined && field.enum.length > 0) {
      const gateClasses = [
        ...new Set(
          program.steps.flatMap((st) =>
            st.kind === 'gate' && st.outcome.decision === 'escalate'
              ? [...st.when.matchAll(new RegExp(`${field.name} == '([^']+)'`, 'g'))].map((m) => m[1]!)
              : [],
          ),
        ),
      ];
      const built = buildClassificationSpec(field.name, tree, entries, [...field.enum], gateClasses, options.glossary);
      classificationReport = built.report;
      if (built.spec !== undefined) {
        const spec = built.spec;
        tree = { ...tree, inputs: tree.inputs.map((i) => (i.name === field.name ? { ...i, classification: spec } : i)) };
      }
    }
  }
  const traces = tree !== undefined ? synthesizeTraces(tree, program.kindVar, program.amountField) : '';
  const review: PolicyReview = {
    decisionSentences: extraction.decisionSentences,
    recognizedSentences: extraction.decisionSentences - extraction.unrecognized.length,
    unrecognized: extraction.unrecognized,
    failClosedPaths: synth.failClosedPaths,
    heldApprovals: synth.heldApprovals,
    treeProblems: synth.treeProblems,
    ...(classificationReport !== undefined ? { classification: classificationReport } : {}),
    status: 'unreviewed',
  };
  const base: PolicyArtifacts = {
    entries,
    knowledge,
    program,
    ...(tree !== undefined ? { trees: [tree] } : {}),
    ...(traces !== '' ? { reasoningTraces: traces } : {}),
    ...(tree !== undefined ? { promptStrategies: synthesizeStrategies(program, title, true) } : {}),
    ...(tree !== undefined ? { safetyRules: synthesizeSafetyRules(program) } : {}),
    review,
  };
  if (tree === undefined || options.workflows === false) return base;
  const emitted = emitPolicyWorkflows(base, options.workflows ?? {});
  return emitted.emission !== undefined ? { ...base, workflows: emitted.emission } : { ...base, workflowProblems: emitted.problems };
}
