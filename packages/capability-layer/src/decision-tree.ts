import { assertExpressionParses, evaluateExpression, ExpressionError, MissingFactError, type Scope, type Value } from './expr.js';

/**
 * The `reasoning/decision_trees.json` format this layer can *execute*.
 *
 *   { "trees": [ { id, description, inputs[], start, nodes{} } ] }
 *
 * Node types:
 *   branch   { test: <expr>, then: <nodeId>, else: <nodeId>, rule? }
 *   compute  { set: { name: <expr>, ... }, next: <nodeId> }
 *   leaf     { output: { field: <literal | "=expr"> , ... }, rule? }
 *
 * A string output value starting with `=` is an expression; anything else is a
 * literal. The format is domain-agnostic: nothing here knows what a "claim" is.
 */

export interface TreeInput {
  readonly name: string;
  readonly type: 'number' | 'string' | 'boolean';
  readonly description: string;
  readonly enum?: readonly string[];
}

export type TreeNode =
  | {
      readonly type: 'branch';
      readonly test: string;
      readonly then: string;
      readonly else: string;
      readonly rule?: string;
      readonly note?: string;
    }
  | {
      readonly type: 'compute';
      readonly set: Readonly<Record<string, string>>;
      readonly next: string;
      readonly rule?: string;
      readonly note?: string;
    }
  | { readonly type: 'leaf'; readonly output: Readonly<Record<string, unknown>>; readonly rule?: string; readonly note?: string };

export interface DecisionTree {
  readonly id: string;
  readonly description: string;
  readonly inputs: readonly TreeInput[];
  readonly start: string;
  readonly nodes: Readonly<Record<string, TreeNode>>;
}

export interface TreeStep {
  readonly node: string;
  readonly rule?: string;
  readonly detail: string;
}

export type TreeEvaluation =
  | {
      readonly ok: true;
      readonly output: Readonly<Record<string, unknown>>;
      readonly rules: readonly string[];
      readonly trace: readonly TreeStep[];
    }
  | {
      readonly ok: false;
      readonly error: 'missing_facts';
      readonly missing: readonly { readonly name: string; readonly description: string }[];
    }
  | { readonly ok: false; readonly error: 'invalid_facts'; readonly problems: readonly string[] }
  | { readonly ok: false; readonly error: 'tree_error'; readonly message: string };

const MAX_STEPS = 64;

/** Returns the problems with a tree definition (empty = well-formed): dangling edges, bad syntax, unreachable start. */
export function validateTree(tree: DecisionTree): string[] {
  const problems: string[] = [];
  const nodes = tree.nodes;
  if (nodes[tree.start] === undefined) problems.push(`start node "${tree.start}" does not exist`);
  const edge = (from: string, to: string): void => {
    if (nodes[to] === undefined) problems.push(`${from} -> "${to}" does not exist`);
  };
  for (const [id, n] of Object.entries(nodes)) {
    try {
      if (n.type === 'branch') {
        assertExpressionParses(n.test);
        edge(id, n.then);
        edge(id, n.else);
      } else if (n.type === 'compute') {
        for (const e of Object.values(n.set)) assertExpressionParses(e);
        edge(id, n.next);
      } else if (n.type === 'leaf') {
        for (const v of Object.values(n.output)) if (typeof v === 'string' && v.startsWith('=')) assertExpressionParses(v.slice(1));
      } else {
        problems.push(`${id}: unknown node type`);
      }
    } catch (e) {
      problems.push(`${id}: ${(e as Error).message}`);
    }
  }
  return problems;
}

/** Narrow an unknown JSON value to a `DecisionTree` list if (and only if) it matches the executable format. */
export function parseTrees(json: unknown): DecisionTree[] | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const trees = (json as { trees?: unknown }).trees;
  if (!Array.isArray(trees)) return undefined;
  const out: DecisionTree[] = [];
  for (const t of trees) {
    if (typeof t !== 'object' || t === null) return undefined;
    const c = t as Partial<DecisionTree>;
    if (
      typeof c.id !== 'string' ||
      typeof c.start !== 'string' ||
      typeof c.nodes !== 'object' ||
      c.nodes === null ||
      !Array.isArray(c.inputs)
    )
      return undefined;
    const tree = c as DecisionTree;
    if (validateTree(tree).length > 0) return undefined;
    out.push(tree);
  }
  return out;
}

