/**
 * PX-5 — the capability inventory (gaps PX-G17 to PX-G20; ADR 0029 decisions 8 to 11).
 *
 * One report per capability the compiler discovered, with:
 *
 *   status       explicit | inferred | accepted | rejected | duplicate | unresolved | unsupported (decision 8)
 *   readiness    four INDEPENDENT answers (decision 10) — eligible (the declaration permits a strategy), bound (a binding
 *                resolved), runtime-supported (the runtime has an executor for that strategy), authorized (permission is
 *                currently granted). Only all four together make a step runnable; each answer says why.
 *   humanTask    the human task contract, from the ONE rule `humanTaskContractOf` (decision 11)
 *   parameters   each input and output with how it was derived — structured (a declared schema type), declared (stated by
 *                the source), inferred (read off a rule or guessed) — inferred required inputs need review (PX-G20)
 *
 * plus duplicate groups (only fully equivalent candidates; variants stay distinct) and gaps (a capability a goal needs that
 * no usable candidate provides). Pure and deterministic: the same graph and context give the same inventory and digest.
 */
import {
  buildAllSemanticCapabilityContracts,
  computeContractContentHash,
  humanTaskContractOf,
  resolveCapabilityBinding,
  STANDARD_BINDING_RESOLVERS,
  type BindingOutcome,
  type BindingResolver,
  type ContractSourceRef,
  type HumanTaskContract,
  type SemanticCapabilityContract,
} from '@xo/capability-contract';
import type { XoirGraph } from '@xo/xoir';
import { digestOf, type Digest } from './canonical.js';
import type { ConnectorBinding } from './lower-workflow.js';

export const CAPABILITY_INVENTORY_SCHEMA = 'xo.capability-inventory.v1';

export type CapabilityStatus = 'explicit' | 'inferred' | 'accepted' | 'rejected' | 'duplicate' | 'unresolved' | 'unsupported';
export const CAPABILITY_STATUSES: readonly CapabilityStatus[] = [
  'explicit',
  'inferred',
  'accepted',
  'rejected',
  'duplicate',
  'unresolved',
  'unsupported',
];

/** Decision 10's vocabulary, as in `CapabilityExecutionDeclaration`. */
export type ExecutionStrategy = 'deterministic_rule' | 'human_in_the_loop' | 'model' | 'hybrid' | 'external_tool';

/** One of the four readiness answers. `unknown` is never treated as yes. */
export interface ReadinessAnswer {
  readonly value: 'yes' | 'no' | 'unknown';
  readonly reason: string;
}

export interface CapabilityReadiness {
  readonly eligible: ReadinessAnswer & { readonly strategies: readonly ExecutionStrategy[] };
  readonly bound: ReadinessAnswer & { readonly strategy?: ExecutionStrategy; readonly bindingId?: string };
  readonly runtimeSupported: ReadinessAnswer;
  readonly authorized: ReadinessAnswer;
  /** True only when all four answers are `yes`. */
  readonly runnable: boolean;
  /** Each answer that is not `yes`, as a sentence a reviewer can act on. */
  readonly blockers: readonly string[];
  /** Things that do not block binding but must be settled before start (an unassigned role, inferred required inputs). */
  readonly conditions: readonly string[];
}

export interface ParameterReport {
  readonly name: string;
  readonly direction: 'input' | 'output';
  /** structured: a type the source declared in a schema; declared: named by the source; inferred: read off a rule or guessed. */
  readonly derivation: 'structured' | 'declared' | 'inferred';
  readonly semanticType: 'string' | 'number' | 'boolean' | 'unknown';
  readonly required: boolean;
  /** An inferred required input: a reviewer must confirm it before the capability's contract is relied on. */
  readonly needsReview: boolean;
}

export type CapabilityOrigin = 'declared-operation' | 'procedure-step' | 'prose';

export interface CapabilityReport {
  readonly capabilityId: string;
  readonly name: string;
  readonly description: string;
  readonly origin: CapabilityOrigin;
  readonly status: CapabilityStatus;
  readonly statusReason: string;
  /** For a duplicate: the capability it duplicates (the first of its group by id). */
  readonly duplicateOf?: string;
  readonly binding: { readonly status: BindingOutcome['status']; readonly reason?: string; readonly resolverName?: string };
  readonly humanTask?: HumanTaskContract;
  readonly contractHash: string;
  readonly parameters: readonly ParameterReport[];
  readonly readiness: CapabilityReadiness;
  readonly confidence: number;
  readonly evidence: readonly ContractSourceRef[];
}

