import type { CanonicalXoirNodeKind } from '@xo/xoir';
import type { KnownKnowledgeNodeType, KnowledgeNodeType } from '../knowledge/types.js';

/**
 * Maps every Stage 4 `KnownKnowledgeNodeType` to a canonical XOIR
 * `(kind, subtype)` pair, per the reconciliation report §4's
 * kind/subtype split: `kind` answers "what semantic role does this play"
 * (the same 15-member taxonomy every XOIR node uses); `subtype` is
 * always the *original* Stage 4 classification string, preserved
 * verbatim so none of Stage 4's richer 22-member vocabulary is lost —
 * see `knowledge-to-xoir.ts` for where this table is applied.
 *
 * The choices below are judgment calls documented explicitly rather than
 * silently baked in:
 * - `metric`/`event`/`risk`/`opportunity` -> `fact`: each is a concrete,
 *   source-grounded claim ("latency is 40ms", "the merger closed in
 *   Q2"), not an entity (`concept`) or a rule (`heuristic`).
 * - `constraint`/`obligation`/`exception` -> `constraint`: all three are
 *   hard limits the compiled capability must respect, differing only in
 *   subtype.
 * - Everything else (`concept`, `definition`, `entity`, `actor`,
 *   `organization`, `product`, `technology`, `jurisdiction`,
 *   `financial_instrument`, `document`, `reference`, `time_period`,
 *   `process`, `action`, `input`, `output`) -> `concept`: each is
 *   fundamentally naming/classifying a domain entity, which is exactly
 *   what a `Concept` node is for.
 */
export const KNOWLEDGE_NODE_TYPE_TO_CANONICAL_KIND: Readonly<Record<KnownKnowledgeNodeType, CanonicalXoirNodeKind>> = {
  concept: 'concept',
  definition: 'concept',
  entity: 'concept',
  actor: 'concept',
  organization: 'concept',
  product: 'concept',
  technology: 'concept',
  metric: 'fact',
  risk: 'fact',
  opportunity: 'fact',
  constraint: 'constraint',
  obligation: 'constraint',
  exception: 'constraint',
  jurisdiction: 'concept',
  financial_instrument: 'concept',
  document: 'concept',
  reference: 'concept',
  time_period: 'concept',
  event: 'fact',
  process: 'concept',
  action: 'concept',
  input: 'concept',
  output: 'concept',
};

function isKnownKnowledgeNodeType(semanticType: KnowledgeNodeType): semanticType is KnownKnowledgeNodeType {
  return Object.prototype.hasOwnProperty.call(KNOWLEDGE_NODE_TYPE_TO_CANONICAL_KIND, semanticType);
}

/**
 * Resolves a Stage 4 node's `semanticType` to its canonical XOIR kind.
 * `custom:<name>` types (Stage 4's own open-ended extension point, same
 * pattern XOIR itself uses) fall back to `'concept'` — the safest default
 * for an unrecognized entity classification — rather than being rejected;
 * the original string is always preserved as `subtype` regardless (see
 * `knowledge-to-xoir.ts`), so no information is lost even when the kind
 * mapping is a conservative default.
 */
export function canonicalKindForKnowledgeNodeType(semanticType: KnowledgeNodeType): CanonicalXoirNodeKind {
  if (isKnownKnowledgeNodeType(semanticType)) return KNOWLEDGE_NODE_TYPE_TO_CANONICAL_KIND[semanticType];
  return 'concept';
}
