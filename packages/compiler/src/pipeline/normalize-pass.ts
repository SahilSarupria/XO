import {
  XoirGraph,
  canonicalStringify,
  hashEdge,
  hashNode,
  type Diagnostic,
  type Pass,
  type PassContext,
  type PassResult,
  type XoirEdge,
  type XoirNode,
  type XoirValue,
} from '@xo/xoir';

export const XOIR_NORMALIZATION_PASS_NAME = 'xoir-normalization';

function byCanonicalOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Reorders a node's `sourceRefs` into canonical (content-sorted) order and
 * recomputes the node's hash to match. `sourceRefs` is a *set* of
 * corroborating evidence, not an ordered sequence (see
 * `@xo/xoir`'s README §5) — two nodes asserting the same content backed
 * by the same evidence should hash identically regardless of which order
 * an adapter or merge happened to encounter that evidence in. This is the
 * one place normalization is allowed to change a node's `hash`: the
 * *content* is unchanged (same set of refs, same properties, same
 * confidence), only its canonical *ordering* is fixed — see the pipeline
 * README section on why this doesn't count as "information loss."
 */
function canonicalizeNode(node: XoirNode): XoirNode {
  const sortedRefs = [...node.metadata.sourceRefs].sort((a, b) => byCanonicalOrder(canonicalStringify(a as unknown as XoirValue), canonicalStringify(b as unknown as XoirValue)));
  const alreadyCanonical = sortedRefs.every((ref, i) => ref === node.metadata.sourceRefs[i]);
  if (alreadyCanonical) return node;
  const { hash: _oldHash, ...rest } = node;
  const normalized = { ...rest, metadata: { ...rest.metadata, sourceRefs: sortedRefs } };
  return { ...normalized, hash: hashNode(normalized) };
}

function canonicalizeEdge(edge: XoirEdge): XoirEdge {
  const sortedRefs = [...edge.metadata.sourceRefs].sort((a, b) => byCanonicalOrder(canonicalStringify(a as unknown as XoirValue), canonicalStringify(b as unknown as XoirValue)));
  const alreadyCanonical = sortedRefs.every((ref, i) => ref === edge.metadata.sourceRefs[i]);
  if (alreadyCanonical) return edge;
  const { hash: _oldHash, ...rest } = edge;
  const normalized = { ...rest, metadata: { ...rest.metadata, sourceRefs: sortedRefs } };
  return { ...normalized, hash: hashEdge(normalized) };
}

function edgeEquivalenceKey(edge: XoirEdge): string {
  // Same (kind, fromId, toId) is the same *relationship*, even if two different pipeline
  // runs happened to mint different edge ids for it — see the doc comment below.
  return canonicalStringify({ kind: edge.kind, fromId: edge.fromId, toId: edge.toId });
}

/**
 * Collapses edges that assert the exact same relationship (`kind`,
 * `fromId`, `toId`) under two *different* ids into one canonical edge,
 * keeping the lexicographically-smallest id (a deterministic, arbitrary
 * but stable tie-break) and unioning their `sourceRefs`. This is the one
 * "safe deduplication" this pass performs, and it is deliberately narrow:
 * it never merges two edges of different `kind` or different endpoints,
 * and it never merges two *nodes* by content — see the pipeline README's
 * "What normalization does not do" section for why broader deduplication
 * is out of scope for Stage 6.
 */
function collapseEquivalentEdges(edges: readonly XoirEdge[], diagnostics: Diagnostic[]): readonly XoirEdge[] {
  const groups = new Map<string, XoirEdge[]>();
  for (const edge of edges) {
    const key = edgeEquivalenceKey(edge);
    const list = groups.get(key) ?? [];
    list.push(edge);
    groups.set(key, list);
  }

  const result: XoirEdge[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]!);
      continue;
    }
    const sorted = [...group].sort((a, b) => byCanonicalOrder(a.id, b.id));
    const canonical = sorted[0]!;
    const droppedIds = sorted.slice(1).map((e) => e.id);
    const unionedRefs = new Map<string, (typeof canonical)['metadata']['sourceRefs'][number]>();
    for (const e of sorted) {
      for (const ref of e.metadata.sourceRefs) unionedRefs.set(canonicalStringify(ref as unknown as XoirValue), ref);
    }
    const { hash: _oldHash, ...rest } = canonical;
    const reconciled = {
      ...rest,
      metadata: {
        ...rest.metadata,
        sourceRefs: [...unionedRefs.entries()].sort((a, b) => byCanonicalOrder(a[0], b[0])).map(([, ref]) => ref),
      },
    };
    const built = { ...reconciled, hash: hashEdge(reconciled) };
    result.push(built);
    diagnostics.push({
      severity: 'info',
      message: `Collapsed ${sorted.length} equivalent ${canonical.kind} edges (${canonical.fromId} -> ${canonical.toId}) into "${canonical.id}"; dropped duplicate id(s): ${droppedIds.join(', ')}`,
      passName: XOIR_NORMALIZATION_PASS_NAME,
      code: 'xoir-normalization/equivalent_edges_collapsed',
      edgeId: canonical.id,
    });
  }
  return result;
}

