import { describe, expect, it } from 'vitest';
import {
  clearPositions,
  connect,
  disconnect,
  insertNode,
  insertOnEdge,
  MAX_COORD,
  openOutputs,
  setPosition,
  type DraftGraph,
} from '../../src/domain/draftEdit';
import { FLOW_BRANCH_H, FLOW_NODE_H, FLOW_NODE_W, curve, layoutFlow } from '../../src/domain/flowLayout';
import type { DraftNode } from '../../src/platform/wire-studio';

const n = (id: string, kind: DraftNode['kind'] = 'capability'): DraftNode => ({ id, kind, config: {} });
const chain = (...ids: string[]): DraftGraph => ({
  nodes: ids.map((id, i) => n(id, i === 0 ? 'trigger' : 'capability')),
  edges: ids.slice(1).map((id, i) => ({ from: ids[i]!, to: id })),
});
const pairs = (g: DraftGraph) => g.edges.map((e) => `${e.from}>${e.to}${e.when ?? ''}`).sort();

describe('insertOnEdge', () => {
  it('splices a step into the middle of a connection and keeps the chain joined', () => {
    const g = insertOnEdge(chain('t', 'a', 'b'), n('x'), 'a');
    expect(pairs(g)).toEqual(['a>x', 't>a', 'x>b']);
  });

  it('attaches to the end of a chain when nothing follows', () => {
    expect(pairs(insertOnEdge(chain('t', 'a'), n('x'), 'a'))).toEqual(['a>x', 't>a']);
  });

  it('inserts on one side of a branch without touching the other', () => {
    let g = insertNode(chain('t', 'a'), n('br', 'branch'), 'a');
    g = insertOnEdge(g, n('hi'), 'br', 'gte');
    g = insertOnEdge(g, n('lo'), 'br', 'lt');
    const mid = insertOnEdge(g, n('mid'), 'br', 'lt');
    expect(pairs(mid)).toEqual(['a>br', 'br>hi' + 'gte', 'br>mid' + 'lt', 'mid>lo', 't>a']);
  });

  it('a new branch keeps the old successor on its at-or-above side', () => {
    const g = insertOnEdge(chain('t', 'a', 'b'), n('br', 'branch'), 'a');
    expect(pairs(g)).toEqual(['a>br', 'br>bgte', 't>a']);
  });

  it('refuses shapes only a branch may have, and unknown sources', () => {
    const g = chain('t', 'a');
    expect(insertOnEdge(g, n('x'), 'a', 'gte')).toBe(g);
    expect(insertOnEdge(g, n('x'), 'nope')).toBe(g);
    const withBranch = insertNode(g, n('br', 'branch'), 'a');
    expect(insertOnEdge(withBranch, n('x'), 'br')).toBe(withBranch);
  });
});

describe('openOutputs', () => {
  it('reports the dangling end of a chain and the empty sides of a branch', () => {
    const g = chain('t', 'a');
    expect(openOutputs(g, 'a')).toEqual([undefined]);
    expect(openOutputs(g, 't')).toEqual([]);
    const b = insertNode(g, n('br', 'branch'), 'a');
    expect(openOutputs(b, 'br')).toEqual(['gte', 'lt']);
    expect(openOutputs(insertOnEdge(b, n('hi'), 'br', 'gte'), 'br')).toEqual(['lt']);
    expect(openOutputs(g, 'missing')).toEqual([]);
  });
});

