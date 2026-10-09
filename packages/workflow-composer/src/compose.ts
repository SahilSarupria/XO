import { err, ok, type Result } from '@xo/types';
import { Sha256Hasher } from '@xo/crypto';
import type { XoirGraph, XoirNode, XoirNodeId } from '@xo/xoir';
import { toWorkflowEvidenceRef } from './types.js';
import type { CandidateWorkflow, CandidateWorkflowStep, CompositionOptions, StepPrecedenceRationale, WorkflowGap } from './types.js';
import { CandidateWorkflowId, CandidateWorkflowStepId } from './types.js';
import { getCapabilityDescription, getCapabilityName, getDeclaredDependencies, getEmbeddedContractId } from './capability-node.js';
import { deriveConflictPairs, derivePrecedenceFacts, type PrecedenceFact } from './precedence.js';
import { deterministicTopologicalOrder } from './toposort.js';
import { computeProcessGrouping } from './process-grouping.js';
import { WorkflowCompositionError } from './errors.js';

const hasher = new Sha256Hasher();

/** Resolves and validates the requested capability scope; defaults to every `capability`-kind node in the graph. */
function resolveScope(graph: XoirGraph, requested: readonly XoirNodeId[] | undefined): Result<readonly XoirNode[], WorkflowCompositionError> {
  if (requested === undefined) {
    return ok(graph.allNodes().filter((n) => n.kind === 'capability'));
  }
  const nodes: XoirNode[] = [];
  for (const id of requested) {
    const result = graph.getNode(id);
    if (!result.ok) {
      return err(new WorkflowCompositionError('CAPABILITY_NODE_NOT_FOUND', `Requested capability node "${id}" is not present in the supplied graph`, { id }));
    }
    if (result.value.kind !== 'capability') {
      return err(new WorkflowCompositionError('NODE_NOT_A_CAPABILITY', `Node "${id}" is a "${result.value.kind}" node, not a "capability" node`, { id, kind: result.value.kind }));
    }
    nodes.push(result.value);
  }
  return ok(nodes);
}

/** Returns true if a concept node represents an authoritative process or operational action concept, excluding non-process entity concepts (e.g. entity/technology/metric). */
function isProcessOrActionConceptNode(node: XoirNode): boolean {
  if (node.kind !== 'concept') return false;
  const subtype = node.metadata.subtype;
  if (subtype === 'entity' || subtype === 'technology' || subtype === 'metric') return false;
  return subtype === 'process' || subtype === 'action' || subtype === 'concept';
}

/** Extracts authoritative Process membership keys for a capability node (shared Process concept node or shared sectionPath fallback). */
function getProcessMembershipKeys(graph: XoirGraph, node: XoirNode): readonly string[] {
  const keys = new Set<string>();

  // 1. Process Concept Node via 2-hop graph connectivity (Capability -> Action/Concept -> PART_OF/REQUIRES/DEPENDS_ON -> Process Node)
  for (const edge of graph.allEdges()) {
    if (edge.fromId !== node.id) continue;
    const targetNode = graph.getNode(edge.toId);
    if (!targetNode.ok) continue;

    if (targetNode.value.kind === 'concept' && isProcessOrActionConceptNode(targetNode.value)) {
      if (targetNode.value.metadata.subtype === 'process') {
        keys.add(`process_node:${targetNode.value.id}`);
      }
      for (const pEdge of graph.allEdges()) {
        if (pEdge.fromId === targetNode.value.id && (pEdge.kind === 'PART_OF' || pEdge.kind === 'REQUIRES' || pEdge.kind === 'DEPENDS_ON')) {
          const procNode = graph.getNode(pEdge.toId);
          if (procNode.ok && isProcessOrActionConceptNode(procNode.value)) {
            keys.add(`process_node:${procNode.value.id}`);
          }
        }
      }
    }
  }

  // 2. Shared non-empty sectionPath fallback (used when no explicit process_node key was found, or to complement section grouping)
  if (keys.size === 0) {
    for (const ref of node.metadata.sourceRefs) {
      if (ref.sectionPath && ref.sectionPath.length > 0) {
        keys.add(`section:${ref.sectionPath.join(' > ')}`);
      }
    }
  }

  return [...keys];
}

