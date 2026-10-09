import { err, ok, ContentHash } from '@xo/types';
import { ErrorCode, RuntimeError } from '@xo/errors';
import type { XoirGraph } from '@xo/xoir';
import { XoirNodeId } from '@xo/xoir';
import {
  buildSemanticCapabilityContract,
  extractContractFromPropertyBag,
  normalizeToFallbackKey,
  type SemanticCapabilityContract,
  type SemanticCapabilityParameter,
  type CapabilityBinding,
} from '@xo/capability-contract';
import { auditWorkflowDataFlow, type CandidateWorkflow, type StepDataBinding } from '@xo/workflow-composer';
import { NodeId, type WorkflowEdge, type WorkflowGraph, type WorkflowNode } from './workflow-graph.js';
import type { NodeHandler } from './workflow-node-handlers.js';
import type { WorkflowContext } from './workflow-context.js';
import { registerResolvedCapabilityBinding } from '../capability-authority/capability-binding-registration.js';
import { resolveContractBinding } from '../capability-authority/contract-execution.js';
import type { RuntimeCapabilityRegistry } from '../capability-authority/runtime-capability-registry.js';
import type { RuntimeCapabilityExecutor } from '../capability-authority/runtime-capability-executor.js';

/**
 * This module is the smallest bridge between `@xo/workflow-composer`'s
 * `CandidateWorkflow` (a proposal, not an executable artifact — see that
 * package's own doc comments) and `@xo/runtime`'s `WorkflowGraph`/
 * `WorkflowExecutor` (an executable, engine-level representation). It
 * invents no new execution or routing system: contract building and
 * binding resolution reuse the exact same
 * (`buildSemanticCapabilityContract`, `extractContractFromPropertyBag`,
 * `resolveCapabilityBinding` with `StructuredComparisonBindingResolver` +
 * `ActionEscalationBindingResolver`) machinery
 * `@xo/workflow-composer#auditWorkflowExecutability` already uses to
 * *report* on a workflow's executability — this module is what actually
 * acts on that same evidence instead of only describing it. Execution
 * itself is unchanged `RuntimeCapabilityExecutor` + `registerResolvedCapabilityBinding`
 * (Action Capability Binding v1 / M1.4), wired into `WorkflowExecutor`
 * through its existing, documented `customNodeHandlers` extension point —
 * not a new "workflow capability executor".
 *
 * Deliberately scoped to today's evidence: only capabilities whose
 * binding resolves via one of these two resolvers — `'deterministic_rule'`
 * or `'human_in_the_loop'`, the only two `registerResolvedCapabilityBinding`
 * accepts — become executable graph nodes. Everything else (no contract
 * could be built, no resolver had an opinion, or registration failed —
 * e.g. an unparseable required permission) is reported as `'unbound'` and
 * left out of the produced graph entirely: never silently dropped, never
 * forced into a fake node that would "execute" nothing.
 */

// P0.9B Steps 2 and 4: resolution goes through `resolveContractBinding`
// (`../capability-authority/contract-execution.ts`), whose default is the
// one canonical `STANDARD_BINDING_RESOLVERS` (`@xo/capability-contract`) —
// previously declared here as `standardBridgeResolvers`; same two resolver
// classes, same order, same behavior. Registration stays here (into the
// caller's shared registry, one contract per workflow step) and still goes
// through `registerResolvedCapabilityBinding`, with `graphHash` from the
// live graph this function already holds.

export type CandidateWorkflowStepBridgeStatus = 'bound' | 'unbound';

/**
 * A contract parameter (input or output), with the exact key a real
 * execution call actually reads/writes it under — see
 * `normalizeToFallbackKey`'s own doc comment (`@xo/capability-contract`):
 * even a `'declared'` name goes through this same normalization before
 * `evaluate()` ever sees it, so a caller (a CLI, a UI) that wants to
 * show "supply this field" must show `runtimeKey`, not `name`, or a
 * value supplied under the literal declared name (e.g. `"reported loss
 * date"`) would silently never reach the capability. Exposed here
 * purely for display — this bridge performs no matching/injection
 * decision based on it beyond what `wiredInjections` already computed.
 */
