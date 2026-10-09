import type { ObservedNode } from './observation.js';
import { compareStrings } from './json.js';

/**
 * P0.9C Step 4 — PRODUCER ATTRIBUTION.
 *
 * `XoirNodeMetadata.producedBy` answers exactly one question: WHO CREATED this claim (an extractor's stable `.name`). It is NOT source
 * provenance (`sourceRefs`), NOT evidence strength (`confidence`) and NOT runtime provenance (contract / binding / execution path).
 * Those are separate dimensions (Step 5 owns evidence and provenance) and are never read here.
 *
 * Everything in this file is derived from the compiler's actual assignment chain and is PURE: it reads an observed node and returns a
 * classification. It never modifies a node, never repairs an absent value and never infers a producer from a producer.
 *
 *   knowledge extractor   knowledge/hybrid-extractor.ts stamps `extractorName` on each candidate; knowledge/merge.ts sets `producedBy`
 *                         iff every merged candidate came from ONE extractor; knowledge-to-xoir.ts copies it. -> concept / fact / constraint nodes
 *   capability extractor  capabilities/hybrid-extractor.ts stamps rule-based / structured-operation / ai; capabilities/merge.ts sets
 *                         `producedBy` under the same single-extractor rule; capability-to-xoir.ts copies it. -> capability nodes
 *   NO stamping site      reasoning/*  (heuristic, decision_node, reasoning-derived constraint …) and capabilities/rule-capability-minter.ts
 *                         (rule-minted capabilities). The repository documents `producedBy` as absent "when no genuinely identifiable
 *                         producer exists" but never says whether these paths are meant to be attributed, so absence there is neither
 *                         asserted correct nor asserted defective (`expectation_not_established`).
 */

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

export interface ProducerValueModel {
  /** The literal `producedBy` string. */
  readonly value: string;
  /** Where a node can receive this value. */
  readonly assignedAt: string;
  /** What kind of semantic object can carry it. */
  readonly receivers: string;
  /** `true` iff the pipeline ever writes this string into `producedBy`. */
  readonly stamped: boolean;
  /** Whether the benchmark can establish, independent of `producedBy`, that a node was created by this producer. */
  readonly independentlyEstablishable: string;
  /** Cases in the committed suites that contain at least one node carrying it (verified by test against the real pipeline). */
  readonly exercisedBy: readonly string[];
}

const TEXT_CASES = ['aastha-operations', 'burglary-policy-schedule', 'commercial-property-policy', 'multidoc-burglary-claims', 'synthetic-claim-rules'] as const;

/** Every producer value the repository can assign, derived from the extractors' `.name` fields and the three stamp sites. */
export const PRODUCER_TAXONOMY: readonly ProducerValueModel[] = [
  {
    value: 'rule-based',
    assignedAt: 'knowledge/hybrid-extractor.ts (ruleBased.name) and capabilities/hybrid-extractor.ts (ruleBased.name)',
    receivers: 'concept / fact / constraint nodes (knowledge path) and capability nodes (capability extractor path)',
    stamped: true,
    independentlyEstablishable: 'Yes when AI is not exercised: it is then the only extractor on the text path, and the creation path is visible from kind + subtype (knowledge) or the absence of the rule-derived marker (capability).',
    exercisedBy: [...TEXT_CASES, 'openapi-operation-data-flow', 'structured-operation-data-flow'].sort(compareStrings),
  },
  {
    value: 'structured-operation',
    assignedAt: 'capabilities/hybrid-extractor.ts (structuredOperation.name)',
    receivers: 'capability nodes lowered from structured (json/yaml) and OpenAPI sources',
    stamped: true,
    independentlyEstablishable: 'Yes: the SOURCE FORMAT is a property of the fixture, and only that extractor consumes structured / OpenAPI inputs.',
    exercisedBy: ['openapi-operation-data-flow', 'structured-operation-data-flow'],
  },
  {
    value: 'ai',
    assignedAt: 'knowledge/hybrid-extractor.ts and capabilities/hybrid-extractor.ts (aiExtractor.name), only when an AI extractor is configured',
    receivers: 'concept / fact / constraint and capability nodes',
    stamped: true,
    independentlyEstablishable: 'Not in the benchmark: AI is `not_exercised` (P1.5). Any node merging rule-based and AI candidates legitimately carries no producer.',
    exercisedBy: [],
  },
  {
    value: 'hybrid',
    assignedAt: 'never stamped: `hybrid` is the wrapper extractor\'s own name; it stamps its SUB-extractors\' names',
    receivers: 'none',
    stamped: false,
    independentlyEstablishable: 'A `hybrid` value on a node would itself be a finding.',
    exercisedBy: [],
  },
];

export const KNOWN_PRODUCER_VALUES: readonly string[] = PRODUCER_TAXONOMY.filter((p) => p.stamped).map((p) => p.value);

/** `known`: a value the pipeline can stamp. `unknown`: any other string (reported verbatim; never normalised, never rejected). */
export function producerValueStatus(value: string): 'known' | 'unknown' {
  return KNOWN_PRODUCER_VALUES.includes(value) ? 'known' : 'unknown';
}

