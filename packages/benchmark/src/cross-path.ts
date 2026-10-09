import { compareStrings } from './json.js';

/**
 * P0.9C Step 6 — CROSS-PATH EVALUATION.
 *
 * Question: when the same underlying XO semantics go through different paths, do the paths agree? This file only MEASURES. It never
 * changes a path, never reconciles a difference and never normalises a field the repository does not already define as order-insensitive.
 *
 * Everything here is pure. The observer builds one {@link PathView} per exercised path (it calls the same library functions the real paths
 * call); {@link compareViews} turns two views into judged and non-judged {@link CrossPathUnit}s.
 *
 * The six states (Step 2 accounting, extended for cross-path):
 *   match / mismatch   both sides were observed, are comparable, and agree / differ        -> the ONLY states that enter a denominator
 *   unknown            one side did not record the value (e.g. an installed package has no graphHash by design)
 *   not_comparable     the two sides are not the same semantic object, or the path is out of scope for this subject
 *   not_exercised      the benchmark did not run the path / request
 *   not_observable     the path ran but the value cannot be read
 */

export type CrossPathState = 'match' | 'mismatch' | 'unknown' | 'not_comparable' | 'not_exercised' | 'not_observable';
export const CROSS_PATH_STATES: readonly CrossPathState[] = ['match', 'mismatch', 'unknown', 'not_comparable', 'not_exercised', 'not_observable'];

/** Paths the benchmark can actually build in-process, from the library functions the real paths call. */
export type CrossPathId = 'live_graph' | 'serialized_graph' | 'package_boundary';
export type CrossPathPair = 'live_vs_serialized' | 'live_vs_package';
export type CrossPathDimension = 'graph_hash' | 'capability_present' | 'contract_embedded' | 'contract_hash' | 'binding' | 'execution_outcome' | 'execution_provenance';

export interface PathCapabilityView {
  readonly capabilityId: string;
  readonly name: string;
  /** `computeContractContentHash` of the contract this path holds (projection on the live/serialized graph; the extracted contract on the package boundary). */
  readonly contractContentHash?: string;
  readonly binding?: { readonly status: 'resolved' | 'unresolved' | 'ambiguous' | 'denied'; readonly bindingId?: string; readonly implementationClass?: string };
  /** package boundary only: a `semanticCapabilityContract` was present in the node's properties. */
  readonly contractEmbedded?: boolean;
}

export interface PathExecutionView {
  readonly requestId: string;
  readonly capabilityId: string;
  readonly outcome: string;
  readonly matched?: boolean;
  /** the runtime's recorded provenance, verbatim (`graphHash` is absent on the package boundary by design). */
  readonly recorded?: { readonly contractId?: string; readonly bindingId?: string; readonly contractContentHash?: string; readonly graphHash?: string };
}

export interface PathView {
  readonly path: CrossPathId;
  /** `lowered` = capability lowering embedded contracts, which MOVES the graph's content hash (documented in `capability-lowering.ts`): a lowered graph is a different semantic object from the unlowered one. */
  readonly graphIdentity: 'unlowered' | 'lowered';
  /** Absent where the path has no graph hash by design. */
  readonly graphHash?: string;
  readonly capabilities: readonly PathCapabilityView[];
  readonly executions: readonly PathExecutionView[];
}

export interface CrossPathUnit {
  readonly pair: CrossPathPair;
  readonly dimension: CrossPathDimension;
  /** a capability id, a request id, or `*graph*`. Capability ids are content-derived XOIR node ids, so they are comparable across paths over the same graph content. */
  readonly subject: string;
  readonly state: CrossPathState;
  readonly left?: string;
  readonly right?: string;
  readonly reason?: string;
}

/** `capability-lowering.ts` LOWERABLE_IMPLEMENTATION_CLASSES (not exported; drift-guarded by test). */
export const LOWERABLE_IMPLEMENTATION_CLASSES: readonly string[] = ['deterministic_rule', 'human_in_the_loop'];
/** `apps/cli` `deterministic-router.ts` resolves only `StructuredComparisonBindingResolver`, whose class is `deterministic_rule` (drift-guarded by test). */
export const INSTALLED_PATH_BINDING_CLASS = 'deterministic_rule';

// ---------------------------------------------------------------------------
// Comparator
// ---------------------------------------------------------------------------

const bindingKey = (b: PathCapabilityView['binding']): string | undefined => (b === undefined ? undefined : `${b.status}|${b.bindingId ?? ''}|${b.implementationClass ?? ''}`);