export interface CandidateWorkflowStepParameter {
  readonly name: string;
  readonly runtimeKey: string;
  readonly semanticType: SemanticCapabilityParameter['semanticType'];
  readonly required: SemanticCapabilityParameter['required'];
  readonly derivedFrom: SemanticCapabilityParameter['derivedFrom'];
}

function toStepParameter(param: SemanticCapabilityParameter): CandidateWorkflowStepParameter {
  return { name: param.name, runtimeKey: normalizeToFallbackKey(param.name), semanticType: param.semanticType, required: param.required, derivedFrom: param.derivedFrom };
}

export interface CandidateWorkflowStepBridgeResult {
  readonly capabilityId: string;
  readonly capabilityName: string;
  readonly status: CandidateWorkflowStepBridgeStatus;
  readonly reason?: string;
  readonly contractId?: string;
  readonly bindingId?: string;
  readonly implementationClass?: CapabilityBinding['implementationClass'];
  /** Present whenever a contract was successfully built for this step, regardless of `status` — a step can be `'unbound'` (no resolver produced a binding) and still have a perfectly real, known set of declared/rule-derived inputs/outputs worth showing. */
  readonly inputs?: readonly CandidateWorkflowStepParameter[];
  readonly outputs?: readonly CandidateWorkflowStepParameter[];
}

export interface PrepareCandidateWorkflowResult {
  /** Executable graph containing exactly the `'bound'` steps below, in `CandidateWorkflowStep.order`. Sequential edges only — this bridge does not attempt to infer parallelism from `workflow-composer`'s (frequently tie-broken, source-derived, or absent) ordering evidence; see that package's own `WorkflowGap`s for why a stronger claim isn't warranted today. */
  readonly graph: WorkflowGraph;
  /** Every step from the input workflow, in original order — `'bound'` steps are also present in `graph`; `'unbound'` steps never are. */
  readonly steps: readonly CandidateWorkflowStepBridgeResult[];
  readonly unboundStepCount: number;
  /**
   * Every `'proven'` `StepDataBinding` `@xo/workflow-composer#auditWorkflowDataFlow`
   * (reused verbatim, unmodified) found for `workflow` — regardless of
   * whether it was actually wired into an executable injection below.
   * Exposed so a caller/report can show the *full* data-flow picture,
   * not just the subset this bridge could act on.
   */
  readonly provenDataFlowBindings: readonly StepDataBinding[];
  /**
   * The subset of `provenDataFlowBindings` this bridge actually wired
   * into the graph as a runtime input injection — i.e. both the
   * producer and consumer steps are themselves `'bound'`, AND the
   * producer's binding is `'deterministic_rule'` (never
   * `'human_in_the_loop'` — an escalation record is never an
   * authoritative business value; see Phase 8 in the bridging brief and
   * `makeCapabilityAuthorityNodeHandler`'s own doc comment). A
   * `'proven'` binding whose producer or consumer step didn't resolve
   * to an executable binding is reported above but never appears here —
   * there is nothing to inject at runtime for a step that never runs.
   */
  readonly wiredInjections: readonly StepDataBinding[];
}

function buildContractForStep(graph: XoirGraph, capabilityId: string): SemanticCapabilityContract | undefined {
  const nodeResult = graph.getNode(XoirNodeId(capabilityId));
  if (!nodeResult.ok) return undefined;
  const extracted = extractContractFromPropertyBag(nodeResult.value.properties);
  if (extracted.ok) return extracted.value;
  const built = buildSemanticCapabilityContract(graph, XoirNodeId(capabilityId));
  return built.ok ? built.value : undefined;
}

/**
 * Resolves and registers every executable step of `workflow` against
 * `registry`, then returns a `WorkflowGraph` containing only those steps
 * (in order), plus a per-step report of what was bound and what wasn't
 * and why. Registration reuses `registerResolvedCapabilityBinding`
 * verbatim — this function performs no execution-authority decision of
 * its own beyond "is this workflow step's already-resolved binding one
 * of the two classes that function accepts".
 */
