import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeGraphAdapter } from '../src/adapters/KnowledgeGraphAdapter.js';
import { CapabilityGraphAdapter } from '../src/adapters/CapabilityGraphAdapter.js';
import { IntentGraphAdapter } from '../src/adapters/IntentGraphAdapter.js';
import { WorkflowGraphAdapter } from '../src/adapters/WorkflowGraphAdapter.js';
import { PermissionGraphAdapter } from '../src/adapters/PermissionGraphAdapter.js';
import { ExecutionGraphAdapter, executionStateFromSource } from '../src/adapters/ExecutionGraphAdapter.js';
import { DependencyGraphAdapter } from '../src/adapters/DependencyGraphAdapter.js';

test('KnowledgeGraphAdapter converts entities/relations to a GraphModel', () => {
  const model = KnowledgeGraphAdapter.toGraphModel({
    entities: [
      { id: 'e1', label: 'Entity One', kind: 'entity' },
      { id: 'c1', label: 'Concept One', kind: 'concept', metadata: { source: 'wiki' } },
    ],
    relations: [{ id: 'r1', from: 'e1', to: 'c1', label: 'relates', type: 'relates_to' }],
  });
  assert.equal(model.nodeCount, 2);
  assert.equal(model.getNode('e1')!.type, 'entity');
  assert.equal(model.getNode('c1')!.type, 'concept');
  assert.equal(model.getEdge('r1')!.source, 'e1');
  assert.deepEqual(model.getNode('c1')!.metadata, { source: 'wiki' });
});

test('KnowledgeGraphAdapter defaults kind to entity', () => {
  const model = KnowledgeGraphAdapter.toGraphModel({ entities: [{ id: 'x', label: 'X' }], relations: [] });
  assert.equal(model.getNode('x')!.type, 'entity');
});

test('CapabilityGraphAdapter wires capability->action composed_of edges', () => {
  const model = CapabilityGraphAdapter.toGraphModel({
    capabilities: [{ id: 'cap1', label: 'Cap' }],
    actions: [
      { id: 'a1', label: 'Action 1', capabilityId: 'cap1' },
      { id: 'a2', label: 'Action 2', capabilityId: 'cap1' },
    ],
  });
  assert.equal(model.nodeCount, 3);
  assert.equal(model.edgeCount, 2);
  assert.ok(model.edges.every((e) => e.type === 'composed_of' && e.source === 'cap1'));
  assert.equal(model.getNode('a1')!.groupId, 'cap1');
});

test('IntentGraphAdapter marks required vs optional slots', () => {
  const model = IntentGraphAdapter.toGraphModel({
    intents: [{ id: 'i1', label: 'Intent' }],
    slots: [
      { id: 's1', label: 'Required Slot', intentId: 'i1', required: true },
      { id: 's2', label: 'Optional Slot', intentId: 'i1' },
    ],
  });
  const required = model.edges.find((e) => e.target === 's1')!;
  const optional = model.edges.find((e) => e.target === 's2')!;
  assert.equal(required.type, 'required_slot');
  assert.equal(optional.type, 'optional_slot');
});

test('WorkflowGraphAdapter preserves step kind and transition labels', () => {
  const model = WorkflowGraphAdapter.toGraphModel({
    steps: [
      { id: 'start', label: 'Start', kind: 'step' },
      { id: 'branch', label: 'Branch', kind: 'decision' },
    ],
    transitions: [{ id: 't1', from: 'start', to: 'branch', label: 'always' }],
  });
  assert.equal(model.getNode('branch')!.type, 'decision');
  assert.equal(model.getEdge('t1')!.label, 'always');
});

test('PermissionGraphAdapter converts roles/resources/grants', () => {
  const model = PermissionGraphAdapter.toGraphModel({
    roles: [{ id: 'role1', label: 'Admin' }],
    resources: [{ id: 'res1', label: 'Database' }],
    grants: [{ id: 'g1', roleId: 'role1', resourceId: 'res1', action: 'write' }],
  });
  assert.equal(model.getNode('role1')!.type, 'role');
  assert.equal(model.getNode('res1')!.type, 'resource');
  assert.equal(model.getEdge('g1')!.type, 'write');
});

test('ExecutionGraphAdapter converts nodes/edges and executionStateFromSource seeds status', () => {
  const source = {
    nodes: [
      { id: 'n1', label: 'Step 1' },
      { id: 'n2', label: 'Step 2' },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
    statuses: { n1: 'completed' as const, n2: 'active' as const },
  };
  const model = ExecutionGraphAdapter.toGraphModel(source);
  assert.equal(model.getNode('n1')!.type, 'task');
  const execution = executionStateFromSource(source);
  assert.equal(execution.statusOf('n1'), 'completed');
  assert.equal(execution.statusOf('n2'), 'active');
});

test('executionStateFromSource with no statuses returns idle state', () => {
  const execution = executionStateFromSource({ nodes: [], edges: [] });
  assert.equal(execution.statusOf('anything'), 'pending');
});

test('DependencyGraphAdapter labels packages with version and edges with range', () => {
  const model = DependencyGraphAdapter.toGraphModel({
    packages: [
      { id: 'pkg-a', label: 'pkg-a', version: '1.2.0' },
      { id: 'pkg-b', label: 'pkg-b' },
    ],
    dependencies: [{ id: 'd1', from: 'pkg-a', to: 'pkg-b', versionRange: '^1.0.0' }],
  });
  assert.equal(model.getNode('pkg-a')!.label, 'pkg-a@1.2.0');
  assert.equal(model.getNode('pkg-b')!.label, 'pkg-b');
  assert.equal(model.getEdge('d1')!.type, 'depends_on');
  assert.equal(model.getEdge('d1')!.label, '^1.0.0');
});

test('all adapters place nodes at the origin, deferring layout to GraphLayouts', () => {
  const model = KnowledgeGraphAdapter.toGraphModel({ entities: [{ id: 'x', label: 'X' }], relations: [] });
  assert.deepEqual(model.getNode('x')!.position, { x: 0, y: 0 });
});
