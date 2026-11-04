import type { DecisionTree } from '@xo/capability-layer';
import { computeCapabilityId } from '../capabilities/capability-id.js';
import type { Capability } from '../capabilities/types.js';
import type { KnowledgeProvenance } from '../knowledge/types.js';
import { computeReasoningNodeId } from '../reasoning/node-id.js';
import type { ReasoningNode, ReasoningNodeType } from '../reasoning/types.js';
import type { ExperienceDocument } from '../semantic/types.js';
import type { PolicyProgram, Step } from './program.js';

/**
 * Bridges a compiled {@link PolicyProgram} into the Stage 5 / Stage 7 graphs the rest of the pipeline already speaks:
 *
 *   - reasoning nodes of the kinds no text extractor produced before: `escalation` (→ `escalation_rule`),
 *     `risk_threshold` (→ `risk_policy`), `decision` (→ `decision_node`) and `prohibition` (→ `constraint`), each
 *     carrying the sentence it was read from as its evidence;
 *   - one capability for the decision tree itself, with a typed signature: every input fact with its type, the four
 *     outputs, determinism "deterministic", idempotent, no side effects. It is the first capability in a compiled graph
 *     whose inputs and outputs are not "unknown", and it is bound to an executable artefact (the tree), not to prose.
 */

const CONFIDENCE = 0.9;

function provenanceFor(docs: readonly ExperienceDocument[], sentence: string, rule: string): KnowledgeProvenance {
  const needle = sentence.slice(0, 60);
  for (const d of docs)
    for (const u of d.units)
      if (u.content.includes(needle) || u.content.replace(/\s+/g, ' ').includes(needle.replace(/\s+/g, ' ')))
        return {
          experienceUnitId: u.id,
          documentPath: u.provenance.documentPath,
          pages: u.provenance.pages,
          sectionPath: u.provenance.sectionPath,
          charOffsetRange: undefined,
          confidence: CONFIDENCE,
        };
  const d = docs[0];
  return {
    experienceUnitId: d?.units[0]?.id ?? `policy:${rule}`,
    documentPath: d?.documentPath ?? 'policy',
    pages: [1],
    sectionPath: [],
    charOffsetRange: undefined,
    confidence: CONFIDENCE,
  };
}

function node(
  type: ReasoningNodeType,
  label: string,
  fields: { condition?: string; action?: string; outcome?: string; rationale?: string },
  provenance: KnowledgeProvenance,
  meta: Record<string, string>,
): ReasoningNode {
  return {
    id: computeReasoningNodeId(type, label),
    nodeType: type,
    canonicalLabel: label,
    ...(fields.condition !== undefined ? { condition: fields.condition } : {}),
    ...(fields.action !== undefined ? { action: fields.action } : {}),
    ...(fields.outcome !== undefined ? { outcome: fields.outcome } : {}),
    ...(fields.rationale !== undefined ? { rationale: fields.rationale } : {}),
    exceptionConditions: [],
    confidence: CONFIDENCE,
    provenance: [provenance],
    metadata: { origin: 'policy-program', ...meta },
  };
}

const isAmountGate = (s: Step, program: PolicyProgram): boolean =>
  s.kind === 'gate' && s.outcome.decision === 'escalate' && /\b[a-z_]+_calc\s*>|_usd\s*>/.test(s.when) && program.amountField !== undefined;

/** reasoning nodes for every gate and prohibition in the program */
export function policyReasoningNodes(program: PolicyProgram, docs: readonly ExperienceDocument[]): ReasoningNode[] {
  const out: ReasoningNode[] = [];
  for (const s of program.steps) {
    if (s.kind !== 'gate') continue;
    const prov = provenanceFor(docs, s.source.sentence, s.source.rule);
    const meta = { stepId: s.id, rule: s.source.rule, section: s.source.section, evidence: s.source.sentence.slice(0, 400) };
    if (isAmountGate(s, program)) {
      out.push(
        node(
          'risk_threshold',
          `${s.note} → ${s.outcome.target ?? 'human review'}`,
          {
            condition: s.note,
            action: `Escalate to ${s.outcome.target ?? 'human review'}`,
            outcome: `escalation_target: ${s.outcome.target ?? 'human review'}`,
            rationale: s.source.sentence,
          },
          prov,
          meta,
        ),
      );
    } else if (s.outcome.decision === 'escalate') {
      out.push(
        node(
          'escalation',
          `${s.note} → ${s.outcome.target ?? 'human review'}`,
          {
            condition: s.note,
            action: `Escalate to ${s.outcome.target ?? 'human review'}`,
            outcome: s.outcome.target ?? 'human review',
            rationale: s.source.sentence,
          },
          prov,
          meta,
        ),
      );
    } else {
      out.push(
        node(
          'decision',
          `${s.note} → ${s.outcome.decision}`,
          {
            condition: s.note,
            action: s.outcome.decision,
            outcome: `${s.outcome.decision} (${s.outcome.reason})`,
            rationale: s.source.sentence,
          },
          prov,
          meta,
        ),
      );
    }
  }
  for (const p of program.prohibitions)
    out.push(
      node(
        'prohibition',
        `Never: ${p.text}`,
        { action: p.text, outcome: 'forbidden', rationale: p.sentence },
        provenanceFor(docs, p.sentence, p.rule),
        { rule: p.rule, evidence: p.sentence.slice(0, 400) },
      ),
    );
  return out;
}

/** the decision tree as a capability with a typed, deterministic signature */
/** The canonical name of the capability a policy compiles to; shared so reports name it exactly as the manifest does. */
export function policyCapabilityName(program: PolicyProgram): string {
  return `Decide ${program.title.replace(/\s+/g, ' ').trim()}`.slice(0, 120);
}

export function policyCapability(program: PolicyProgram, tree: DecisionTree, docs: readonly ExperienceDocument[]): Capability {
  const name = policyCapabilityName(program);
  const outputs = [
    { name: 'decision', description: 'the outcome the document prescribes (approve, deny, escalate, …)' },
    ...(program.amountField !== undefined ? [{ name: program.amountField, description: 'amount to pay; 0 unless the outcome pays' }] : []),
    { name: 'escalation_target', description: 'who the case goes to when escalated, otherwise null' },
    { name: 'reason_code', description: 'which rule decided the case' },
  ];
  const first = program.steps[0];
  const provenance = provenanceFor(docs, first?.source.sentence ?? program.title, first?.source.rule ?? '');
  return {
    id: computeCapabilityId('reasoning', name),
    canonicalName: name,
    aliases: [],
    description: `Applies the stated rules of "${program.title}" to a case and returns the outcome. Executes the compiled decision tree "${tree.id}" deterministically; paths whose clauses were not understood escalate for human review.`,
    category: 'reasoning',
    confidence: CONFIDENCE,
    provenance: [provenance],
    inputs: tree.inputs.map((i) => i.name),
    outputs: outputs.map((o) => o.name),
    inputTypes: Object.fromEntries(tree.inputs.map((i) => [i.name, i.enum !== undefined ? `enum(${i.enum.join('|')})` : i.type])),
    dependencies: [],
    requiredKnowledgeNodeIds: [],
    relatedConcepts: [],
    requiredPermissions: [],
    invocationHints: [],
    examples: [],
    signature: {
      inputs: tree.inputs.map((i) => ({ name: i.name, description: i.description })),
      outputs,
      sideEffects: [],
      requiredResources: [],
      determinism: 'deterministic',
      idempotent: true,
      executionMode: 'sync',
      estimatedCost: 'low',
    },
    metadata: { policy_derived: 'true', tree_id: tree.id },
  };
}