export function prepareCandidateWorkflowForExecution(
  workflow: CandidateWorkflow,
  graph: XoirGraph,
  registry: RuntimeCapabilityRegistry,
  /**
   * Optional, keyed by `CandidateWorkflowStep.capabilityId`: a caller-
   * supplied implementation for a specific capability, used INSTEAD of
   * the two standard resolvers for that one capability only. This is
   * the seam Phase 9 of the "Structured JSON — Authoritative I/O"
   * milestone calls for: "the source declares the capability's I/O, the
   * test/demo supplies the implementation" — no source (JSON, PDF, or
   * otherwise) can honestly assert an arithmetic formula is a document
   * fact, so an implementation for e.g. a `calculate_brokerage`
   * operation must come from outside the compiler, supplied by whoever
   * is running the workflow. Deliberately NOT a generic formula engine
   * or expression language: this bridge does not interpret, parse, or
   * validate what the override computes — it only registers whatever
   * `CapabilityBinding` the caller hands it through the existing,
   * unchanged `registerResolvedCapabilityBinding` path. The contract
   * (and therefore `contract.outputs`'s declared-output evidence) is
   * still built from the real compiled source exactly as for any other
   * step; only the execution `evaluate` implementation is supplied
   * externally. No capability id is ever special-cased inside
   * `WorkflowExecutor` or `makeCapabilityAuthorityNodeHandler` — both
   * remain fully generic; the override is a parameter *to this
   * function*, chosen entirely by the caller.
   */
  bindingOverrides?: ReadonlyMap<string, CapabilityBinding>,
): PrepareCandidateWorkflowResult {
  const steps: CandidateWorkflowStepBridgeResult[] = [];
  const nodes: WorkflowNode[] = [{ id: NodeId('start'), type: 'start' }];
  const edges: WorkflowEdge[] = [];
  let previous: NodeId = NodeId('start');

  // capabilityId -> { nodeId, implementationClass } for every step that
  // actually became an executable node below — used after the main loop
  // to decide which `'proven'` data-flow bindings can be safely wired as
  // a runtime injection (see `wiredInjections`'s doc comment for the
  // eligibility rule).
  const boundNodesByCapabilityId = new Map<string, { nodeId: NodeId; implementationClass: CapabilityBinding['implementationClass'] }>();

  const ordered = [...workflow.steps].sort((a, b) => a.order - b.order);

  for (const step of ordered) {
    const contract = buildContractForStep(graph, step.capabilityId);
    if (!contract) {
      steps.push({
        capabilityId: step.capabilityId,
        capabilityName: step.capabilityName,
        status: 'unbound',
        reason: 'No semantic capability contract could be built for this capability node — no XOIR node found, or extraction/build both failed.',
      });
      continue;
    }

    const override = bindingOverrides?.get(step.capabilityId);
    const contractParams = { inputs: contract.inputs.map(toStepParameter), outputs: contract.outputs.map(toStepParameter) };
    let binding: CapabilityBinding;
    if (override) {
      binding = override;
    } else {
      const outcome = resolveContractBinding(contract);
      if (outcome.status !== 'resolved') {
        steps.push({
          capabilityId: step.capabilityId,
          capabilityName: step.capabilityName,
          status: 'unbound',
          reason: `No resolver produced a resolved binding (resolution status: "${outcome.status}"). Neither a structured comparison rule nor grounded action-knowledge evidence exists for this capability.`,
          contractId: contract.id,
          ...contractParams,
        });
        continue;
      }
      binding = outcome.binding;
    }

    const registration = registerResolvedCapabilityBinding(registry, contract, binding, { graphHash: ContentHash(graph.contentHash()) });
    if (!registration.ok) {
      steps.push({
        capabilityId: step.capabilityId,
        capabilityName: step.capabilityName,
        status: 'unbound',
        reason: `Binding resolved but could not be registered: ${registration.error.message}`,
        contractId: contract.id,
        bindingId: binding.id,
        ...contractParams,
      });
      continue;
    }

    const nodeId = NodeId(`step_${step.order}_${step.capabilityId}`);
    nodes.push({
      id: nodeId,
      type: 'custom:capability-authority',
      name: step.capabilityName,
      config: { capabilityId: contract.id, structuredInput: {}, inputBindings: [] },
    });
    edges.push({ from: previous, to: nodeId });
    previous = nodeId;
    boundNodesByCapabilityId.set(step.capabilityId, { nodeId, implementationClass: binding.implementationClass });

    steps.push({
      capabilityId: step.capabilityId,
      capabilityName: step.capabilityName,
      status: 'bound',
      contractId: contract.id,
      bindingId: binding.id,
      implementationClass: binding.implementationClass,
      ...contractParams,
    });
  }

  nodes.push({ id: NodeId('end'), type: 'end' });
  edges.push({ from: previous, to: NodeId('end') });

  // Reuses `@xo/workflow-composer#auditWorkflowDataFlow` verbatim — this
  // bridge performs no data-flow analysis of its own. A binding is
  // `'proven'` only when it already passed that function's authority
  // standard (exact field-name match after normalization + type
  // compatibility + structural graph corroboration) — name similarity,
  // sequence, process membership, and bare PRODUCES/CONSUMES handoffs
  // are `'suggestive'` at best and never reach this list.
  const dataFlow = auditWorkflowDataFlow(workflow, graph);
  const provenDataFlowBindings = dataFlow.bindings.filter((b) => b.status === 'proven');

  const wiredInjections: StepDataBinding[] = [];
  const inputBindingsByConsumerNodeId = new Map<NodeId, { inputParameterName: string; producerNodeId: NodeId; outputParameterName: string }[]>();
  for (const binding of provenDataFlowBindings) {
    const producer = boundNodesByCapabilityId.get(binding.producerCapabilityId);
    const consumer = boundNodesByCapabilityId.get(binding.consumerCapabilityId);
    if (!producer || !consumer) continue; // Producer or consumer never became an executable node — nothing to inject at runtime.

    // A `human_in_the_loop` binding's evaluate() always returns an
    // escalation record (see `ActionEscalationBindingResolver`), never a
    // real business value — injecting from one would fabricate the very
    // human decision the workflow is honestly waiting on. Only a
    // `deterministic_rule` producer's actual computed result is ever
    // eligible. This check is generic (keyed on implementationClass, not
    // any capability id/name), not specific to any one document.
    if (producer.implementationClass !== 'deterministic_rule') continue;

    const list = inputBindingsByConsumerNodeId.get(consumer.nodeId) ?? [];
    list.push({ inputParameterName: binding.inputParameterName, producerNodeId: producer.nodeId, outputParameterName: binding.outputParameterName });
    inputBindingsByConsumerNodeId.set(consumer.nodeId, list);
    wiredInjections.push(binding);
  }

  const finalNodes = nodes.map((n) => {
    const bindings = inputBindingsByConsumerNodeId.get(n.id);
    if (!bindings) return n;
    return { ...n, config: { ...(n.config ?? {}), inputBindings: bindings } };
  });

  return {
    graph: { graphId: `candidate:${workflow.id}`, version: '1', nodes: finalNodes, edges, startNodeId: NodeId('start') },
    steps,
    unboundStepCount: steps.filter((s) => s.status === 'unbound').length,
    provenDataFlowBindings,
    wiredInjections,
  };
}

