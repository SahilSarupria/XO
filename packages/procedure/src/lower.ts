import { brand } from '@xo/types';
import type { NodeId, WorkflowCondition, WorkflowEdge, WorkflowGraph, WorkflowNode } from '@xo/runtime';
import type { ProcedureCondition, ProcedureDefinition } from './definition.js';

const nid = (s: string): NodeId => brand<string, 'NodeId'>(s);

/**
 * `steps.<id>.output.<rest>` -> `<id>.<rest>` (the runtime stores a node's output at
 * `state.outputs[nodeId]`); `input.<rest>` is kept as-is — seeding `outputs.input` is an
 * M3 concern and is NOT claimed here.
 */
function lowerPath(path: string): string {
  const s = path.split('.');
  return s[0] === 'steps' ? [s[1], ...s.slice(3)].join('.') : path;
}

export function lowerCondition(c: ProcedureCondition): WorkflowCondition {
  return {
    kind: 'expression',
    field: lowerPath(c.path),
    operator: c.op,
    ...(Object.prototype.hasOwnProperty.call(c, 'value') ? { value: c.value } : {}),
  };
}

/**
 * Pure, in-memory lowering of an ALREADY VALIDATED definition. Nothing here executes.
 * Human-gate and effect semantics are intentionally NOT lowered: they come from the
 * server-resolved binding (M2+), never from client input (owner O-2).
 */
export function lowerToWorkflowGraph(def: ProcedureDefinition): WorkflowGraph {
  const hasIncoming = new Set<string>();
  for (const s of def.steps) {
    if (s.kind === 'decision') {
      hasIncoming.add(s.then);
      hasIncoming.add(s.else);
    } else if (s.next !== undefined) hasIncoming.add(s.next);
  }
  const entry = def.steps.find((s) => !hasIncoming.has(s.id));
  if (!entry) throw new TypeError('lowerToWorkflowGraph requires a validated definition');
  const nodes: WorkflowNode[] = [
    { id: nid('__start'), type: 'start' },
    { id: nid('__end'), type: 'end' },
  ];
  const edges: WorkflowEdge[] = [{ from: nid('__start'), to: nid(entry.id) }];
  for (const s of def.steps) {
    if (s.kind === 'capability') {
      nodes.push({ id: nid(s.id), type: 'capability', config: { capabilityId: s.capabilityId } });
      edges.push({ from: nid(s.id), to: nid(s.next ?? '__end') });
    } else {
      nodes.push({ id: nid(s.id), type: 'decision' });
      edges.push({ from: nid(s.id), to: nid(s.then), condition: lowerCondition(s.condition) });
      edges.push({ from: nid(s.id), to: nid(s.else) }); // unconditional fallback, declared after `then`
    }
  }
  return { graphId: def.procedureId, version: String(def.version), nodes, edges, startNodeId: nid('__start') };
}