/** Groups scoped capability ids into connected components using direct capability edges and authoritative Process membership evidence. */
function connectedComponents(graph: XoirGraph, scope: ReadonlySet<XoirNodeId>): readonly (readonly XoirNodeId[])[] {
  const adjacency = new Map<XoirNodeId, Set<XoirNodeId>>();
  for (const id of scope) adjacency.set(id, new Set());

  // 1. Direct or indirect capability-capability edges
  for (const edge of graph.allEdges()) {
    if (!scope.has(edge.fromId) || !scope.has(edge.toId)) continue;
    adjacency.get(edge.fromId)!.add(edge.toId);
    adjacency.get(edge.toId)!.add(edge.fromId);
  }

  // 2. Authoritative Process membership evidence
  const processGroups = new Map<string, XoirNodeId[]>();
  for (const id of scope) {
    const nodeRes = graph.getNode(id);
    if (!nodeRes.ok) continue;
    const procKeys = getProcessMembershipKeys(graph, nodeRes.value);
    for (const key of procKeys) {
      if (!processGroups.has(key)) processGroups.set(key, []);
      processGroups.get(key)!.push(id);
    }
  }

  for (const [, members] of processGroups) {
    for (let i = 0; i < members.length; i++) {
      const mI = members[i];
      if (mI === undefined) continue;
      for (let j = i + 1; j < members.length; j++) {
        const mJ = members[j];
        if (mJ === undefined) continue;
        adjacency.get(mI)?.add(mJ);
        adjacency.get(mJ)?.add(mI);
      }
    }
  }

  const visited = new Set<XoirNodeId>();
  const components: XoirNodeId[][] = [];
  for (const start of [...scope].sort()) {
    if (visited.has(start)) continue;
    const component: XoirNodeId[] = [];
    const stack: XoirNodeId[] = [start];
    visited.add(start);
    while (stack.length > 0) {
      const current = stack.pop()!;
      component.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        stack.push(neighbor);
      }
    }
    components.push(component);
  }
  return components;
}

function makeTieBreak(precedenceHint: readonly XoirNodeId[] | undefined): (ids: readonly XoirNodeId[]) => readonly XoirNodeId[] {
  const hintIndex = new Map<XoirNodeId, number>();
  (precedenceHint ?? []).forEach((id, index) => hintIndex.set(id, index));
  return (ids) =>
    [...ids].sort((a, b) => {
      const ha = hintIndex.get(a) ?? Number.POSITIVE_INFINITY;
      const hb = hintIndex.get(b) ?? Number.POSITIVE_INFINITY;
      if (ha !== hb) return ha - hb;
      return a < b ? -1 : a > b ? 1 : 0;
    });
}

function rationaleFor(capabilityId: XoirNodeId, facts: readonly PrecedenceFact[], ambiguousGroups: readonly (readonly XoirNodeId[])[]): StepPrecedenceRationale {
  const orderedAfter = facts
    .filter((f) => f.after === capabilityId)
    .map((f) => ({
      capabilityId: f.before,
      viaEdgeKind: f.viaEdgeKind,
      evidenceStrength: f.strength,
      explanation:
        f.strength === 'logical'
          ? `"${f.after}" is ordered after "${f.before}" via a ${f.viaEdgeKind} relationship`
          : `"${f.after}" is ordered after "${f.before}" based on source-derived sequence evidence (${f.viaEdgeKind}) — the source places these in this order, but this is not a proven logical dependency`,
    }));
  const tieBroken = ambiguousGroups.some((group) => group.includes(capabilityId));
  return { orderedAfter, tieBroken };
}

function computeWorkflowId(componentIds: readonly XoirNodeId[]): string {
  const digest = hasher.hash([...componentIds].sort().join('|'));
  return `wf_${digest.replace(/^sha256:/, '').slice(0, 16)}`;
}

function buildName(nodesByOrder: readonly XoirNode[]): string {
  const names = nodesByOrder.map(getCapabilityName);
  if (names.length === 0) return 'Empty candidate workflow';
  if (names.length <= 3) return names.join(' \u2192 ');
  return `${names.slice(0, 3).join(' \u2192 ')} \u2192 \u2026 (${names.length} steps)`;
}

function buildDescription(nodesByOrder: readonly XoirNode[], gaps: readonly WorkflowGap[]): string {
  const stepCount = nodesByOrder.length;
  const base = `Candidate workflow deterministically composed from ${stepCount} discovered capabilit${stepCount === 1 ? 'y' : 'ies'}.`;
  if (gaps.length === 0) return `${base} No ambiguities or conflicts were found among the composed capabilities.`;
  return `${base} ${gaps.length} unresolved gap${gaps.length === 1 ? '' : 's'} found — see this workflow's \`gaps\` field before treating the step order as final.`;
}