// ---------------------------------------------------------------------------
// Creation-path classification (independent of `producedBy`)
// ---------------------------------------------------------------------------

export type ProducerOrigin =
  /** created by knowledge-to-xoir from a knowledge extractor's node */
  | 'knowledge_extractor'
  /** created by capability-to-xoir from a capability extractor's candidate */
  | 'capability_extractor'
  /** minted from a reasoning node by the rule-capability minter (a pass, not an extractor) */
  | 'rule_minted_capability'
  /** created by reasoning-to-xoir from a reasoning extractor's node */
  | 'reasoning_extractor'
  | 'unclassified';

export const PRODUCER_ORIGINS: readonly ProducerOrigin[] = ['knowledge_extractor', 'capability_extractor', 'rule_minted_capability', 'reasoning_extractor', 'unclassified'];

/** Origins whose creation path HAS a stamping site: an absent `producedBy` on these is measurable missing attribution. */
export const STAMPING_ORIGINS: readonly ProducerOrigin[] = ['knowledge_extractor', 'capability_extractor'];

/** compiler `xoir/node-kind-mapping.ts` KNOWLEDGE_NODE_TYPE_TO_CANONICAL_KIND (drift-guarded by test). */
export const KNOWLEDGE_SUBTYPE_KIND: Readonly<Record<string, string>> = {
  concept: 'concept', definition: 'concept', entity: 'concept', actor: 'concept', organization: 'concept', product: 'concept', technology: 'concept',
  metric: 'fact', risk: 'fact', opportunity: 'fact', constraint: 'constraint', obligation: 'constraint', exception: 'constraint', jurisdiction: 'concept',
  financial_instrument: 'concept', document: 'concept', reference: 'concept', time_period: 'concept', event: 'fact', process: 'concept', action: 'concept',
  input: 'concept', output: 'concept',
};

/** compiler `xoir/reasoning-node-kind-mapping.ts` REASONING_NODE_TYPE_TO_CANONICAL_KIND (drift-guarded by test). */
export const REASONING_SUBTYPE_KIND: Readonly<Record<string, string>> = {
  rule: 'heuristic', prerequisite: 'constraint', prohibition: 'constraint', policy: 'constraint', decision: 'decision_node', alternative: 'decision_node',
  justification: 'reasoning_step', exception: 'heuristic', escalation: 'escalation_rule', risk_threshold: 'risk_policy',
};

/** `capabilities/rule-capability-linking.ts` RULE_DERIVED_METADATA_KEY: written by the minter into the capability's own metadata. */
export const RULE_DERIVED_METADATA_KEY = 'xoRuleDerived';

function kindForSubtype(table: Readonly<Record<string, string>>, subtype: string, custom: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(table, subtype)) return table[subtype];
  return subtype.startsWith('custom:') ? custom : undefined;
}

/**
 * Which pipeline created this node — decided ONLY from the node's kind, subtype and the minter's own marker, never from `producedBy`
 * (otherwise a coverage denominator would depend on its numerator). A node matching both pipelines, or neither, is `unclassified`.
 */
export function classifyProducerOrigin(node: Pick<ObservedNode, 'kind' | 'subtype' | 'properties'>): ProducerOrigin {
  if (node.kind === 'capability') {
    const meta = node.properties['metadata'];
    const derived = typeof meta === 'object' && meta !== null && (meta as Record<string, unknown>)[RULE_DERIVED_METADATA_KEY] === 'true';
    return derived ? 'rule_minted_capability' : 'capability_extractor';
  }
  if (node.subtype === undefined) return 'unclassified';
  const knowledge = kindForSubtype(KNOWLEDGE_SUBTYPE_KIND, node.subtype, 'concept') === node.kind;
  const reasoning = kindForSubtype(REASONING_SUBTYPE_KIND, node.subtype, 'heuristic') === node.kind;
  if (knowledge && !reasoning) return 'knowledge_extractor';
  if (reasoning && !knowledge) return 'reasoning_extractor';
  return 'unclassified';
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface ProducerOriginSummary {
  readonly attributed: number;
  readonly unattributed: number;
  /** attributed nodes by producer value */
  readonly producers: Readonly<Record<string, number>>;
}

/** Attributed / unattributed counts per creation path. Pure; every origin key is present, sorted. */
export function summarizeProducerAttribution(nodes: readonly Pick<ObservedNode, 'kind' | 'subtype' | 'properties' | 'producedBy'>[]): Readonly<Record<ProducerOrigin, ProducerOriginSummary>> {
  const out = {} as Record<ProducerOrigin, { attributed: number; unattributed: number; producers: Record<string, number> }>;
  for (const o of PRODUCER_ORIGINS) out[o] = { attributed: 0, unattributed: 0, producers: {} };
  for (const n of nodes) {
    const bucket = out[classifyProducerOrigin(n)];
    if (n.producedBy === undefined) bucket.unattributed += 1;
    else {
      bucket.attributed += 1;
      bucket.producers[n.producedBy] = (bucket.producers[n.producedBy] ?? 0) + 1;
    }
  }
  for (const o of PRODUCER_ORIGINS) out[o].producers = Object.fromEntries(Object.entries(out[o].producers).sort(([a], [b]) => compareStrings(a, b)));
  return out;
}
