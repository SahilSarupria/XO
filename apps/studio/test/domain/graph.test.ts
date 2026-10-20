import { describe, expect, it } from 'vitest';
import { COLUMNS, formatOutput, layoutGraph, NODE_H, NODE_W, workflowStatus } from '../../src/domain/graph';
import type { Capability, WorkflowStepSummary } from '../../src/platform/wire';
import { cap } from '../fixtures';

const step = (order: number, capabilityId = `c${order}`): WorkflowStepSummary => ({ order, capabilityId, name: `Step ${order}`, description: '' });

describe('layoutGraph', () => {
  it('draws the steps in the platform order, one edge between each neighbour', () => {
    const g = layoutGraph([step(2), step(0), step(1)], undefined);
    expect(g.nodes.map((n) => n.name)).toEqual(['Step 0', 'Step 1', 'Step 2']);
    expect(g.edges).toHaveLength(2);
    expect(g.edges[0]).toMatchObject({ from: g.nodes[0]!.id, to: g.nodes[1]!.id });
  });

  it('marks a step as a person-decides step only from its own execution class', () => {
    const caps: Capability[] = [cap({ capabilityId: 'c0', executionClass: 'deterministic_rule' }), cap({ capabilityId: 'c1', executionClass: 'human_in_the_loop' })];
    const g = layoutGraph([step(0), step(1)], caps);
    expect(g.nodes.map((n) => n.kind)).toEqual(['capability', 'human']);
    expect(layoutGraph([step(0)], undefined).nodes[0]!.kind).toBe('capability'); // capabilities not loaded: no claim
  });

  it('never places two nodes on top of each other, and wraps long processes onto new rows', () => {
    const g = layoutGraph(Array.from({ length: COLUMNS + 2 }, (_, i) => step(i)), undefined);
    const keys = new Set(g.nodes.map((n) => `${n.x},${n.y}`));
    expect(keys.size).toBe(g.nodes.length);
    expect(g.nodes[COLUMNS]!.y).toBeGreaterThan(g.nodes[0]!.y);
    expect(g.nodes[COLUMNS]!.x).toBe(g.nodes[0]!.x);
    for (const n of g.nodes) {
      expect(n.x + NODE_W).toBeLessThanOrEqual(g.width);
      expect(n.y + NODE_H).toBeLessThanOrEqual(g.height);
    }
  });

  it('an empty process has no nodes and no edges', () => {
    const g = layoutGraph([], undefined);
    expect(g.nodes).toHaveLength(0);
    expect(g.edges).toHaveLength(0);
  });
});

describe('workflowStatus', () => {
  it('reports exactly what the readiness facts say', () => {
    expect(workflowStatus({ executable: false, needApproval: 0, canStart: false, activeLabel: undefined }).label).toBe('Cannot run yet');
    expect(workflowStatus({ executable: true, needApproval: 2, canStart: false, activeLabel: undefined }).label).toBe('Needs approval');
    expect(workflowStatus({ executable: true, needApproval: 0, canStart: true, activeLabel: undefined })).toEqual({ label: 'Ready', tone: 'success' });
    expect(workflowStatus({ executable: true, needApproval: 0, canStart: true, activeLabel: 'Running' }).label).toBe('Running');
  });
});

describe('formatOutput', () => {
  it('pretty-prints JSON and truncates very long output', () => {
    expect(formatOutput({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatOutput('x'.repeat(2000), 100).length).toBeLessThan(105);
    expect(formatOutput(undefined)).toBe('undefined');
  });
});