function composeOne(graph: XoirGraph, componentIds: readonly XoirNodeId[], nodesById: ReadonlyMap<XoirNodeId, XoirNode>, options: CompositionOptions): CandidateWorkflow {
  const scope = new Set(componentIds);
  const facts = derivePrecedenceFacts(graph, scope);
  const conflictPairs = deriveConflictPairs(graph, scope);
  const tieBreak = makeTieBreak(options.precedenceHint);
  const { order, ambiguousGroups, cyclicIds } = deterministicTopologicalOrder(componentIds, facts, tieBreak);

  const gaps: WorkflowGap[] = [];
  const minConfidence = options.minStepConfidence ?? 0;

  for (const group of ambiguousGroups) {
    if (group.length < 2) continue;
    gaps.push({
      kind: 'ambiguous_precedence',
      description: `No precedence relationship connects these ${group.length} capabilities; their relative order was assigned by a deterministic tie-break, not by evidence.`,
      involvedCapabilityIds: [...group],
    });
  }

  const sourceDerivedFacts = facts.filter((f) => f.strength === 'source_derived');
  if (sourceDerivedFacts.length > 0) {
    const involved = [...new Set(sourceDerivedFacts.flatMap((f) => [f.before, f.after]))];
    gaps.push({
      kind: 'source_derived_ordering',
      description: `${sourceDerivedFacts.length} step transition${sourceDerivedFacts.length === 1 ? '' : 's'} in this workflow ${sourceDerivedFacts.length === 1 ? 'is' : 'are'} ordered using Sequence Evidence (the source document's own procedural order), not a proven logical dependency — see each affected step's \`rationale.orderedAfter\` for which transitions this applies to before treating the full order as logically guaranteed.`,
      involvedCapabilityIds: involved,
    });
  }

  if (cyclicIds.length > 0) {
    gaps.push({
      kind: 'circular_dependency',
      description: `A precedence cycle was found among these capabilities; no valid dependency order exists for them, so they were placed last using a deterministic fallback.`,
      involvedCapabilityIds: [...cyclicIds],
    });
  }

  for (const [a, b] of conflictPairs) {
    gaps.push({
      kind: 'conflicting_capabilities',
      description: `"${a}" and "${b}" are marked as conflicting; including both in one workflow needs a human decision about which applies, or whether they must run in separate sessions.`,
      involvedCapabilityIds: [a, b],
    });
  }

  for (const id of componentIds) {
    const node = nodesById.get(id);
    if (!node) continue;
    const declared = getDeclaredDependencies(node);
    for (const depId of declared) {
      const depNodeId = depId as XoirNodeId;
      const hasMatchingFact = facts.some((f) => f.after === id && f.before === depNodeId);
      if (!scope.has(depNodeId) || !hasMatchingFact) {
        gaps.push({
          kind: 'declared_dependency_unresolved',
          description: scope.has(depNodeId)
            ? `Capability "${id}" declares a dependency on "${depId}" in its own properties, but no matching graph edge orders them; this workflow's order does not account for it.`
            : `Capability "${id}" declares a dependency on "${depId}", which is outside this composed set; that dependency could not be honored.`,
          involvedCapabilityIds: [id, depId],
        });
      }
    }
    if (node.metadata.confidence < minConfidence) {
      gaps.push({
        kind: 'low_confidence_capability',
        description: `Capability "${id}" has confidence ${node.metadata.confidence.toFixed(2)}, below the requested minimum of ${minConfidence.toFixed(2)}.`,
        involvedCapabilityIds: [id],
      });
    }
  }

  const nodesByOrder = order.map((id) => nodesById.get(id)).filter((n): n is XoirNode => n !== undefined);

  const steps: CandidateWorkflowStep[] = nodesByOrder.map((node, index) => {
    const contractId = getEmbeddedContractId(node);
    return {
      id: CandidateWorkflowStepId(`${node.id}#${index}`),
      order: index,
      capabilityId: node.id,
      capabilityName: getCapabilityName(node),
      description: getCapabilityDescription(node),
      rationale: rationaleFor(node.id, facts, ambiguousGroups),
      ...(contractId !== undefined ? { contractId } : {}),
      confidence: node.metadata.confidence,
      evidence: node.metadata.sourceRefs.map(toWorkflowEvidenceRef),
    };
  });

  const confidence = steps.length > 0 ? Math.min(...steps.map((s) => s.confidence)) : 0;
  const requiresHumanDecision = gaps.some((g) => g.kind === 'circular_dependency' || g.kind === 'conflicting_capabilities');
  const now = options.now ?? (() => new Date().toISOString());
  const processGrouping = computeProcessGrouping(graph, nodesByOrder);

  return {
    id: CandidateWorkflowId(computeWorkflowId(componentIds)),
    name: buildName(nodesByOrder),
    description: buildDescription(nodesByOrder, gaps),
    steps,
    sourceCapabilityIds: steps.map((s) => s.capabilityId),
    gaps,
    requiresHumanDecision,
    confidence,
    generatedAt: now(),
    ...(processGrouping !== undefined ? { processGrouping } : {}),
  };
}

/**
 * Composes one or more `CandidateWorkflow`s from capabilities already
 * present in `graph`. Never invents a capability, never renames or
 * re-ids one, and never executes anything — see the package README.
 *
 * Capabilities with no relationship (direct or transitive) to any other
 * capability in scope become their own single-step candidate workflow
 * rather than being folded into an unrelated one.
 */
export function composeWorkflows(graph: XoirGraph, options: CompositionOptions = {}): Result<readonly CandidateWorkflow[], WorkflowCompositionError> {
  const scopeResult = resolveScope(graph, options.capabilityNodeIds);
  if (!scopeResult.ok) return scopeResult;
  const scopedNodes = scopeResult.value;
  if (scopedNodes.length === 0) return ok([]);

  const nodesById = new Map<XoirNodeId, XoirNode>(scopedNodes.map((n) => [n.id, n]));
  const scopeIds = new Set(nodesById.keys());
  const components = connectedComponents(graph, scopeIds);

  const workflows = components.map((componentIds) => composeOne(graph, componentIds, nodesById, options));
  // Deterministic output order: by workflow id, not by incidental Map/Set iteration order.
  return ok([...workflows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
}
