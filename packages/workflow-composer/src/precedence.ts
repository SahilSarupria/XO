import type { XoirEdge, XoirEdgeKind, XoirGraph, XoirNodeId } from '@xo/xoir';

/**
 * How a given capability<->capability edge kind translates into "which
 * capability's step must come first." Derived entirely from meanings
 * already documented elsewhere in the platform — this module invents no
 * new semantics, it only makes existing ones executable for ordering
 * purposes:
 *
 * - `REQUIRES` (`fromId` requires `toId`) and `DEPENDS_ON` (general
 *   dependency, `@xo/xoir`'s `edge-kinds.ts`): `toId` is a prerequisite,
 *   so `toId` before `fromId` — see `capability-to-xoir.ts`, which emits
 *   `REQUIRES` edges from a capability to each id in its own
 *   `dependencies` list.
 * - `INVOKES` (`fromId` invokes `toId`, `edge-mapping.ts`'s mapping of
 *   Stage 5's `invokes` relation type): the invoked capability must be
 *   available first, same direction as `REQUIRES`.
 * - `PRODUCES` (`fromId` produces `toId`): `fromId`'s output is what
 *   `toId` is/uses, so `fromId` before `toId`.
 * - `CONSUMES` (`fromId` consumes `toId`): `fromId` needs `toId`'s
 *   output, so `toId` before `fromId` — the mirror image of `PRODUCES`.
 * - `ENABLES` (`fromId` enables `toId`): `fromId` before `toId`.
 * - `COMPOSES_INTO` (`fromId` composes into `toId`, the Linker's edge
 *   kind for combining capabilities into a higher-order one,
 *   `EXPERIENCE_COMPILER.md` §5.5): the constituent runs before the
 *   composite it feeds, so `fromId` before `toId`.
 *
 * `EXTENDS` and `COMPLEMENTS` are deliberately excluded: both describe a
 * structural/stylistic relationship ("is a variant of", "pairs well
 * with"), not an execution dependency — treating either as an ordering
 * edge would be inventing a constraint the relationship never claimed.
 * `CONFLICTS_WITH` is also excluded from ordering (see `compose.ts`,
 * which surfaces it as a `'conflicting_capabilities'` gap instead of
 * silently picking a side).
 */
export type PrecedenceDirection = 'to_before_from' | 'from_before_to';

export const PRECEDENCE_EDGE_KINDS: Readonly<Record<string, PrecedenceDirection>> = {
  REQUIRES: 'to_before_from',
  DEPENDS_ON: 'to_before_from',
  INVOKES: 'to_before_from',
  PRODUCES: 'from_before_to',
  CONSUMES: 'to_before_from',
  ENABLES: 'from_before_to',
  COMPOSES_INTO: 'from_before_to',
};

export function isPrecedenceEdgeKind(kind: XoirEdgeKind): boolean {
  return Object.prototype.hasOwnProperty.call(PRECEDENCE_EDGE_KINDS, kind);
}

/**
 * Sequence Evidence for Workflow Composition (see this package's README).
 *
 * A second, deliberately separate table from {@link PRECEDENCE_EDGE_KINDS}
 * — never merged into it — for edge kinds that claim only "this capability
 * appeared before that one in the source's procedural order," not "this
 * capability logically requires/produces/enables that one." Currently
 * exactly one kind: `custom:sequence`, emitted by `@xo/compiler`'s
 * `relationship-builder.ts` (see that file's doc comment for how it is
 * derived — within-unit adjacency and cross-unit section-mate adjacency).
 * Kept as its own table, rather than added to `PRECEDENCE_EDGE_KINDS`, so
 * that a future maintainer editing the logical-dependency table's doc
 * comment (which enumerates every kind it covers) cannot accidentally
 * absorb a weaker, source-derived signal into it — the separation is
 * structural, not just a runtime flag on each entry.
 */
export const SEQUENCE_EDGE_KINDS: Readonly<Record<string, PrecedenceDirection>> = {
  'custom:sequence': 'from_before_to',
};