export interface CapabilityGap {
  /** What the goal needs, as it named it. */
  readonly need: string;
  readonly reason: string;
  /** Candidates that match the need but cannot be used (rejected, duplicate or unsupported), if any. */
  readonly unusableCandidates: readonly string[];
}

export interface CapabilityInventory {
  readonly schema: typeof CAPABILITY_INVENTORY_SCHEMA;
  /** The compilation artifact this inventory describes, when known. */
  readonly artifactDigest?: string;
  readonly counts: Readonly<Record<CapabilityStatus, number>> & { readonly total: number; readonly runnable: number };
  readonly capabilities: readonly CapabilityReport[];
  /** Groups of fully equivalent candidates (decision 8): the first id is kept, the others are `duplicate`. */
  readonly duplicateGroups: readonly (readonly string[])[];
  readonly gaps: readonly CapabilityGap[];
  /** `sha256:` over every other field. */
  readonly digest: Digest;
}

export interface InventoryContext {
  readonly artifactDigest?: string;
  /** Strategies the runtime has an executor for. Default: the two this platform runs natively (rules and human tasks). */
  readonly runtimeSupport?: ReadonlySet<ExecutionStrategy>;
  /**
   * Whether execution is currently authorized for a capability (approval verified and permission granted). Default:
   * `unknown` — "checked at the start gate" — which is never runnable here.
   */
  readonly authorize?: (report: Omit<CapabilityReport, 'readiness' | 'status' | 'statusReason'>) => ReadinessAnswer;
  /** Reviewer decisions by capability id: `accepted` (approved) or `rejected`. */
  readonly decisions?: ReadonlyMap<string, 'accepted' | 'rejected'>;
  /** Capability names a goal needs; each one no usable capability provides is a gap. */
  readonly needs?: readonly string[];
  /** The workspace's connector bindings by capability name: the binding for `external_tool` (ADR 0030). */
  readonly externalBindings?: ReadonlyMap<string, ConnectorBinding>;
  /** Host adapters that can carry out a binding; a binding whose adapter is absent is bound but not runtime-supported. */
  readonly availableAdapters?: ReadonlySet<string>;
  readonly resolvers?: readonly BindingResolver[];
}

export const DEFAULT_RUNTIME_SUPPORT: ReadonlySet<ExecutionStrategy> = new Set<ExecutionStrategy>([
  'deterministic_rule',
  'human_in_the_loop',
]);

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

function strategyOf(implementationClass: string): ExecutionStrategy | undefined {
  switch (implementationClass) {
    case 'deterministic_rule':
    case 'human_in_the_loop':
    case 'external_tool':
      return implementationClass;
    case 'ai_provider':
      return 'model';
    default:
      return undefined;
  }
}

function originOf(graph: XoirGraph, id: string): CapabilityOrigin {
  const node = graph.getNode(id as never);
  const meta = node.ok
    ? ((node.value.properties as Record<string, unknown>)['metadata'] as Record<string, unknown> | undefined)
    : undefined;
  if (meta?.['sourceExtractor'] === 'structured-operation') return 'declared-operation';
  if (meta?.['understanding'] === 'manual-step') return 'procedure-step';
  return 'prose';
}

function parametersOf(c: SemanticCapabilityContract, origin: CapabilityOrigin): ParameterReport[] {
  const one = (p: SemanticCapabilityContract['inputs'][number], direction: 'input' | 'output'): ParameterReport => {
    const derivation: ParameterReport['derivation'] =
      p.derivedFrom === 'declared'
        ? origin === 'declared-operation' && p.semanticType !== undefined && p.semanticType !== 'unknown'
          ? 'structured'
          : 'declared'
        : 'inferred';
    const required = direction === 'input' && (p.required ?? true);
    return {
      name: p.name,
      direction,
      derivation,
      semanticType: p.semanticType ?? 'unknown',
      required,
      needsReview: required && derivation === 'inferred',
    };
  };
  return [...c.inputs.map((p) => one(p, 'input')), ...c.outputs.map((p) => one(p, 'output'))];
}