/**
 * The Stage 6 XOIR normalization pass. Distinct from validation (§6 of
 * the pipeline README) — it never rejects a graph, only transforms a
 * *valid* graph into its canonical deterministic form:
 *
 * 1. Rebuilds the graph with nodes inserted in `id`-sorted order and
 *    edges inserted in `id`-sorted order (§7's "deterministic ordering" /
 *    "stable graph traversal/order" — `XoirGraph`'s internal `Map`s
 *    preserve insertion order, so this fixes `allNodes()`/`allEdges()`
 *    iteration order for every downstream consumer, independent of
 *    whatever order the adapters/merge happened to produce).
 * 2. Canonicalizes every node/edge's `sourceRefs` ordering
 *    (`canonicalizeNode`/`canonicalizeEdge` above).
 * 3. Collapses exact-duplicate edges asserting the same relationship
 *    under different ids (`collapseEquivalentEdges` above), unioning
 *    their provenance rather than dropping either one.
 *
 * Deliberately does NOT: infer that two differently-`id`'d *nodes* are
 * "the same" (that would be exactly the "speculative semantic
 * equivalence inference" Stage 6 §7 forbids), reorder `properties`
 * arrays (order there is domain-meaningful, not a provenance set), or
 * touch `tags`/`custom` beyond what's already carried through unchanged.
 * The manifest, if present, is passed through unmodified — normalization
 * operates on graph content, not compilation bookkeeping.
 */
export function createXoirNormalizationPass(): Pass {
  return {
    name: XOIR_NORMALIZATION_PASS_NAME,
    // Not registered as a hard `dependsOn` against the validation pass name: the two run in
    // separate PassManager invocations from the orchestrator (compile.ts), which only calls this
    // pass at all once validation has already succeeded — see compile.ts's doc comment for why.
    dependsOn: [],
    run(context: PassContext): PassResult {
      const diagnostics: Diagnostic[] = [];

      const sortedNodeIds = [...context.graph.allNodes()].map((n) => n.id).sort(byCanonicalOrder);
      const canonicalNodes = sortedNodeIds.map((id) => {
        const result = context.graph.getNode(id);
        if (!result.ok) throw new Error(`normalization: node "${id}" disappeared mid-pass`); // structurally impossible; graph is not mutated concurrently
        return canonicalizeNode(result.value);
      });

      const rawEdges = [...context.graph.allEdges()].sort((a, b) => byCanonicalOrder(a.id, b.id));
      const canonicalizedEdges = rawEdges.map(canonicalizeEdge);
      const collapsedEdges = collapseEquivalentEdges(canonicalizedEdges, diagnostics).slice().sort((a, b) => byCanonicalOrder(a.id, b.id));

      const normalized = new XoirGraph(context.graph.id, context.graph.schemaVersion, context.graph.manifest);
      for (const node of canonicalNodes) {
        const added = normalized.addNode(node);
        if (!added.ok) throw added.error; // structurally impossible: ids were already unique in the source graph
      }
      for (const edge of collapsedEdges) {
        if (!normalized.hasNode(edge.fromId) || !normalized.hasNode(edge.toId)) continue; // endpoint dropped upstream — same defensive policy as the Stage 4/5 adapters
        if (normalized.getEdge(edge.id).ok) continue; // already inserted (can happen if collapseEquivalentEdges' canonical id collides with another surviving edge's id)
        const added = normalized.addEdge(edge);
        if (!added.ok) throw added.error;
      }

      return { graph: normalized, diagnostics };
    },
  };
}
