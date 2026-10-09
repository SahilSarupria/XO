import { err, ok, type Result } from '@xo/types';
import type { CapabilityContractError } from '@xo/errors';
import { XoirNodeId, type XoirGraph } from '@xo/xoir';
import { buildSemanticCapabilityContract, type BuildContractOptions } from './contract-builder.js';
import { computeContractContentHash } from './contract-hash.js';
import { resolveCapabilityBinding } from './resolve-binding.js';
import { STANDARD_BINDING_RESOLVERS } from './standard-resolvers.js';
import type { BindingResolver, ContractSourceRef } from './types.js';

/**
 * P0.9B Step 6 — the one shared inspection/provenance PROJECTION.
 *
 * Answers, from data that already exists, the chain
 *
 *   source -> capability -> XOIR nodes -> contract -> binding
 *   workflow step -> capability / contract / binding / XOIR nodes
 *   execution -> workflow step, graphHash, contractContentHash
 *
 * This is a read-only data projection. It introduces NO new identity
 * (every id/hash here is an existing one: `sourceRefs`,
 * `sourceXoirNodeIds`, `contractId`, `bindingId`, `compilationId`,
 * `workflowId`, `executionId`, `graphHash`, `contractContentHash`) and NO
 * trust semantics: it never approves, rejects, ranks, or gates anything.
 * The `agreement` fields only report whether two recorded values are
 * equal, so an inspector can see a divergence; what to do about one is
 * not decided here.
 *
 * It takes plain structural inputs (no `@xo/runtime`, no `apps/api`
 * types) so the CLI, API, and benchmark can all feed it their own
 * records and get the same shape back.
 */

export interface CapabilityBindingProvenance {
  readonly status: 'resolved' | 'unresolved' | 'ambiguous' | 'denied';
  readonly bindingId?: string;
  readonly implementationClass?: string;
  readonly reason?: string;
}

/** Live-graph view of one capability: everything the graph can say about it. */
export interface CapabilityProvenance {
  readonly capabilityId: string;
  readonly name: string;
  /** Source documents this capability's contract was projected from (`contract.sourceRefs`). */
  readonly sourceRefs: readonly ContractSourceRef[];
  /** Every XOIR node the contract was projected from (capability node + linked rule/action nodes). */
  readonly sourceXoirNodeIds: readonly string[];
  readonly contractId: string;
  readonly contractContentHash: string;
  readonly binding: CapabilityBindingProvenance;
  /** `XoirGraph.contentHash()` of the graph this was projected from. */
  readonly graphHash: string;
}

export interface ProjectCapabilityOptions {
  readonly resolvers?: readonly BindingResolver[];
  readonly contract?: BuildContractOptions;
}

export function projectCapabilityProvenance(graph: XoirGraph, capabilityId: string, options: ProjectCapabilityOptions = {}): Result<CapabilityProvenance, CapabilityContractError> {
  const built = buildSemanticCapabilityContract(graph, XoirNodeId(capabilityId), options.contract ?? {});
  if (!built.ok) return err(built.error);
  const contract = built.value;
  const outcome = resolveCapabilityBinding(contract, options.resolvers ?? STANDARD_BINDING_RESOLVERS);
  const binding: CapabilityBindingProvenance =
    outcome.status === 'resolved'
      ? { status: 'resolved', bindingId: outcome.binding.id, implementationClass: outcome.binding.implementationClass }
      : { status: outcome.status, reason: outcome.reason };
  return ok({
    capabilityId,
    name: contract.name,
    sourceRefs: contract.sourceRefs,
    sourceXoirNodeIds: contract.sourceXoirNodeIds,
    contractId: contract.id,
    contractContentHash: computeContractContentHash(contract),
    binding,
    graphHash: graph.contentHash(),
  });
}

/** One entry per `capability`-kind node, sorted by capability id (same order convention as `buildAllSemanticCapabilityContracts`). */
export function projectAllCapabilityProvenance(graph: XoirGraph, options: ProjectCapabilityOptions = {}): readonly CapabilityProvenance[] {
  const ids = graph
    .allNodes()
    .filter((n) => n.kind === 'capability')
    .map((n) => n.id as unknown as string)
    .sort();
  const out: CapabilityProvenance[] = [];
  for (const id of ids) {
    const projected = projectCapabilityProvenance(graph, id, options);
    if (projected.ok) out.push(projected.value);
  }
  return out;
}

/** Reverse lookup: which capabilities were projected from a given source document (`sourceRefs[].documentPath`). */
export function capabilitiesFromSource(projections: readonly CapabilityProvenance[], documentPath: string): readonly CapabilityProvenance[] {
  return projections.filter((p) => p.sourceRefs.some((r) => r.documentPath === documentPath));
}