/**
 * `NodeHandler` for `'custom:capability-authority'` nodes — the node type
 * `prepareCandidateWorkflowForExecution` emits above. Delegates entirely
 * to `RuntimeCapabilityExecutor.execute` (unchanged: same confidence
 * gate, same permission gate, same registry resolution) rather than the
 * built-in `'capability'` node type's `ExecutionPipeline`/mounted-package
 * path, because Action Capability Binding v1 capabilities are
 * runtime-registered directly (never packaged into a mounted `.xo`) —
 * see `capability-binding-registration.ts`'s own doc comment on this
 * being "the only bridge ... between discovery/resolution and execution
 * authority". This is the documented `customNodeHandlers` extension
 * point (`WorkflowExecutorOptions.customNodeHandlers`); it is not a
 * second workflow engine or a second capability router.
 */
export function makeCapabilityAuthorityNodeHandler(executor: RuntimeCapabilityExecutor): NodeHandler {
  return async (node, context: WorkflowContext) => {
    const config = node.config ?? {};
    const capabilityId = typeof config.capabilityId === 'string' ? config.capabilityId : undefined;
    if (!capabilityId) {
      return err(new RuntimeError(ErrorCode.RUNTIME_INVALID_REQUEST, `Workflow node "${node.id}" (type "custom:capability-authority") is missing a string "capabilityId" in its config`));
    }
    const structuredInput: Record<string, unknown> = { ...((config.structuredInput as Record<string, unknown> | undefined) ?? {}) };

    // Resolve any proven input bindings `prepareCandidateWorkflowForExecution`
    // wired onto this node — each names an already-completed producer
    // node and the exact output field to read from
    // `context.state.outputs` (populated by `WorkflowExecutor` itself;
    // this handler adds no state of its own). A binding whose producer
    // hasn't completed yet, or whose named field isn't present on the
    // producer's captured output, is skipped rather than guessed —
    // matching Phase 7's "unbound inputs must remain explicit" rule; it
    // never falls back to a default or a fabricated value.
    const inputBindings = Array.isArray(config.inputBindings) ? (config.inputBindings as { inputParameterName: string; producerNodeId: string; outputParameterName: string }[]) : [];
    for (const binding of inputBindings) {
      const producerOutput = context.state.outputs[binding.producerNodeId];
      if (!producerOutput || typeof producerOutput !== 'object') continue;
      const producerResult = (producerOutput as Record<string, unknown>).result;
      if (!producerResult || typeof producerResult !== 'object') continue;
      if (!(binding.outputParameterName in (producerResult as Record<string, unknown>))) continue;
      structuredInput[binding.inputParameterName] = (producerResult as Record<string, unknown>)[binding.outputParameterName];
    }

    const result = await executor.execute({ capabilityId, input: structuredInput });
    if (!result.ok) return err(result.error);

    return ok({
      output: {
        capabilityId: result.value.capabilityId,
        contractId: result.value.contractId,
        bindingId: result.value.bindingId,
        sourceXoirNodeIds: result.value.sourceXoirNodeIds,
        result: result.value.output,
        // Provenance of *this* node's inputs — which came from an
        // upstream node's proven output vs. this node's own static
        // config — carried alongside the result so a caller/report can
        // show exactly where an injected value came from without
        // re-deriving it from the graph.
        ...(inputBindings.length > 0 ? { appliedInputBindings: inputBindings } : {}),
      },
    });
  };
}