export function isSequenceEdgeKind(kind: XoirEdgeKind): boolean {
  return Object.prototype.hasOwnProperty.call(SEQUENCE_EDGE_KINDS, kind);
}

/** Whether a {@link PrecedenceFact} was derived from a proven logical relationship or from weaker, source-derived positional evidence. Never inferred from confidence score — derived solely from which table ({@link PRECEDENCE_EDGE_KINDS} vs {@link SEQUENCE_EDGE_KINDS}) the originating edge kind was found in, so the distinction stays exact and auditable. */
export type PrecedenceStrength = 'logical' | 'source_derived';

/** Edge kinds this package treats as a hard, human-review-worthy conflict rather than an ordering signal — see the doc comment above. */
export const CONFLICT_EDGE_KINDS: ReadonlySet<XoirEdgeKind> = new Set(['CONFLICTS_WITH']);

/** One directed "must come before" fact, derived from a single XOIR edge. `strength` tells a caller whether this is a proven logical dependency (`'logical'`) or a weaker, source-order-only signal (`'source_derived'`) — see {@link PrecedenceStrength}. Never conflate the two: `compose.ts` uses this to keep source-derived ordering honestly labeled rather than presented as a proven dependency. */
export interface PrecedenceFact {
  readonly before: XoirNodeId;
  readonly after: XoirNodeId;
  readonly viaEdgeKind: XoirEdgeKind;
  readonly strength: PrecedenceStrength;
  readonly sourceEdge: XoirEdge;
}

/**
 * Reads every edge in `graph` between nodes in `scope` and resolves it to
 * a `PrecedenceFact` where the edge kind is a known ordering signal —
 * either a proven logical one ({@link PRECEDENCE_EDGE_KINDS}) or a
 * weaker, source-derived one ({@link SEQUENCE_EDGE_KINDS}), each fact
 * tagged with its {@link PrecedenceStrength} accordingly. Edge kinds this
 * package doesn't recognize as an ordering signal or a conflict signal
 * are simply not returned here — they neither impose an order nor get
 * treated as an ambiguity; the module never guesses meaning it doesn't
 * know.
 */
export function derivePrecedenceFacts(graph: XoirGraph, scope: ReadonlySet<XoirNodeId>): readonly PrecedenceFact[] {
  const facts: PrecedenceFact[] = [];
  for (const edge of graph.allEdges()) {
    if (!scope.has(edge.fromId) || !scope.has(edge.toId)) continue;
    const logicalDirection = PRECEDENCE_EDGE_KINDS[edge.kind];
    if (logicalDirection !== undefined) {
      facts.push(
        logicalDirection === 'to_before_from'
          ? { before: edge.toId, after: edge.fromId, viaEdgeKind: edge.kind, strength: 'logical', sourceEdge: edge }
          : { before: edge.fromId, after: edge.toId, viaEdgeKind: edge.kind, strength: 'logical', sourceEdge: edge },
      );
      continue;
    }
    const sequenceDirection = SEQUENCE_EDGE_KINDS[edge.kind];
    if (sequenceDirection !== undefined) {
      facts.push(
        sequenceDirection === 'to_before_from'
          ? { before: edge.toId, after: edge.fromId, viaEdgeKind: edge.kind, strength: 'source_derived', sourceEdge: edge }
          : { before: edge.fromId, after: edge.toId, viaEdgeKind: edge.kind, strength: 'source_derived', sourceEdge: edge },
      );
    }
  }
  return facts;
}

/** Every `CONFLICTS_WITH`-style edge between two nodes in `scope`, as an unordered pair (the relationship is symmetric in effect even if the edge itself is directed). */
export function deriveConflictPairs(graph: XoirGraph, scope: ReadonlySet<XoirNodeId>): readonly (readonly [XoirNodeId, XoirNodeId])[] {
  const pairs: (readonly [XoirNodeId, XoirNodeId])[] = [];
  for (const edge of graph.allEdges()) {
    if (!scope.has(edge.fromId) || !scope.has(edge.toId)) continue;
    if (!CONFLICT_EDGE_KINDS.has(edge.kind)) continue;
    pairs.push([edge.fromId, edge.toId]);
  }
  return pairs;
}
