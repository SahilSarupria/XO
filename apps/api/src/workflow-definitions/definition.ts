import { ErrorCode, XoError } from '@xo/errors';

/**
 * User-authored workflow graphs (what the Studio editor saves): triggers, XO-capability steps, a confidence branch,
 * human review, and actions. This is a DEFINITION store with validation; execution lives in
 * `workflows/draft-runner.ts` and is documented in docs/studio/DRAFT_EXECUTION.md.
 *
 * Honest status: only a narrow shape runs (manual trigger, capability steps from one succeeded compilation, an
 * optional confidence branch, a human review directly after a human-in-the-loop capability). `analyzeDefinition`
 * reports `runnable: true` only when the platform's own facts say the draft is that shape and every capability
 * binds; everything else keeps concrete `blockers` and the Run endpoint answers 501 with them.
 */

export const NODE_KINDS = ['trigger', 'compile', 'validate', 'capability', 'branch', 'human_review', 'action'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const TRIGGER_TYPES = ['manual', 'document_dropped', 'schedule'] as const;
export const ACTION_TYPES = ['webhook', 'email'] as const;
export const MEMORY_SCOPES = ['none', 'workflow', 'workspace'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export interface DefinitionNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly label?: string;
  /** Kind-specific, validated per kind in `validateDefinition`. Never executed or interpolated. */
  readonly config: Readonly<Record<string, unknown>>;
}

export interface DefinitionEdge {
  readonly from: string;
  readonly to: string;
  /** Required on both outgoing edges of a `branch` node: which side of the threshold this edge takes. */
  readonly when?: 'gte' | 'lt';
}

export interface WorkflowDefinition {
  readonly definitionId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly status: 'draft';
  readonly revision: number;
  readonly nodes: readonly DefinitionNode[];
  readonly edges: readonly DefinitionEdge[];
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface DefinitionInput {
  readonly name: string;
  readonly nodes: readonly DefinitionNode[];
  readonly edges: readonly DefinitionEdge[];
}

export const MAX_NODES = 50;
export const MAX_EDGES = 100;
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function bad(message: string): never {
  throw new XoError(ErrorCode.INVALID_ARGUMENT, message);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) bad(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function str(o: Record<string, unknown>, key: string, where: string, max = 200): string {
  const v = o[key];
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > max)
    bad(`${where}.${key} must be a non-empty string of at most ${max} characters`);
  return v.trim();
}

/** Parses an untrusted body into a structurally valid input (shapes, sizes, enums). Graph-level checks are `analyzeDefinition`. */
export function parseDefinitionInput(body: unknown): DefinitionInput {
  const o = record(body, 'body');
  for (const k of Object.keys(o)) if (!['name', 'nodes', 'edges', 'expectedRevision'].includes(k)) bad(`unknown field "${k}"`);
  const name = str(o, 'name', 'body', 120);
  if (!Array.isArray(o['nodes']) || o['nodes'].length === 0 || o['nodes'].length > MAX_NODES)
    bad(`"nodes" must be an array of 1-${MAX_NODES} nodes`);
  if (!Array.isArray(o['edges']) || o['edges'].length > MAX_EDGES) bad(`"edges" must be an array of at most ${MAX_EDGES} edges`);

  const seen = new Set<string>();
  const nodes: DefinitionNode[] = (o['nodes'] as unknown[]).map((raw, i) => {
    const n = record(raw, `nodes[${i}]`);
    for (const k of Object.keys(n)) if (!['id', 'kind', 'label', 'config'].includes(k)) bad(`nodes[${i}]: unknown field "${k}"`);
    const id = n['id'];
    if (typeof id !== 'string' || !ID.test(id)) bad(`nodes[${i}].id must match ${ID}`);
    if (seen.has(id)) bad(`duplicate node id "${id}"`);
    seen.add(id);
    const kind = n['kind'];
    if (typeof kind !== 'string' || !(NODE_KINDS as readonly string[]).includes(kind))
      bad(`nodes[${i}].kind must be one of: ${NODE_KINDS.join(', ')}`);
    const config = n['config'] === undefined ? {} : record(n['config'], `nodes[${i}].config`);
    if (JSON.stringify(config).length > 4000) bad(`nodes[${i}].config is too large`);
    const label = n['label'] === undefined ? undefined : str(n, 'label', `nodes[${i}]`, 120);
    return {
      id,
      kind: kind as NodeKind,
      ...(label !== undefined ? { label } : {}),
      config: validateConfig(kind as NodeKind, config, `nodes[${i}]`),
    };
  });

  const edges: DefinitionEdge[] = (o['edges'] as unknown[]).map((raw, i) => {
    const e = record(raw, `edges[${i}]`);
    for (const k of Object.keys(e)) if (!['from', 'to', 'when'].includes(k)) bad(`edges[${i}]: unknown field "${k}"`);
    const from = str(e, 'from', `edges[${i}]`, 64);
    const to = str(e, 'to', `edges[${i}]`, 64);
    if (!seen.has(from) || !seen.has(to)) bad(`edges[${i}] refers to an unknown node`);
    if (from === to) bad(`edges[${i}] connects a node to itself`);
    const when = e['when'];
    if (when !== undefined && when !== 'gte' && when !== 'lt') bad(`edges[${i}].when must be "gte" or "lt"`);
    return { from, to, ...(when !== undefined ? { when } : {}) };
  });
  return { name, nodes, edges };
}

function validateConfig(kind: NodeKind, c: Record<string, unknown>, where: string): Record<string, unknown> {
  const only = (allowed: readonly string[]) => {
    for (const k of Object.keys(c)) if (!allowed.includes(k)) bad(`${where}.config: unknown field "${k}" for a ${kind} node`);
  };
  switch (kind) {
    case 'trigger': {
      only(['type']);
      const type = c['type'];
      if (typeof type !== 'string' || !(TRIGGER_TYPES as readonly string[]).includes(type))
        bad(`${where}.config.type must be one of: ${TRIGGER_TYPES.join(', ')}`);
      return { type };
    }
    case 'capability': {
      only(['packageName', 'capabilityId', 'memoryScope', 'compilationId']);
      const memoryScope = c['memoryScope'] ?? 'none';
      if (typeof memoryScope !== 'string' || !(MEMORY_SCOPES as readonly string[]).includes(memoryScope))
        bad(`${where}.config.memoryScope must be one of: ${MEMORY_SCOPES.join(', ')}`);
      return {
        packageName: str(c, 'packageName', `${where}.config`, 200),
        capabilityId: str(c, 'capabilityId', `${where}.config`, 200),
        memoryScope,
        ...(c['compilationId'] !== undefined ? { compilationId: str(c, 'compilationId', `${where}.config`, 200) } : {}),
      };
    }
    case 'branch': {
      only(['metric', 'threshold']);
      if (c['metric'] !== 'confidence') bad(`${where}.config.metric must be "confidence" (the only branch metric the platform produces)`);
      const t = c['threshold'];
      if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 1) bad(`${where}.config.threshold must be a number from 0 to 1`);
      return { metric: 'confidence', threshold: t };
    }
    case 'action': {
      only(['type']);
      const type = c['type'];
      if (typeof type !== 'string' || !(ACTION_TYPES as readonly string[]).includes(type))
        bad(`${where}.config.type must be one of: ${ACTION_TYPES.join(', ')}`);
      return { type };
    }
    case 'compile':
    case 'validate':
    case 'human_review':
      only([]);
      return {};
  }
}

export interface DefinitionIssue {
  readonly severity: 'error' | 'blocker';
  readonly nodeId?: string;
  readonly message: string;
}

/** What the platform knows about one capability of a stored compilation. Supplied by the caller; never client input. */
export interface CapabilityFact {
  readonly name: string;
  /** The capability's declared (compile-time) contract confidence. Static: it is not measured per run. */
  readonly confidence: number;
  readonly executionClass?: 'deterministic_rule' | 'human_in_the_loop';
  /** Present when the runtime bridge could not bind the capability to an executable binding. */
  readonly unbound?: string;
  /** Approved in this workspace right now (informational for the plan; the run itself re-checks it). */
  readonly approved: boolean;
}
export type CompilationFacts =
  { readonly ok: true; readonly capabilities: ReadonlyMap<string, CapabilityFact> } | { readonly ok: false; readonly reason: string };
/** compilationId -> facts. A compilation id missing from the map is reported as unknown. */
export type DraftFacts = ReadonlyMap<string, CompilationFacts>;

export interface DraftPlanStep {
  readonly nodeId: string;
  readonly capabilityId: string;
  readonly name: string;
  readonly executionClass: 'deterministic_rule' | 'human_in_the_loop';
  readonly approved: boolean;
}
export interface DraftPlanBranch {
  readonly nodeId: string;
  readonly metric: 'confidence';
  /** Always the upstream capability's DECLARED contract confidence, not a measured per-run value. */
  readonly basis: 'declared_contract_confidence';
  readonly capabilityId: string;
  readonly value: number;
  readonly threshold: number;
  readonly taken: 'gte' | 'lt';
}
/** The single path a run of this draft takes, derived from the stored compilation. Present only when it could be resolved. */
export interface DraftPlan {
  readonly compilationId: string;
  readonly path: readonly string[];
  readonly steps: readonly DraftPlanStep[];
  readonly branches: readonly DraftPlanBranch[];
}

export interface DefinitionAnalysis {
  /** Structural problems: the graph is not a well-formed workflow. A definition with errors can still be saved as a draft; it can never run. */
  readonly errors: readonly DefinitionIssue[];
  /** Reasons a structurally valid graph still cannot run on THIS server. */
  readonly blockers: readonly DefinitionIssue[];
  readonly wellFormed: boolean;
  /** True only when the draft is well formed, has no blockers, and its plan resolved. Never inferred from the editor. */
  readonly runnable: boolean;
  readonly plan?: DraftPlan;
}

export const SUPPORTED_NODE_KINDS = ['trigger', 'capability', 'branch', 'human_review'] as const;

/** Graph-level checks. Pure; the same input and facts always give the same report. */
export function analyzeDefinition(input: DefinitionInput, facts: DraftFacts = new Map()): DefinitionAnalysis {
  const errors: DefinitionIssue[] = [];
  const blockers: DefinitionIssue[] = [];
  const byId = new Map(input.nodes.map((n) => [n.id, n]));
  const out = new Map<string, DefinitionEdge[]>();
  const inc = new Map<string, DefinitionEdge[]>();
  for (const e of input.edges) {
    out.set(e.from, [...(out.get(e.from) ?? []), e]);
    inc.set(e.to, [...(inc.get(e.to) ?? []), e]);
  }

  const triggers = input.nodes.filter((n) => n.kind === 'trigger');
  if (triggers.length === 0) errors.push({ severity: 'error', message: 'A workflow needs at least one trigger.' });
  for (const n of input.nodes) {
    const incoming = inc.get(n.id) ?? [];
    const outgoing = out.get(n.id) ?? [];
    if (n.kind === 'trigger' && incoming.length > 0)
      errors.push({ severity: 'error', nodeId: n.id, message: 'A trigger cannot have incoming connections.' });
    if (n.kind !== 'trigger' && incoming.length === 0)
      errors.push({ severity: 'error', nodeId: n.id, message: 'This step is not connected to anything upstream.' });
    if (n.kind === 'branch') {
      const sides = outgoing
        .map((e) => e.when)
        .sort()
        .join(',');
      if (outgoing.length !== 2 || sides !== 'gte,lt') {
        errors.push({
          severity: 'error',
          nodeId: n.id,
          message: 'A branch needs exactly two outgoing connections: one "gte" (at or above the threshold) and one "lt" (below it).',
        });
      }
    } else if (outgoing.some((e) => e.when !== undefined)) {
      errors.push({ severity: 'error', nodeId: n.id, message: '"when" is only valid on connections leaving a branch node.' });
    }
  }

  // Cycle detection (Kahn): a workflow must be a DAG.
  const indeg = new Map(input.nodes.map((n) => [n.id, (inc.get(n.id) ?? []).length]));
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift() as string;
    visited++;
    for (const e of out.get(id) ?? []) {
      const d = (indeg.get(e.to) ?? 0) - 1;
      indeg.set(e.to, d);
      if (d === 0) queue.push(e.to);
    }
  }
  if (visited !== input.nodes.length)
    errors.push({ severity: 'error', message: 'The connections form a loop; a workflow must flow one way.' });

  // Reachability from triggers.
  const reached = new Set<string>();
  const stack = triggers.map((t) => t.id);
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const e of out.get(id) ?? []) stack.push(e.to);
  }
  for (const n of input.nodes)
    if (!reached.has(n.id) && n.kind !== 'trigger')
      errors.push({ severity: 'error', nodeId: n.id, message: 'This step cannot be reached from any trigger.' });

  // ---- Blockers: what this server cannot run, or cannot run this way. ----
  const blocker = (message: string, nodeId?: string) =>
    blockers.push({ severity: 'blocker', ...(nodeId !== undefined ? { nodeId } : {}), message });

  for (const n of input.nodes) {
    if (n.kind === 'trigger' && n.config['type'] === 'schedule') blocker('There is no scheduler; schedule triggers cannot fire.', n.id);
    else if (n.kind === 'trigger' && n.config['type'] === 'document_dropped')
      blocker('There is no folder or drop watcher; "document dropped" triggers cannot fire.', n.id);
    else if (n.kind === 'action') blocker(`There is no ${String(n.config['type'])} delivery; action steps cannot run.`, n.id);
    else if (n.kind === 'compile' || n.kind === 'validate')
      blocker(`A ${n.kind} step cannot run inside a workflow; nothing here runs the compiler or validator on demand.`, n.id);
    else if (n.kind === 'capability' && n.config['memoryScope'] !== 'none')
      blocker('Capability memory scopes are not part of the runtime; only "none" can be honored.', n.id);
  }
  if (triggers.length > 1) blocker('Only one trigger per workflow can run; remove the others.');
  for (const n of input.nodes) {
    if (n.kind !== 'trigger' && (inc.get(n.id) ?? []).length > 1)
      blocker('This step has several incoming connections; joins are not supported, a run follows one path.', n.id);
    if (n.kind !== 'branch' && (out.get(n.id) ?? []).length > 1)
      blocker('This step has several outgoing connections; parallel paths are not supported, only a branch may split.', n.id);
  }

  // Resolve the single path and the capability facts it depends on.
  const capabilityNodes = input.nodes.filter((n) => n.kind === 'capability');
  const compilationIds = new Set<string>();
  for (const n of capabilityNodes) {
    const cid = n.config['compilationId'];
    if (typeof cid !== 'string') {
      blocker('This capability step does not say which compilation it comes from, so the platform cannot bind it.', n.id);
      continue;
    }
    compilationIds.add(cid);
    const cf = facts.get(cid);
    if (cf === undefined) blocker(`Compilation "${cid}" is not available in this workspace.`, n.id);
    else if (!cf.ok) blocker(`Compilation "${cid}" cannot be used: ${cf.reason}`, n.id);
    else {
      const fact = cf.capabilities.get(String(n.config['capabilityId']));
      if (fact === undefined) blocker(`Capability "${String(n.config['capabilityId'])}" does not exist in compilation "${cid}".`, n.id);
      else if (fact.unbound !== undefined) blocker(`This capability cannot run: ${fact.unbound}`, n.id);
      else if (fact.executionClass === undefined) blocker('This capability has no executable binding.', n.id);
    }
  }
  if (compilationIds.size > 1)
    blocker('Capability steps come from more than one compilation; a run is recorded against exactly one compilation.');

  const factOf = (n: DefinitionNode): CapabilityFact | undefined => {
    const cid = n.config['compilationId'];
    const cf = typeof cid === 'string' ? facts.get(cid) : undefined;
    return cf?.ok === true ? cf.capabilities.get(String(n.config['capabilityId'])) : undefined;
  };

  const steps: DraftPlanStep[] = [];
  const branches: DraftPlanBranch[] = [];
  const path: string[] = [];
  const structurallyOk = errors.length === 0 && triggers.length === 1 && blockers.length === 0;
  if (structurallyOk) {
    let cur: DefinitionNode | undefined = triggers[0];
    let previousCapability: DefinitionNode | undefined;
    const seenCaps = new Set<string>();
    const guard = new Set<string>();
    while (cur !== undefined && !guard.has(cur.id)) {
      guard.add(cur.id);
      path.push(cur.id);
      let next: DefinitionEdge | undefined;
      if (cur.kind === 'capability') {
        const fact = factOf(cur);
        const capabilityId = String(cur.config['capabilityId']);
        if (seenCaps.has(capabilityId)) blocker('The same capability appears twice on the path a run takes.', cur.id);
        seenCaps.add(capabilityId);
        if (fact?.executionClass !== undefined)
          steps.push({ nodeId: cur.id, capabilityId, name: fact.name, executionClass: fact.executionClass, approved: fact.approved });
        previousCapability = cur;
        next = (out.get(cur.id) ?? [])[0];
      } else if (cur.kind === 'human_review') {
        const prev =
          previousCapability !== undefined && (inc.get(cur.id) ?? [])[0]?.from === previousCapability.id ? previousCapability : undefined;
        const prevFact = prev !== undefined ? factOf(prev) : undefined;
        if (prevFact?.executionClass !== 'human_in_the_loop')
          blocker(
            'A review step can only follow a capability that itself opens a human task (a human-in-the-loop rule); the platform has no standalone review step.',
            cur.id,
          );
        next = (out.get(cur.id) ?? [])[0];
      } else if (cur.kind === 'branch') {
        const upstream = (inc.get(cur.id) ?? [])[0]?.from;
        const prev = previousCapability !== undefined && upstream === previousCapability.id ? previousCapability : undefined;
        const prevFact = prev !== undefined ? factOf(prev) : undefined;
        if (prev === undefined || prevFact === undefined) {
          blocker("A branch must come directly after a capability; its confidence is that capability's declared confidence.", cur.id);
          break;
        }
        const threshold = Number(cur.config['threshold']);
        const taken: 'gte' | 'lt' = prevFact.confidence >= threshold ? 'gte' : 'lt';
        branches.push({
          nodeId: cur.id,
          metric: 'confidence',
          basis: 'declared_contract_confidence',
          capabilityId: String(prev.config['capabilityId']),
          value: prevFact.confidence,
          threshold,
          taken,
        });
        next = (out.get(cur.id) ?? []).find((e) => e.when === taken);
      } else {
        next = (out.get(cur.id) ?? [])[0];
      }
      cur = next !== undefined ? byId.get(next.to) : undefined;
    }
    if (steps.length === 0 && blockers.length === 0) blocker('The path a run takes has no capability step.');
  }

  const planned = structurallyOk && blockers.length === 0 && compilationIds.size === 1;
  const plan: DraftPlan | undefined = planned ? { compilationId: [...compilationIds][0] as string, path, steps, branches } : undefined;
  return { errors, blockers, wellFormed: errors.length === 0, runnable: plan !== undefined, ...(plan !== undefined ? { plan } : {}) };
}
