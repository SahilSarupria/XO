import type { GraphModel } from '../model/GraphModel.js';
import { GraphSelection } from './GraphSelection.js';
import type { GraphExecutionState } from '../execution/GraphExecutionState.js';
import type { GroupId, NodeId } from '../model/types.js';

/**
 * Graph-aware selection algorithms layered on top of GraphSelection +
 * GraphModel connectivity. Every function here is pure: (model, ...) ->
 * new GraphSelection (or NodeId[]) — nothing is mutated, and there's no
 * hidden traversal state carried between calls.
 */
export class SmartSelection {
  /** All nodes reachable from `seedId` ignoring edge direction (the connected component containing it). */
  static connectedComponent(model: GraphModel, seedId: NodeId): readonly NodeId[] {
    if (!model.getNode(seedId)) return [];
    const visited = new Set<NodeId>([seedId]);
    const queue: NodeId[] = [seedId];
    let i = 0;
    while (i < queue.length) {
      const current = queue[i++] as NodeId;
      for (const neighbor of model.neighborsOf(current)) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
    return [...visited];
  }

  /** All nodes that can reach `seedId` by following edges forward (ancestors — "what feeds into this"). */
  static upstream(model: GraphModel, seedId: NodeId): readonly NodeId[] {
    const incomingOf = new Map<NodeId, NodeId[]>();
    for (const edge of model.edges) {
      if (!incomingOf.has(edge.target)) incomingOf.set(edge.target, []);
      incomingOf.get(edge.target)!.push(edge.source);
    }
    const visited = new Set<NodeId>();
    const queue: NodeId[] = [seedId];
    let i = 0;
    while (i < queue.length) {
      const current = queue[i++] as NodeId;
      for (const parent of incomingOf.get(current) ?? []) {
        if (visited.has(parent)) continue;
        visited.add(parent);
        queue.push(parent);
      }
    }
    return [...visited];
  }

  /** All nodes reachable forward from `seedId` (descendants — "what this feeds into"). Also serves as the dependency chain / downstream impact set. */
  static downstream(model: GraphModel, seedId: NodeId): readonly NodeId[] {
    const outgoingOf = new Map<NodeId, NodeId[]>();
    for (const edge of model.edges) {
      if (!outgoingOf.has(edge.source)) outgoingOf.set(edge.source, []);
      outgoingOf.get(edge.source)!.push(edge.target);
    }
    const visited = new Set<NodeId>();
    const queue: NodeId[] = [seedId];
    let i = 0;
    while (i < queue.length) {
      const current = queue[i++] as NodeId;
      for (const child of outgoingOf.get(current) ?? []) {
        if (visited.has(child)) continue;
        visited.add(child);
        queue.push(child);
      }
    }
    return [...visited];
  }

  /** Alias of downstream — the set of nodes that transitively depend on `seedId`. */
  static dependencyChain(model: GraphModel, seedId: NodeId): readonly NodeId[] {
    return SmartSelection.downstream(model, seedId);
  }

  /** The nodes on a GraphExecutionState's recorded execution path, in traversal order. */
  static executionPath(execution: GraphExecutionState): readonly NodeId[] {
    return execution.path;
  }

  /** All descendants of a group (its direct members plus, if `nested` groups reference it via parentGroupId, their members too). */
  static hierarchy(model: GraphModel, groupId: GroupId): readonly NodeId[] {
    const childGroupIds = new Set<GroupId>([groupId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const group of model.nodeGroups) {
        if (group.parentGroupId && childGroupIds.has(group.parentGroupId) && !childGroupIds.has(group.id)) {
          childGroupIds.add(group.id);
          grew = true;
        }
      }
    }
    const ids = new Set<NodeId>();
    for (const group of model.nodeGroups) {
      if (!childGroupIds.has(group.id)) continue;
      for (const id of group.nodeIds) ids.add(id);
    }
    for (const node of model.nodes) if (node.groupId && childGroupIds.has(node.groupId)) ids.add(node.id);
    return [...ids];
  }

  /** All members of a single group (flat, no nesting). */
  static group(model: GraphModel, groupId: GroupId): readonly NodeId[] {
    const explicit = model.getNodeGroup(groupId)?.nodeIds ?? [];
    const viaField = model.nodes.filter((n) => n.groupId === groupId).map((n) => n.id);
    return [...new Set([...explicit, ...viaField])];
  }

  /** Range selection between two nodes, using the model's deterministic node order (like shift-click in a list). */
  static range(model: GraphModel, fromId: NodeId, toId: NodeId): readonly NodeId[] {
    const order = model.nodes.map((n) => n.id);
    const fromIndex = order.indexOf(fromId);
    const toIndex = order.indexOf(toId);
    if (fromIndex === -1 || toIndex === -1) return [];
    const [lo, hi] = fromIndex <= toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
    return order.slice(lo, hi + 1);
  }

  /** Every visible node NOT currently selected. */
  static invert(model: GraphModel, selection: GraphSelection): GraphSelection {
    const selected = selection.state.nodeIds;
    const inverted = model.nodes.map((n) => n.id).filter((id) => !selected.has(id));
    return GraphSelection.empty().selectNodes(inverted);
  }

  /** Grows the selection by one hop: adds every direct neighbor of every currently-selected node. */
  static expand(model: GraphModel, selection: GraphSelection): GraphSelection {
    const grown = new Set<NodeId>(selection.state.nodeIds);
    for (const id of selection.state.nodeIds) {
      for (const neighbor of model.neighborsOf(id)) grown.add(neighbor);
    }
    return GraphSelection.empty().selectNodes([...grown]);
  }

  /** Shrinks the selection to only nodes all of whose neighbors are also selected (the "interior" of the current selection). */
  static contract(model: GraphModel, selection: GraphSelection): GraphSelection {
    const selected = selection.state.nodeIds;
    const interior = [...selected].filter((id) => model.neighborsOf(id).every((n) => selected.has(n)));
    return GraphSelection.empty().selectNodes(interior);
  }
}