function checkFacts(tree: DecisionTree, facts: Readonly<Record<string, unknown>>): { scope: Scope; problems: string[] } {
  const scope: Record<string, Value> = {};
  const problems: string[] = [];
  const declared = new Map(tree.inputs.map((i) => [i.name, i] as const));
  for (const [name, raw] of Object.entries(facts)) {
    const decl = declared.get(name);
    if (decl === undefined) continue; // ignore undeclared extras rather than failing the call
    if (raw === null || raw === undefined) continue;
    if (decl.type === 'number') {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.replace(/[$,]/g, '')) : NaN;
      if (Number.isNaN(n)) problems.push(`${name}: expected a number, got ${JSON.stringify(raw)}`);
      else scope[name] = n;
    } else if (decl.type === 'boolean') {
      if (typeof raw === 'boolean') scope[name] = raw;
      else if (raw === 'true' || raw === 'false') scope[name] = raw === 'true';
      else problems.push(`${name}: expected true or false, got ${JSON.stringify(raw)}`);
    } else {
      const s = String(raw);
      if (decl.enum !== undefined && !decl.enum.includes(s))
        problems.push(`${name}: must be one of ${decl.enum.join(', ')}; got ${JSON.stringify(raw)}`);
      else scope[name] = s;
    }
  }
  return { scope, problems };
}

/** Deterministically walks `tree` over `facts`. Never throws; failures are structured so a model can repair its call. */
export function evaluateTree(tree: DecisionTree, facts: Readonly<Record<string, unknown>>): TreeEvaluation {
  const { scope: baseScope, problems } = checkFacts(tree, facts);
  if (problems.length > 0) return { ok: false, error: 'invalid_facts', problems };
  const scope: Record<string, Value | undefined> = { ...baseScope };
  const trace: TreeStep[] = [];
  const rules: string[] = [];
  let current = tree.start;
  try {
    for (let steps = 0; steps < MAX_STEPS; steps++) {
      const node = tree.nodes[current];
      if (node === undefined) return { ok: false, error: 'tree_error', message: `node "${current}" does not exist` };
      if (node.rule !== undefined && !rules.includes(node.rule)) rules.push(node.rule);
      if (node.type === 'branch') {
        const result = Boolean(evaluateExpression(node.test, scope));
        trace.push({
          node: current,
          ...(node.rule !== undefined ? { rule: node.rule } : {}),
          detail: `${node.note ?? node.test} → ${result}`,
        });
        current = result ? node.then : node.else;
      } else if (node.type === 'compute') {
        const parts: string[] = [];
        const computed: Record<string, Value> = {};
        for (const [name, expr] of Object.entries(node.set)) {
          const v = evaluateExpression(expr, { ...scope, ...computed });
          computed[name] = v;
          parts.push(`${name}=${typeof v === 'number' ? Math.round(v * 100) / 100 : String(v)}`);
        }
        Object.assign(scope, computed);
        trace.push({ node: current, detail: `${node.note ?? 'compute'}: ${parts.join(', ')}` });
        current = node.next;
      } else {
        const output: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(node.output)) {
          output[k] = typeof v === 'string' && v.startsWith('=') ? evaluateExpression(v.slice(1), scope) : v;
        }
        trace.push({ node: current, ...(node.rule !== undefined ? { rule: node.rule } : {}), detail: node.note ?? 'outcome' });
        return { ok: true, output, rules, trace };
      }
    }
    return { ok: false, error: 'tree_error', message: `exceeded ${MAX_STEPS} steps (cycle?)` };
  } catch (e) {
    if (e instanceof MissingFactError) {
      const decl = tree.inputs.find((i) => i.name === e.fact);
      return { ok: false, error: 'missing_facts', missing: [{ name: e.fact, description: decl?.description ?? '(not a declared input)' }] };
    }
    if (e instanceof ExpressionError) return { ok: false, error: 'tree_error', message: e.message };
    throw e;
  }
}