describe('layoutFlow', () => {
  it('is empty for an empty graph', () => {
    expect(layoutFlow({ nodes: [], edges: [] })).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });

  it('puts a straight chain on one row, left to right, with ports on the facing sides', () => {
    const l = layoutFlow(chain('t', 'a', 'b'));
    const at = (id: string) => l.nodes.find((p) => p.node.id === id)!;
    expect(at('a').x).toBeGreaterThan(at('t').x + FLOW_NODE_W);
    expect(at('t').y).toBe(at('b').y);
    expect(at('t').outputs[0]!.x).toBe(at('t').x + FLOW_NODE_W);
    expect(at('a').input).toEqual({ x: at('a').x, y: at('a').y + FLOW_NODE_H / 2 });
    expect(l.edges).toHaveLength(2);
    expect(l.edges[0]!.path.startsWith(`M ${at('t').outputs[0]!.x} `)).toBe(true);
  });

  it('gives a branch two labelled outputs and puts its sides on separate, non-overlapping rows', () => {
    let g = insertNode(chain('t', 'a'), n('br', 'branch'), 'a');
    g = insertOnEdge(g, n('hi'), 'br', 'gte');
    g = insertOnEdge(g, n('lo'), 'br', 'lt');
    const l = layoutFlow(g);
    const at = (id: string) => l.nodes.find((p) => p.node.id === id)!;
    expect(at('br').h).toBe(FLOW_BRANCH_H);
    expect(at('br').outputs.map((p) => p.side)).toEqual(['gte', 'lt']);
    expect(at('hi').x).toBe(at('lo').x);
    expect(at('hi').y + at('hi').h).toBeLessThan(at('lo').y);
    // Each side leaves from its own port.
    const hi = l.edges.find((e) => e.to === 'hi')!;
    const lo = l.edges.find((e) => e.to === 'lo')!;
    expect(hi.path.startsWith(`M ${at('br').outputs[0]!.x} ${at('br').outputs[0]!.y} `)).toBe(true);
    expect(lo.path.startsWith(`M ${at('br').outputs[1]!.x} ${at('br').outputs[1]!.y} `)).toBe(true);
    // No two nodes overlap, and everything fits inside the reported size.
    for (const a of l.nodes) {
      expect(a.x + a.w).toBeLessThanOrEqual(l.width);
      expect(a.y + a.h).toBeLessThanOrEqual(l.height);
      for (const b of l.nodes) if (a !== b) expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
    }
  });

  it('keeps a node that nothing connects to visible on its own row', () => {
    const g: DraftGraph = { nodes: [n('t', 'trigger'), n('a'), n('lonely')], edges: [{ from: 't', to: 'a' }] };
    const l = layoutFlow(g);
    const lonely = l.nodes.find((p) => p.node.id === 'lonely')!;
    expect(l.nodes.filter((p) => p.y === lonely.y)).toHaveLength(1);
  });

  it('survives a loop without recursing forever', () => {
    const g: DraftGraph = {
      nodes: [n('a'), n('b')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    };
    expect(layoutFlow(g).nodes).toHaveLength(2);
  });

  it('draws a backwards connection as a loop, not a straight line through the node', () => {
    expect(curve({ x: 300, y: 100 }, { x: 40, y: 100 })).toContain(' S ');
    expect(curve({ x: 100, y: 100 }, { x: 400, y: 200 })).not.toContain(' S ');
  });
});

describe('connect and disconnect', () => {
  it('points a step at another, replacing what its output led to before', () => {
    const g = chain('t', 'a', 'b');
    expect(pairs(connect(g, 't', 'b'))).toEqual(['a>b', 't>b']);
  });

  it('connects the two sides of a branch independently, and only with a side', () => {
    let g = insertNode(chain('t', 'a'), n('br', 'branch'), 'a');
    g = { ...g, nodes: [...g.nodes, n('x'), n('y')] };
    g = connect(connect(g, 'br', 'x', 'gte'), 'br', 'y', 'lt');
    expect(pairs(g)).toEqual(['a>br', 'br>xgte', 'br>ylt', 't>a']);
    expect(connect(g, 'br', 'x')).toBe(g);
    expect(connect(chain('t', 'a'), 't', 'a', 'gte')).toEqual(chain('t', 'a'));
  });

  it('ignores a connection to itself, to an unknown step, or one that already exists', () => {
    const g = chain('t', 'a');
    expect(connect(g, 'a', 'a')).toBe(g);
    expect(connect(g, 'a', 'nope')).toBe(g);
    expect(connect(g, 'nope', 'a')).toBe(g);
    expect(connect(g, 't', 'a')).toBe(g);
  });

  it('removes only the line, leaving both steps', () => {
    const g = disconnect(chain('t', 'a', 'b'), 'a', 'b');
    expect(pairs(g)).toEqual(['t>a']);
    expect(g.nodes).toHaveLength(3);
    const same = chain('t', 'a');
    expect(disconnect(same, 'a', 't')).toBe(same);
  });
});

describe('positions', () => {
  it('pins a step, rounded and kept inside the platform bounds, and leaves the rest alone', () => {
    const g = chain('t', 'a');
    const p = setPosition(g, 'a', 100.6, -20);
    expect(p.nodes.find((x) => x.id === 'a')?.position).toEqual({ x: 101, y: 0 });
    expect(p.nodes.find((x) => x.id === 't')?.position).toBeUndefined();
    expect(setPosition(g, 'a', 1e9, 5).nodes[1]?.position).toEqual({ x: MAX_COORD, y: 5 });
    expect(setPosition(g, 'nope', 1, 1)).toBe(g);
    expect(setPosition(p, 'a', 101, 0)).toBe(p);
  });

  it('draws a pinned step exactly where it was placed, with its ports and connections following it', () => {
    const g = setPosition(chain('t', 'a', 'b'), 'a', 600, 300);
    const l = layoutFlow(g);
    const a = l.nodes.find((p) => p.node.id === 'a')!;
    expect([a.x, a.y]).toEqual([600, 300]);
    expect(a.input).toEqual({ x: 600, y: 300 + FLOW_NODE_H / 2 });
    const into = l.edges.find((e) => e.to === 'a')!;
    expect(into.path.endsWith(`${a.input.x} ${a.input.y}`)).toBe(true);
    // The drawing grows to hold it.
    expect(l.width).toBeGreaterThanOrEqual(600 + FLOW_NODE_W);
    expect(l.height).toBeGreaterThanOrEqual(300 + FLOW_NODE_H);
  });

  it('forgets every pinned position, returning the same automatic drawing', () => {
    const g = chain('t', 'a', 'b');
    const pinned = setPosition(setPosition(g, 'a', 500, 40), 'b', 900, 400);
    const back = clearPositions(pinned);
    expect(back.nodes.every((x) => x.position === undefined)).toBe(true);
    expect(layoutFlow(back)).toEqual(layoutFlow(g));
    expect(clearPositions(g)).toBe(g);
  });
});
