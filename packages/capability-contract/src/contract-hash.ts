import { ContentHash } from '@xo/types';
import { Sha256Hasher } from '@xo/crypto';
import { canonicalStringify, type XoirValue } from '@xo/xoir';
import type { SemanticCapabilityContract } from './types.js';

/**
 * P0.9B Step 3 — a content hash over a `SemanticCapabilityContract`'s
 * *semantic* content only.
 *
 * Reuses, rather than reinvents, the one canonical-serialization + hash
 * pattern the codebase already has: `@xo/xoir`'s `canonicalStringify`
 * (sorted object keys, one textual form per value — the same function
 * `hashNode`/`hashEdge` hash over) and `@xo/crypto`'s `Sha256Hasher`
 * (the same hasher `@xo/xoir`'s `hashing.ts` uses by default), producing
 * the same `sha256:<hex>` `ContentHash` shape as every other hash here.
 *
 * INCLUDED (semantic content): `name`, `description`, `category`,
 * `inputs`, `outputs`, `requiredPermissions`, `determinism`, `rules`,
 * `actionKnowledgeRefs`.
 *
 * EXCLUDED, and why:
 *  - `id` — identity, not content (hashing it would make the hash a
 *    function of the thing it is meant to describe).
 *  - `confidence` — derived, recomputable; a re-scoring pass must not
 *    fork a contract's content identity. The same reasoning is applied
 *    one level down: each rule's own `confidence` is dropped too.
 *  - `sourceRefs`, `sourceXoirNodeIds` — provenance (where the contract
 *    came from), not what it says — the same rule `@xo/xoir`'s
 *    `XoirManifest` already states for provenance vs. content hashes.
 *    The same reasoning is applied to the XOIR node ids nested inside
 *    `rules[].sourceNodeId` and `actionKnowledgeRefs[].sourceNodeId`: each
 *    is a pointer back to a graph node (already listed, in aggregate, in
 *    `sourceXoirNodeIds`), so hashing it would make the hash change
 *    whenever an equivalent contract is compiled with differently-named
 *    nodes. What remains of a rule is what it says (`kind`, `condition`,
 *    `outcome`, exceptions, structured projections); what remains of an
 *    action ref is its `subtype`.
 *  - `contentHash` — the field this function's own result is stored in.
 *
 * ORDERING (verified by `test/contract-hash.test.ts`). Object key order
 * is normalized by `canonicalStringify`. Five collections are
 * normalized because they are sets keyed by content, not sequences: the
 * builder already emits `rules`/`actionKnowledgeRefs` sorted by node id,
 * and `inputs`/`outputs`/`requiredPermissions` have no meaningful order
 * — so all five are sorted here (by canonical form), making the hash
 * insensitive to any producer's ordering. Arrays nested *inside* one
 * rule (`exceptionConditions`, `structuredExceptions` — which is
 * documented as index-parallel to it — and grammar operand lists) are
 * deliberately left in their given order: there, order is data.
 *
 * `undefined` optional fields are dropped (an absent field and an
 * explicitly-undefined field are the same contract); `canonicalStringify`
 * itself would otherwise render `undefined` as the text "undefined".
 */
export function computeContractContentHash(contract: SemanticCapabilityContract): ContentHash {
  const payload: XoirValue = {
    schema: 'xo.contract-content.v1',
    name: contract.name,
    description: contract.description,
    category: contract.category ?? null,
    inputs: sortedSet(contract.inputs),
    outputs: sortedSet(contract.outputs),
    requiredPermissions: [...contract.requiredPermissions].sort(),
    determinism: contract.determinism,
    rules: sortedSet(contract.rules.map(({ confidence: _derived, sourceNodeId: _pointer, ...semantic }) => semantic)),
    // `?? []`: an embedded contract from a compiler that predates
    // action knowledge refs has no such field — same forward-compatible
    // reading `ActionEscalationBindingResolver` already applies.
    actionKnowledgeRefs: sortedSet((contract.actionKnowledgeRefs ?? []).map(({ subtype }) => ({ subtype }))),
  };
  return ContentHash(new Sha256Hasher().hash(canonicalStringify(payload)));
}

/** Normalizes each element (drops `undefined`), then orders the collection by each element's canonical text. */
function sortedSet(items: readonly unknown[]): XoirValue[] {
  return items
    .map((item) => normalize(item))
    .map((value) => ({ value, key: canonicalStringify(value) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.value);
}

function normalize(value: unknown): XoirValue {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (typeof value === 'object') {
    const out: { [key: string]: XoirValue } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = normalize(v);
    }
    return out;
  }
  return value as XoirValue;
}
