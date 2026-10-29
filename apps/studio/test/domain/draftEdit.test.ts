import { describe, expect, it } from 'vitest';
import {
  branchTargets,
  canMove,
  insertNode,
  layoutDraft,
  moveNode,
  nextNodeId,
  removeNode,
  setBranchTarget,
  updateNode,
  whereAdd,
  type DraftGraph,
} from '../../src/domain/draftEdit';
import type { DraftNode } from '../../src/platform/wire-studio';

const n = (id: string, kind: DraftNode['kind'] = 'capability'): DraftNode => ({
  id,
  kind,
  config: kind === 'trigger' ? { type: 'manual' } : {},
});
const chain = (...ids: string[]): DraftGraph => ({
  nodes: ids.map((id, i) => n(id, i === 0 ? 'trigger' : 'capability')),
  edges: ids.slice(1).map((id, i) => ({ from: ids[i]!, to: id })),
});
const order = (g: DraftGraph): string[] => {
  const out: string[] = [];
  let cur = g.nodes.find((x) => x.kind === 'trigger')?.id;
  while (cur !== undefined && !out.includes(cur)) (out.push(cur), (cur = g.edges.find((e) => e.from === cur)?.to));
  return out;
};

describe('draft edit operations', () => {
  it('inserts after the selection and splices the chain; with nothing selected it appends', () => {
    const g = chain('t', 'a', 'b');
    expect(order(insertNode(g, n('x'), 'a'))).toEqual(['t', 'a', 'x', 'b']);
    expect(order(insertNode(g, n('x'), undefined))).toEqual(['t', 'a', 'b', 'x']);
    expect(order(insertNode(g, n('x'), 'b'))).toEqual(['t', 'a', 'b', 'x']);
    expect(nextNodeId(g.nodes)).toBe('n3');
    expect(nextNodeId([n('n3'), n('n0'), n('n1')])).toBe('n4');
  });

  it('removing a step in the middle keeps the chain connected; removing the end just drops it', () => {
    const g = chain('t', 'a', 'b', 'c');
    expect(order(removeNode(g, 'b'))).toEqual(['t', 'a', 'c']);
    expect(order(removeNode(g, 'c'))).toEqual(['t', 'a', 'b']);
    expect(removeNode(g, 'b').edges).toHaveLength(2);
    expect(removeNode(g, 'zzz')).toBe(g);
  });

  it('reorders steps in a straight run only', () => {
    const g = chain('t', 'a', 'b', 'c');
    expect(order(moveNode(g, 'b', 'earlier'))).toEqual(['t', 'b', 'a', 'c']);
    expect(order(moveNode(g, 'a', 'later'))).toEqual(['t', 'b', 'a', 'c']);
    expect(order(moveNode(g, 'b', 'later'))).toEqual(['t', 'a', 'c', 'b']);
    expect(canMove(g, 'a', 'earlier')).toMatchObject({ ok: false });
    expect(canMove(g, 'c', 'later')).toMatchObject({ ok: false, reason: 'This step is already last.' });
    expect(canMove(g, 't', 'later')).toMatchObject({ ok: false });
    expect(moveNode(g, 'a', 'earlier')).toBe(g);
  });

  it('a branch keeps the old successor on "at or above", then fills the missing side, then refuses', () => {
    let g = chain('t', 'a', 'b');
    g = insertNode(g, n('br', 'branch'), 'a');
    expect(g.edges).toContainEqual({ from: 'br', to: 'b', when: 'gte' });
    expect(g.edges).toContainEqual({ from: 'a', to: 'br' });
    expect(whereAdd(g, 'br')).toMatchObject({ ok: true, after: 'br', side: 'lt' });
    g = insertNode(g, n('low'), 'br');
    expect(g.edges).toContainEqual({ from: 'br', to: 'low', when: 'lt' });
    expect(whereAdd(g, 'br')).toMatchObject({ ok: false });
    expect(canMove(g, 'a', 'later')).toMatchObject({ ok: false });
  });

  it('branch sides can be re-pointed at nodes that are free and not upstream', () => {
    let g = chain('t', 'a');
    g = insertNode(g, n('br', 'branch'), 'a');
    g = insertNode(g, n('x'), 'br');
    g = insertNode(g, n('y'), 'br');
    expect(branchTargets(g, 'br', 'lt').map((x) => x.id)).toEqual(['y']);
    const free = { nodes: [...g.nodes, n('z')], edges: g.edges };
    expect(
      branchTargets(free, 'br', 'lt')
        .map((x) => x.id)
        .sort(),
    ).toEqual(['y', 'z']);
    expect(setBranchTarget(free, 'br', 'lt', 'z').edges).toContainEqual({ from: 'br', to: 'z', when: 'lt' });
    expect(setBranchTarget(free, 'br', 'lt', undefined).edges.some((e) => e.from === 'br' && e.when === 'lt')).toBe(false);
  });

  it('edits label and config without touching structure; blank label clears it', () => {
    const g = chain('t', 'a');
    const g2 = updateNode(g, 'a', { label: 'Check claim', config: { memoryScope: 'none' } });
    expect(g2.nodes[1]).toMatchObject({ label: 'Check claim', config: { memoryScope: 'none' } });
    expect(updateNode(g2, 'a', { label: '  ' }).nodes[1]).not.toHaveProperty('label');
    expect(g2.edges).toBe(g.edges);
  });

  it('a start can be added at the head of a graph that has none', () => {
    const g: DraftGraph = { nodes: [n('a'), n('b')], edges: [{ from: 'a', to: 'b' }] };
    expect(order(insertNode(g, n('t', 'trigger'), undefined))).toEqual(['t', 'a', 'b']);
  });

  it('lays out columns by depth and puts branch sides on separate rows, nothing overlapping', () => {
    let g = chain('t', 'a');
    g = insertNode(g, n('br', 'branch'), 'a');
    g = insertNode(g, n('hi'), 'br');
    g = insertNode(g, n('lo'), 'br');
    const l = layoutDraft(g);
    const pos = (id: string) => l.nodes.find((p) => p.node.id === id)!;
    expect(pos('a').x).toBeGreaterThan(pos('t').x);
    expect(pos('hi').x).toBe(pos('lo').x);
    expect(pos('hi').y).toBeLessThan(pos('lo').y);
    expect(new Set(l.nodes.map((p) => `${p.x}:${p.y}`)).size).toBe(l.nodes.length);
    expect(l.edges.filter((e) => e.when !== undefined)).toHaveLength(2);
    expect(layoutDraft({ nodes: [], edges: [] }).nodes).toEqual([]);
  });
});