/** Decision 8: equivalent after normalisation in name, inputs, outputs, rules AND source evidence. Anything else is a variant. */
function equivalenceKey(c: SemanticCapabilityContract): string {
  return JSON.stringify({
    name: norm(c.name),
    inputs: c.inputs.map((i) => norm(i.name)).sort(),
    outputs: c.outputs.map((o) => norm(o.name)).sort(),
    rules: c.rules.map((r) => [r.kind, norm(r.condition), norm(r.outcome ?? '')]).sort(),
    evidence: c.sourceRefs.map((s) => [s.documentPath, (s.sectionPath ?? []).join('>'), (s.pages ?? []).join(',')]).sort(),
  });
}

/** Builds the inventory of every capability in `graph`. */
export function buildCapabilityInventory(graph: XoirGraph, ctx: InventoryContext = {}): CapabilityInventory {
  const runtimeSupport = ctx.runtimeSupport ?? DEFAULT_RUNTIME_SUPPORT;
  const resolvers = ctx.resolvers ?? STANDARD_BINDING_RESOLVERS;
  const contracts = buildAllSemanticCapabilityContracts(graph)
    .filter((r): r is { ok: true; value: SemanticCapabilityContract } => r.ok)
    .map((r) => r.value);

  // Duplicate groups, in id order: the first member is kept.
  const byKey = new Map<string, string[]>();
  for (const c of [...contracts].sort((a, b) => a.id.localeCompare(b.id)))
    byKey.set(equivalenceKey(c), [...(byKey.get(equivalenceKey(c)) ?? []), c.id]);
  const duplicateGroups = [...byKey.values()].filter((g) => g.length > 1);
  const duplicateOf = new Map<string, string>();
  for (const g of duplicateGroups) for (const id of g.slice(1)) duplicateOf.set(id, g[0]!);

  const capabilities: CapabilityReport[] = [];
  for (const c of [...contracts].sort((a, b) => a.id.localeCompare(b.id))) {
    const origin = originOf(graph, c.id);
    const humanTask = humanTaskContractOf(c);
    const outcome = resolveCapabilityBinding(c, resolvers);
    const parameters = parametersOf(c, origin);

    // eligible: which strategies the declaration itself permits
    const strategies: ExecutionStrategy[] = [];
    if (c.rules.length > 0) strategies.push('deterministic_rule');
    if (humanTask !== undefined) strategies.push('human_in_the_loop');
    if (origin === 'declared-operation') strategies.push('external_tool');
    const eligible =
      strategies.length > 0
        ? { value: 'yes' as const, reason: `the declaration permits ${strategies.join(', ')}`, strategies }
        : {
            value: 'no' as const,
            reason: 'no rules to evaluate, no human task contract and no declared operation: nothing permits any execution strategy',
            strategies,
          };

    // bound: did a binding resolve, and to which strategy
    const connector = origin === 'declared-operation' ? ctx.externalBindings?.get(c.name) : undefined;
    let bound: CapabilityReadiness['bound'];
    if (outcome.status === 'resolved') {
      const strategy = strategyOf(outcome.binding.implementationClass);
      bound = {
        value: 'yes',
        reason: `bound by ${outcome.binding.resolverName} (${outcome.binding.implementationClass})`,
        ...(strategy !== undefined ? { strategy } : {}),
        bindingId: outcome.binding.id,
      };
    } else if (connector !== undefined) {
      bound = {
        value: 'yes',
        reason: `bound by the workspace to ${connector.connector}.${connector.operation} (${connector.sideEffect})`,
        strategy: 'external_tool',
        bindingId: `connector:${connector.connector}.${connector.operation}`,
      };
    } else {
      bound = { value: 'no', reason: `binding ${outcome.status}: ${outcome.reason}` };
    }

    // runtime-supported: the runtime has an executor for the bound strategy
    const adapterMissing =
      connector !== undefined && bound.strategy === 'external_tool' && !(ctx.availableAdapters?.has(connector.adapter) ?? false);
    const runtimeSupported: ReadinessAnswer = adapterMissing
      ? { value: 'no', reason: `the host has no adapter "${connector!.adapter}" for ${connector!.connector}` }
      : bound.strategy === undefined
        ? {
            value: bound.value === 'yes' ? 'no' : 'unknown',
            reason:
              bound.value === 'yes'
                ? 'the binding names no execution strategy the runtime knows'
                : 'nothing is bound, so there is nothing to execute',
          }
        : runtimeSupport.has(bound.strategy) || (bound.strategy === 'external_tool' && connector !== undefined)
          ? { value: 'yes', reason: `the runtime executes ${bound.strategy}` }
          : { value: 'no', reason: `the runtime has no executor for ${bound.strategy}` };

    const base = {
      capabilityId: c.id,
      name: c.name,
      description: c.description,
      origin,
      ...(duplicateOf.has(c.id) ? { duplicateOf: duplicateOf.get(c.id)! } : {}),
      binding: {
        status: outcome.status,
        ...(outcome.status === 'resolved' ? { resolverName: outcome.binding.resolverName } : { reason: outcome.reason }),
      },
      ...(humanTask !== undefined ? { humanTask } : {}),
      contractHash: computeContractContentHash(c),
      parameters,
      confidence: c.confidence,
      evidence: c.sourceRefs,
    };
    const authorized: ReadinessAnswer = ctx.authorize?.(base) ?? {
      value: 'unknown',
      reason: 'authorization is checked at the start gate (approval and permission), not at compile time',
    };

    const answers = { eligible, bound, runtimeSupported, authorized };
    const blockers = Object.entries(answers)
      .filter(([, a]) => a.value !== 'yes')
      .map(([k, a]) => `${k}: ${a.reason}`);
    const conditions: string[] = [];
    if (humanTask !== undefined && humanTask.actorRole.derivation === 'unassigned')
      conditions.push('assign the role that performs this human task');
    for (const p of parameters) if (p.needsReview) conditions.push(`confirm the inferred required input "${p.name}"`);

    const decision = ctx.decisions?.get(c.id);
    const [status, statusReason]: [CapabilityStatus, string] =
      decision === 'rejected'
        ? ['rejected', 'rejected by a reviewer']
        : duplicateOf.has(c.id)
          ? ['duplicate', `equivalent in name, inputs, outputs, rules and evidence to ${duplicateOf.get(c.id)}`]
          : bound.value !== 'yes'
            ? ['unresolved', bound.reason]
            : runtimeSupported.value !== 'yes'
              ? ['unsupported', runtimeSupported.reason]
              : decision === 'accepted'
                ? ['accepted', 'approved by a reviewer']
                : origin === 'prose'
                  ? ['inferred', 'read from prose; bound, awaiting review']
                  : ['explicit', `stated explicitly (${origin}); bound, awaiting review`];

    capabilities.push({
      ...base,
      status,
      statusReason,
      readiness: { ...answers, runnable: blockers.length === 0, blockers, conditions },
    });
  }

  const gaps: CapabilityGap[] = [];
  for (const need of ctx.needs ?? []) {
    const n = norm(need);
    const matches = capabilities.filter((c) => norm(c.name) === n || norm(c.name).includes(n) || n.includes(norm(c.name)));
    const usable = matches.filter((c) => c.status !== 'rejected' && c.status !== 'duplicate' && c.status !== 'unsupported');
    if (usable.length === 0)
      gaps.push({
        need,
        reason:
          matches.length === 0
            ? 'no discovered capability provides it'
            : 'every matching capability is rejected, a duplicate or unsupported',
        unusableCandidates: matches.map((m) => m.capabilityId),
      });
  }

  const counts = Object.fromEntries(CAPABILITY_STATUSES.map((s) => [s, capabilities.filter((c) => c.status === s).length])) as Record<
    CapabilityStatus,
    number
  >;
  const body = {
    schema: CAPABILITY_INVENTORY_SCHEMA as typeof CAPABILITY_INVENTORY_SCHEMA,
    ...(ctx.artifactDigest !== undefined ? { artifactDigest: ctx.artifactDigest } : {}),
    counts: { ...counts, total: capabilities.length, runnable: capabilities.filter((c) => c.readiness.runnable).length },
    capabilities,
    duplicateGroups,
    gaps,
  };
  return { ...body, digest: digestOf(body) };
}