function judged(pair: CrossPathPair, dimension: CrossPathDimension, subject: string, left: string | undefined, right: string | undefined, missingReason: string): CrossPathUnit {
  if (left === undefined || right === undefined) return { pair, dimension, subject, state: 'unknown', ...(left !== undefined ? { left } : {}), ...(right !== undefined ? { right } : {}), reason: missingReason };
  return { pair, dimension, subject, state: left === right ? 'match' : 'mismatch', left, right };
}
const unit = (pair: CrossPathPair, dimension: CrossPathDimension, subject: string, state: CrossPathState, reason: string): CrossPathUnit => ({ pair, dimension, subject, state, reason });

export function compareViews(pair: CrossPathPair, live: PathView, other: PathView): readonly CrossPathUnit[] {
  const out: CrossPathUnit[] = [];
  const otherById = new Map(other.capabilities.map((c) => [c.capabilityId, c] as const));
  const liveById = new Map(live.capabilities.map((c) => [c.capabilityId, c] as const));

  // graphHash is compared ONLY when both sides are the same semantic object, computed by the same canonical mechanism.
  if (live.graphIdentity !== other.graphIdentity) out.push(unit(pair, 'graph_hash', '*graph*', 'not_comparable', `the ${other.path} graph is ${other.graphIdentity} and the live graph is ${live.graphIdentity}: lowering moves the content hash, so they are different objects`));
  else out.push(judged(pair, 'graph_hash', '*graph*', live.graphHash, other.graphHash, `${live.graphHash === undefined ? 'live' : other.path} recorded no graph hash`));

  if (pair === 'live_vs_serialized') {
    for (const id of [...new Set([...liveById.keys(), ...otherById.keys()])].sort(compareStrings)) {
      const l = liveById.get(id), o = otherById.get(id);
      if (l === undefined || o === undefined) { out.push({ pair, dimension: 'capability_present', subject: id, state: 'mismatch', left: l ? 'present' : 'absent', right: o ? 'present' : 'absent' }); continue; }
      out.push({ pair, dimension: 'capability_present', subject: id, state: 'match', left: 'present', right: 'present' });
      out.push(judged(pair, 'contract_hash', id, l.contractContentHash, o.contractContentHash, 'a contract hash was not recorded'));
      out.push(judged(pair, 'binding', id, bindingKey(l.binding), bindingKey(o.binding), 'a binding was not recorded'));
    }
    return out;
  }

  // live_vs_package: the package boundary carries a contract only for capabilities lowering embeds.
  for (const l of [...live.capabilities].sort((a, b) => compareStrings(a.capabilityId, b.capabilityId))) {
    const id = l.capabilityId;
    const lowerable = l.binding?.status === 'resolved' && l.binding.implementationClass !== undefined && LOWERABLE_IMPLEMENTATION_CLASSES.includes(l.binding.implementationClass);
    if (!lowerable) { out.push(unit(pair, 'contract_embedded', id, 'not_comparable', `lowering embeds no contract for a ${l.binding?.status ?? 'binding-less'} / ${l.binding?.implementationClass ?? 'no-class'} capability (out of the package boundary's scope)`)); continue; }
    const p = otherById.get(id);
    if (p === undefined || p.contractEmbedded !== true) { out.push({ pair, dimension: 'contract_embedded', subject: id, state: 'mismatch', left: 'lowerable', right: 'no embedded contract', reason: 'live binding is lowerable but the package boundary carries no contract' }); continue; }
    out.push({ pair, dimension: 'contract_embedded', subject: id, state: 'match', left: 'lowerable', right: 'embedded' });
    out.push(judged(pair, 'contract_hash', id, l.contractContentHash, p.contractContentHash, 'a contract hash was not recorded'));
    // Out of the installed path's DECLARED scope, so not counted — but the raw values stay on the unit: this is a real, by-design difference.
    if (l.binding?.implementationClass !== INSTALLED_PATH_BINDING_CLASS) out.push({ pair, dimension: 'binding', subject: id, state: 'not_comparable', ...(bindingKey(l.binding) !== undefined ? { left: bindingKey(l.binding)! } : {}), ...(bindingKey(p.binding) !== undefined ? { right: bindingKey(p.binding)! } : {}), reason: `the installed path resolves only the structured-comparison binding; ${l.binding?.implementationClass} is out of its declared scope` });
    else out.push(judged(pair, 'binding', id, bindingKey(l.binding), bindingKey(p.binding), 'a binding was not recorded'));
  }

  const packageRuns = new Map(other.executions.map((e) => [e.requestId, e] as const));
  for (const e of [...live.executions].sort((a, b) => compareStrings(a.requestId, b.requestId))) {
    const ran = e.outcome === 'succeeded' || e.outcome === 'waiting_for_human';
    if (!ran) { out.push(unit(pair, 'execution_outcome', e.requestId, 'not_exercised', `the live request did not run (${e.outcome})`)); continue; }
    const cap = liveById.get(e.capabilityId);
    if (cap?.binding?.implementationClass !== INSTALLED_PATH_BINDING_CLASS) { out.push(unit(pair, 'execution_outcome', e.requestId, 'not_comparable', 'the installed path executes only deterministic (structured-comparison) capabilities')); continue; }
    const r = packageRuns.get(e.requestId);
    if (r === undefined) { out.push(unit(pair, 'execution_outcome', e.requestId, 'not_exercised', 'the package boundary was not executed for this request')); continue; }
    out.push(judged(pair, 'execution_outcome', e.requestId, `${e.outcome}|${e.matched ?? ''}`, `${r.outcome}|${r.matched ?? ''}`, 'an outcome was not recorded'));
    // execution provenance: graphHash is excluded (absent on the package boundary by design); only fields both paths define are compared.
    const facts = (x: PathExecutionView): string | undefined => (x.recorded === undefined ? undefined : `${x.recorded.contractId ?? ''}|${x.recorded.bindingId ?? ''}|${x.recorded.contractContentHash ?? ''}`);
    out.push(judged(pair, 'execution_provenance', e.requestId, facts(e), facts(r), 'an execution did not record its provenance'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Path inventory (static, verified against the code in the Step 6 audit)
// ---------------------------------------------------------------------------

export type InventoryCell = 'observed' | 'not_exercised' | 'not_observable' | 'not_applicable';
export interface PathInventoryRow {
  readonly path: string;
  readonly input: InventoryCell;
  readonly compile: InventoryCell;
  readonly capabilityDiscovery: InventoryCell;
  readonly contract: InventoryCell;
  readonly binding: InventoryCell;
  readonly execution: InventoryCell;
  readonly provenance: InventoryCell;
  /** How the repository covers it OUTSIDE this benchmark (never counted as observed here). */
  readonly externalCoverage: string;
}

const O = 'observed', N = 'not_exercised', X = 'not_observable', A = 'not_applicable';

/**
 * "observed" = the benchmark's own runs exercise and read it. API / CLI rows are `not_exercised` by the benchmark: the benchmark package
 * cannot import the apps, so those paths are covered only by the app-level tests named in `externalCoverage`.
 */
export const PATH_INVENTORY: readonly PathInventoryRow[] = [
  { path: 'benchmark observer / live graph', input: O, compile: O, capabilityDiscovery: O, contract: O, binding: O, execution: O, provenance: O, externalCoverage: 'is the reference path of every comparison' },
  { path: 'serialized XOIR (toJson/fromJson round trip)', input: O, compile: A, capabilityDiscovery: O, contract: O, binding: O, execution: N, provenance: X, externalCoverage: 'runtime-mechanics enters through a serialized graph (but is a hand-built fixture)' },
  { path: 'package boundary (lowered + serialized + contract extracted)', input: O, compile: A, capabilityDiscovery: N, contract: O, binding: O, execution: O, provenance: X, externalCoverage: 'the archive / sign / install steps are NOT exercised' },
  { path: 'installed package (xo create/pack/install, xo run)', input: N, compile: N, capabilityDiscovery: N, contract: N, binding: N, execution: N, provenance: X, externalCoverage: 'apps/cli tests (deterministic-router); not compared here' },
  { path: 'CLI capabilities (xo capabilities)', input: N, compile: N, capabilityDiscovery: N, contract: A, binding: A, execution: A, provenance: A, externalCoverage: 'same compileSources + discoverAndResolveCapabilities calls as the observer; no benchmark-level comparison' },
  { path: 'CLI workflow (xo workflow / xo demo)', input: N, compile: N, capabilityDiscovery: A, contract: N, binding: N, execution: N, provenance: N, externalCoverage: 'shares composeWorkflows + prepareCandidateWorkflowForExecution with the observer' },
  { path: 'API compile + capability listing', input: N, compile: N, capabilityDiscovery: N, contract: A, binding: A, execution: A, provenance: A, externalCoverage: 'apps/api benchmark-equivalence.test.ts: capability id|name|resolution|executionClass sets on 2 PDFs' },
  { path: 'API capability execution', input: N, compile: N, capabilityDiscovery: N, contract: N, binding: N, execution: N, provenance: N, externalCoverage: 'apps/api benchmark-equivalence.test.ts: 3 outcomes on the commercial PDF' },
  { path: 'API workflow execution', input: N, compile: N, capabilityDiscovery: A, contract: N, binding: N, execution: N, provenance: N, externalCoverage: 'apps/api workflow tests; not compared to the observer' },
  { path: 'direct capability execution', input: O, compile: O, capabilityDiscovery: O, contract: O, binding: O, execution: O, provenance: O, externalCoverage: 'observer' },
  { path: 'workflow-contained capability', input: O, compile: O, capabilityDiscovery: O, contract: O, binding: O, execution: O, provenance: O, externalCoverage: 'observer; NOT compared with the direct path (step inputs come from data flow)' },
];