// ---------------------------------------------------------------------------
// Execution + workflow layers (plain structural inputs)
// ---------------------------------------------------------------------------

/** The provenance-relevant fields any execution record already carries: an `ExecutionReceipt`, an API `ExecutionRecord`, a `RuntimeCapabilityExecutionResult`. */
export interface ExecutionFacts {
  readonly executionId?: string;
  readonly capabilityId: string;
  readonly contractId?: string;
  readonly bindingId?: string;
  readonly sourceXoirNodeIds?: readonly string[];
  readonly graphHash?: string;
  readonly contractContentHash?: string;
}

export type Agreement = 'match' | 'mismatch' | 'unknown';

export interface ExecutionProvenance extends ExecutionFacts {
  /** Set when the execution was reached through a workflow step. */
  readonly workflowId?: string;
  readonly workflowStepOrder?: number;
  /** The live-graph view of the executed capability, when a graph view was supplied. */
  readonly capability?: CapabilityProvenance;
  /** Field-by-field equality between what the execution recorded and the graph view. `'unknown'` = one side is absent (e.g. installed-package executions record no graphHash). */
  readonly agreement: { readonly graphHash: Agreement; readonly contractContentHash: Agreement; readonly bindingId: Agreement; readonly contractId: Agreement };
}

const compare = (recorded: string | undefined, expected: string | undefined): Agreement => (recorded === undefined || expected === undefined ? 'unknown' : recorded === expected ? 'match' : 'mismatch');

export function projectExecutionProvenance(facts: ExecutionFacts, capability?: CapabilityProvenance, workflow?: { readonly workflowId: string; readonly stepOrder: number }): ExecutionProvenance {
  return {
    ...facts,
    ...(workflow !== undefined ? { workflowId: workflow.workflowId, workflowStepOrder: workflow.stepOrder } : {}),
    ...(capability !== undefined ? { capability } : {}),
    agreement: {
      graphHash: compare(facts.graphHash, capability?.graphHash),
      contractContentHash: compare(facts.contractContentHash, capability?.contractContentHash),
      bindingId: compare(facts.bindingId, capability?.binding.bindingId),
      contractId: compare(facts.contractId, capability?.contractId),
    },
  };
}

/** Structural shape of `apps/api`'s `WorkflowExecutionRecord.provenance` — declared here so this package needs no API dependency. */
export interface WorkflowProvenanceInput {
  readonly workflowId: string;
  readonly compilationId?: string;
  readonly graphHash?: string;
  readonly steps: readonly {
    readonly order: number;
    readonly capabilityId: string;
    readonly contractId?: string;
    readonly bindingId?: string;
    readonly sourceXoirNodeIds?: readonly string[];
    readonly executionId?: string;
  }[];
}

export interface WorkflowStepProvenance {
  readonly order: number;
  readonly capabilityId: string;
  readonly contractId?: string;
  readonly bindingId?: string;
  readonly sourceXoirNodeIds?: readonly string[];
  readonly executionId?: string;
  readonly capability?: CapabilityProvenance;
  /** Present when an execution record for `executionId` was supplied. */
  readonly execution?: ExecutionProvenance;
}

export interface WorkflowProvenance {
  readonly workflowId: string;
  readonly compilationId?: string;
  readonly graphHash?: string;
  readonly steps: readonly WorkflowStepProvenance[];
}

export interface ProjectWorkflowOptions {
  /** Live graph views to join each step against, keyed by capability id (build with `projectAllCapabilityProvenance`). */
  readonly capabilities?: readonly CapabilityProvenance[];
  /** Execution records to join each step against, keyed by `executionId`. */
  readonly executions?: ReadonlyMap<string, ExecutionFacts>;
}

export function projectWorkflowProvenance(workflow: WorkflowProvenanceInput, options: ProjectWorkflowOptions = {}): WorkflowProvenance {
  const byCapability = new Map((options.capabilities ?? []).map((c) => [c.capabilityId, c]));
  const steps = [...workflow.steps]
    .sort((a, b) => a.order - b.order)
    .map((step): WorkflowStepProvenance => {
      const capability = byCapability.get(step.capabilityId);
      const facts = step.executionId !== undefined ? options.executions?.get(step.executionId) : undefined;
      return {
        ...step,
        ...(capability !== undefined ? { capability } : {}),
        ...(facts !== undefined ? { execution: projectExecutionProvenance({ ...facts, executionId: step.executionId! }, capability, { workflowId: workflow.workflowId, stepOrder: step.order }) } : {}),
      };
    });
  return {
    workflowId: workflow.workflowId,
    ...(workflow.compilationId !== undefined ? { compilationId: workflow.compilationId } : {}),
    ...(workflow.graphHash !== undefined ? { graphHash: workflow.graphHash } : {}),
    steps,
  };
}
