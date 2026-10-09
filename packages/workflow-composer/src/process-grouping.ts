import type { XoirGraph, XoirNode } from '@xo/xoir';
import type { ProcessGroupingEvidence } from './types.js';

/**
 * Normalizes a heading/definition string for a loose, tolerant text
 * match — collapsing whitespace and stripping punctuation/case. This
 * package's own source graphs come from PDF text extraction, which
 * routinely introduces stray internal spaces (e.g. "Tally Prim e"); the
 * normalization exists only to tolerate that extraction noise when
 * matching a section heading to a node's own content, never to guess at
 * meaning beyond an already-close textual match.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * The exact, shared `XoirSourceRef.sectionPath` every node in `nodes`
 * carries on at least one of its `sourceRefs`, or `undefined` if the
 * nodes disagree (different section paths, or any node with no section
 * path at all). Never truncates or merges differing paths into a
 * plausible-looking common prefix — full agreement or nothing.
 */
function sharedSectionPath(nodes: readonly XoirNode[]): readonly string[] | undefined {
  if (nodes.length === 0) return undefined;
  let candidate: readonly string[] | undefined;
  for (const node of nodes) {
    const paths = node.metadata.sourceRefs.map((r) => r.sectionPath).filter((p): p is readonly string[] => p !== undefined && p.length > 0);
    if (paths.length === 0) return undefined;
    if (candidate === undefined) {
      // A node may itself carry more than one sourceRef/sectionPath (merged from multiple mentions);
      // take the first occurrence as the candidate and require every other node to match it exactly.
      candidate = paths[0];
    }
    const matches = paths.some((p) => p.length === candidate!.length && p.every((seg, i) => seg === candidate![i]));
    if (!matches) return undefined;
  }
  return candidate;
}

/**
 * Finds a `concept` node (subtype `process` or `action`) whose own
 * `sectionPath` matches `sectionPath` exactly and whose extracted
 * content textually names the section heading itself (the last segment
 * of `sectionPath`) — i.e. the node that is, in effect, this section's
 * own title. Returns `undefined` (never a guess) when no such node
 * exists, which is common — see the package README.
 */
function findProcessConceptNodeId(graph: XoirGraph, sectionPath: readonly string[]): string | undefined {
  const heading = sectionPath[sectionPath.length - 1];
  if (heading === undefined) return undefined;
  const normalizedHeading = normalize(heading);
  if (normalizedHeading.length === 0) return undefined;

  for (const node of graph.allNodes()) {
    if (node.kind !== 'concept') continue;
    const subtype = node.metadata.subtype;
    if (subtype !== 'process' && subtype !== 'action') continue;
    const ownsSection = node.metadata.sourceRefs.some((r) => r.sectionPath !== undefined && r.sectionPath.length === sectionPath.length && r.sectionPath.every((seg, i) => seg === sectionPath[i]));
    if (!ownsSection) continue;
    const definition = node.properties['definition'];
    if (typeof definition !== 'string') continue;
    if (normalize(definition).includes(normalizedHeading) || normalizedHeading.includes(normalize(definition))) {
      return node.id;
    }
  }
  return undefined;
}

/**
 * Computes {@link ProcessGroupingEvidence} for one composed workflow's
 * capability nodes, or `undefined` when the steps don't share one exact
 * section path — see that type's doc comment for why this is
 * deliberately conservative (agreement-or-nothing, never a best guess).
 */
export function computeProcessGrouping(graph: XoirGraph, capabilityNodes: readonly XoirNode[]): ProcessGroupingEvidence | undefined {
  const sectionPath = sharedSectionPath(capabilityNodes);
  if (sectionPath === undefined) return undefined;
  const processConceptNodeId = findProcessConceptNodeId(graph, sectionPath);
  return {
    sectionPath,
    ...(processConceptNodeId !== undefined ? { processConceptNodeId } : {}),
    capabilityCount: capabilityNodes.length,
  };
}
