import type { XoirNodeId } from '@xo/xoir';
import type { PrecedenceFact } from './precedence.js';

export interface ToposortResult {
  /** Every id in `nodeIds`, in a single deterministic sequence: topologically valid for every non-cyclic id, with `cyclicIds` appended at the end (see that field's doc comment). */
  readonly order: readonly XoirNodeId[];
  /**
   * Groups of two or more ids that became ready at the exact same round
   * (i.e. neither has any precedence relationship, direct or already
   * satisfied-transitively, forcing one before the other) and were
   * placed relative to each other only via the deterministic tie-break.
   * A caller should treat relative order *within* a group as informative
   * but not authoritative.
   */
  readonly ambiguousGroups: readonly (readonly XoirNodeId[])[];
  /**
   * Ids that could not be assigned a real position because they sit
   * inside (or downstream of) a precedence cycle. Appended to `order`
   * after every non-cyclic id, in deterministic tie-break order — never
   * silently interleaved back into the "confident" part of the order.
   */
  readonly cyclicIds: readonly XoirNodeId[];
}

/**
 * Round-based (level-order) Kahn's algorithm. Rounds, rather than a
 * single FIFO queue, are what let this function tell the difference
 * between "B legitimately comes after A" and "A and B just happened to
 * both be ready with no relationship between them" — see
 * {@link ToposortResult.ambiguousGroups}. `tieBreak` decides both the
 * concrete order *within* a round and, for `cyclicIds`, the order of the
 * unorderable residual.
 */
export function deterministicTopologicalOrder(
  nodeIds: readonly XoirNodeId[],
  facts: readonly PrecedenceFact[],
  tieBreak: (ids: readonly XoirNodeId[]) => readonly XoirNodeId[],
): ToposortResult {
  const idSet = new Set(nodeIds);
  const successors = new Map<XoirNodeId, XoirNodeId[]>();
  const inDegree = new Map<XoirNodeId, number>();
  for (const id of nodeIds) inDegree.set(id, 0);

  for (const fact of facts) {
    if (!idSet.has(fact.before) || !idSet.has(fact.after)) continue;
    if (fact.before === fact.after) continue; // a self-loop is a degenerate cycle of one; handled by the residual pass below
    const list = successors.get(fact.before) ?? [];
    list.push(fact.after);
    successors.set(fact.before, list);
    inDegree.set(fact.after, (inDegree.get(fact.after) ?? 0) + 1);
  }

  const placed = new Set<XoirNodeId>();
  const order: XoirNodeId[] = [];
  const ambiguousGroups: (readonly XoirNodeId[])[] = [];

  // Also treat any id with a self-loop as immediately cyclic, so it never gets placed by the round loop below.
  const selfLooped = new Set(facts.filter((f) => f.before === f.after && idSet.has(f.before)).map((f) => f.before));

  let remaining = nodeIds.filter((id) => !selfLooped.has(id));
  for (;;) {
    const ready = remaining.filter((id) => (inDegree.get(id) ?? 0) === 0 && !placed.has(id));
    if (ready.length === 0) break;
    const sorted = tieBreak(ready);
    if (sorted.length > 1) ambiguousGroups.push(sorted);
    for (const id of sorted) {
      placed.add(id);
      order.push(id);
      for (const next of successors.get(id) ?? []) {
        inDegree.set(next, (inDegree.get(next) ?? 0) - 1);
      }
    }
    remaining = remaining.filter((id) => !placed.has(id));
  }

  const cyclicIds = tieBreak(nodeIds.filter((id) => !placed.has(id)));
  return { order: [...order, ...cyclicIds], ambiguousGroups, cyclicIds };
}