/**
 * Honest, additional, product-surface classification of a workflow run —
 * deliberately NOT a replacement for, or reinterpretation of,
 * `WorkflowInstance.status` (an engine-level "did every dispatched node's
 * handler return without error" concept, unaware of what any given
 * node's *output* means). A `human_in_the_loop` binding's `evaluate`
 * always succeeds at producing an escalation record (see
 * `ActionEscalationBindingResolver`'s doc comment) — so a workflow made
 * entirely of such steps reaches engine status `'completed'` even though
 * not one real-world action has actually happened yet. Reporting that as
 * "workflow completed" to a human would be false. This function inspects
 * each bound node's captured output for `result.status ===
 * 'escalation_required'` and, if any is present, reports
 * `'waiting_for_human'` instead — never silently upgrading it to
 * `'completed'`. Never invents a workflow-engine-level status; only
 * derives an honest label for a caller (CLI/report layer) that must not
 * conflate "the engine ran cleanly" with "the business process is done".
 */
export type CandidateWorkflowRunStatus = 'completed' | 'waiting_for_human' | 'not_executable_yet' | 'failed';

export interface DeriveWorkflowRunStatusInput {
  readonly engineStatus: string;
  readonly nodeOutputs: Readonly<Record<string, unknown>>;
  readonly unboundStepCount: number;
  readonly boundStepCount: number;
}

export function deriveWorkflowRunStatus(input: DeriveWorkflowRunStatusInput): CandidateWorkflowRunStatus {
  if (input.boundStepCount === 0) return 'not_executable_yet';
  if (input.engineStatus === 'failed' || input.engineStatus === 'timed_out' || input.engineStatus === 'cancelled') return 'failed';

  // A workflow with any unbound step is, by definition, not fully
  // executable end-to-end yet — reported even if every bound step ran
  // cleanly, since "not_executable_yet" is a claim about the WHOLE
  // workflow, not about whichever subset happened to have evidence.
  if (input.unboundStepCount > 0) return 'not_executable_yet';

  const hasEscalation = Object.values(input.nodeOutputs).some((output) => {
    if (!output || typeof output !== 'object') return false;
    const result = (output as Record<string, unknown>).result;
    return !!result && typeof result === 'object' && (result as Record<string, unknown>).status === 'escalation_required';
  });
  if (hasEscalation) return 'waiting_for_human';

  if (input.engineStatus === 'completed') return 'completed';
  return 'not_executable_yet';
}
