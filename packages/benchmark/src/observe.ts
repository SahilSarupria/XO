import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorCode } from '@xo/errors';
import { ContentHash, type CapabilityInputSchema, type Result } from '@xo/types';
import { compileSources, discoverAndResolveCapabilities, lowerCapabilitiesToManifest, type LowerCapabilitiesResult } from '@xo/compiler';
import { fromJson, toJson, XoirNodeId, type XoirGraph, type XoirGraphJson } from '@xo/xoir';
import {
  buildSemanticCapabilityContract,
  normalizeToFallbackKey,
  validateCapabilityInput,
  type SemanticCapabilityParameter,
  projectAllCapabilityProvenance,
  computeContractContentHash,
  extractContractFromPropertyBag,
  StructuredComparisonBindingResolver,
  type SemanticCapabilityContract,
  projectExecutionProvenance,
  type CapabilityProvenance,
} from '@xo/capability-contract';
import { auditWorkflowDataFlow, auditWorkflowExecutability, composeWorkflows, type CandidateWorkflow } from '@xo/workflow-composer';
import {
  EnvironmentId,
  RuntimeCapabilityExecutor,
  RuntimeCapabilityRegistry,
  WorkflowExecutor,
  deriveWorkflowRunStatus,
  makeCapabilityAuthorityNodeHandler,
  prepareCandidateWorkflowForExecution,
  executeResolvedContract,
  resolveContractBinding,
  type PrepareCandidateWorkflowResult,
  type RuntimeCapabilityExecutionRequest,
} from '@xo/runtime';
import { establishTrustedExecutionContext, PermissionManager, resolveAuthoritativeDeclaration, RuleBasedPolicy } from '@xo/permissions';

/** Offline evaluation harness subject (P1.0 M2). Not an identity; matches no principal-scoped rule; the policy remains deny-by-default. */
const HARNESS_SUBJECT = establishTrustedExecutionContext('evaluation-harness');
import type { BenchmarkCaseDefinition, CapabilityExecutionCase, SourceSpec, WorkflowExecutionCase } from './definition.js';
import { compareStrings, fingerprintOf, isPlainObject } from './json.js';
import { matchesName, perfectAssignment } from './match.js';
import type { ObservedSourceReport } from './attribution.js';
import type { PathCapabilityView, PathExecutionView, PathView } from './cross-path.js';
import type {
  ObservedCapability,
  ObservedCapabilityProvenance,
  ObservedExecutionProvenance,
  ObservedCapabilityExecution,
  ObservedExecution,
  ObservedNode,
  ObservedParam,
  ObservedSourceRef,
  ObservedWorkflow,
  ObservedWorkflowExecution,
  ObservedWorkflowStepRun,
  PipelineObservation,
  StageName,
  StageStatus,
} from './observation.js';

/**
 * The pipeline OBSERVER. It calls the same real library functions, in the
 * same order, that the shipped surfaces already use:
 *
 *   compile      `compileSources`                                   (apps/api `compile-source.ts`, apps/cli `xo capabilities`/`xo workflow`)
 *   capabilities `packageXoirGraph` preview -> `LowerCapabilitiesResult`,
 *                `buildSemanticCapabilityContract`                   (same)
 *   workflows    `composeWorkflows` -> `auditWorkflowExecutability` /
 *                `auditWorkflowDataFlow` ->
 *                `prepareCandidateWorkflowForExecution`              (apps/cli `workflow-pipeline.ts`)
 *   execution    contract -> `resolveCapabilityBinding` ->
 *                `registerResolvedCapabilityBinding` ->
 *                `RuntimeCapabilityExecutor` (capabilities), and
 *                `WorkflowExecutor` + `makeCapabilityAuthorityNodeHandler`
 *                (workflows)                                         (apps/api P0.5 `execute-capability.ts`, apps/cli `workflow-pipeline.ts`)
 *
 * It contains no extraction, resolution, composition, or execution
 * semantics of its own and applies no thresholds or gates — a
 * benchmark that quietly "helped" the pipeline would measure itself.
 * (`apps/api` and `apps/cli` declare no importable `exports`, which is
 * why this short call sequence is repeated here rather than imported —
 * the same, already-established pattern those two apps follow with each
 * other. `apps/api/test/benchmark-equivalence.test.ts` pins that this
 * observer and the shipped API pipeline agree on the same source.)
 *
 * Every stage's outcome is captured separately so a failure is always
 * attributable to the stage where it happened.
 */

// P0.9B Steps 2, 4 and 5: this observer no longer re-declares the resolver
// list nor hand-assembles resolve -> register -> execute; it calls the same
// shared `resolveContractBinding` / `executeResolvedContract`
// (`@xo/runtime`) and `discoverAndResolveCapabilities` (`@xo/compiler`)
// every production path calls, so its equivalence role now checks the real
// implementation rather than a hand-copied duplicate of it.

/** Fixed `now` so `CandidateWorkflow.generatedAt` (never observed) cannot introduce nondeterminism. */
const FIXED_NOW = () => '1970-01-01T00:00:00.000Z';

export interface ObserveOptions {
  /** Directory that case `sources[].path` / `xoir` are resolved against. */
  readonly sourceRoot: string;
  /**
   * Test seam (P0.9C Step 6): the capability-lowering function the package-boundary view applies to its CLONE of the graph. Defaults to the real
   * `lowerCapabilitiesToManifest`; a test substitutes one that corrupts the embedded contracts to prove the view is derived from what lowering
   * actually wrote, not copied from the live view.
   */
  readonly lowerCapabilities?: typeof lowerCapabilitiesToManifest;
}

function emptyFingerprints(): PipelineObservation['fingerprints'] {
  const empty = fingerprintOf(null);
  return { compile: empty, capabilities: empty, workflows: empty, execution: empty };
}

function baseStages(): Record<StageName, StageStatus> {
  return {
    compile: { stage: 'compile', status: 'skipped' },
    capabilities: { stage: 'capabilities', status: 'skipped' },
    workflows: { stage: 'workflows', status: 'skipped' },
    execution: { stage: 'execution', status: 'not_requested' },
  };
}

/**
 * The compiler cites sources by `sourceId` (`src_<hash of type+path+content>`). The observer maps each id back to the `sourcePath` the case DECLARED
 * (the compiler's own `CompileSourcesResult.sources` report carries both), so
 * evidence expectations read "this fact cites Aastha.pdf page 2" instead of
 * an opaque hash — and stay valid across machines.
 */
type DocumentPathMap = ReadonlyMap<string, string>;

function toObservedRefs(
  refs: readonly { readonly documentPath: string; readonly locator?: string | undefined; readonly pages?: readonly number[] | undefined }[],
  docPaths: DocumentPathMap,
): ObservedSourceRef[] {
  return refs.map((r) => ({
    documentPath: docPaths.get(r.documentPath) ?? r.documentPath,
    ...(r.locator !== undefined ? { locator: r.locator } : {}),
    ...(r.pages !== undefined ? { pages: [...r.pages] } : {}),
  }));
}

function toObservedNodes(graph: XoirGraph, docPaths: DocumentPathMap): ObservedNode[] {
  return graph
    .allNodes()
    .map((n) => ({
      id: n.id as unknown as string,
      kind: n.kind as string,
      properties: n.properties as Readonly<Record<string, unknown>>,
      confidence: n.metadata.confidence,
      sourceRefs: toObservedRefs(n.metadata.sourceRefs, docPaths),
      ...(n.metadata.producedBy !== undefined ? { producedBy: n.metadata.producedBy } : {}),
      ...(n.metadata.subtype !== undefined ? { subtype: n.metadata.subtype } : {}),
    }))
    .sort((a, b) => compareStrings(a.id, b.id));
}

// ---------------------------------------------------------------------------
// Provenance (P0.9C Step 5): consume the P0.9B projection unchanged; never fabricate
// ---------------------------------------------------------------------------

function toObservedCapabilityProvenance(
  graph: XoirGraph,
  docPaths: DocumentPathMap,
): {
  readonly observed: ObservedCapabilityProvenance[];
  readonly byCapabilityId: Map<string, CapabilityProvenance>;
  readonly byContractId: Map<string, CapabilityProvenance>;
} {
  const first = projectAllCapabilityProvenance(graph);
  const second = new Map(projectAllCapabilityProvenance(graph).map((p) => [p.capabilityId, p.contractContentHash] as const));
  const observed = first.map((p): ObservedCapabilityProvenance => ({
    capabilityId: p.capabilityId,
    name: p.name,
    contractId: p.contractId,
    contractContentHash: p.contractContentHash,
    contractContentHashRecomputed: second.get(p.capabilityId) ?? '',
    graphHash: p.graphHash,
    binding: {
      status: p.binding.status,
      ...(p.binding.bindingId !== undefined ? { bindingId: p.binding.bindingId } : {}),
      ...(p.binding.implementationClass !== undefined ? { implementationClass: p.binding.implementationClass } : {}),
    },
    sourceXoirNodeIds: [...p.sourceXoirNodeIds],
    sourceRefs: toObservedRefs(p.sourceRefs, docPaths),
  }));
  return {
    observed,
    byCapabilityId: new Map(first.map((p) => [p.capabilityId, p] as const)),
    byContractId: new Map(first.map((p) => [p.contractId, p] as const)),
  };
}

/** P0.9C Step 5: execution provenance is descriptive observation data; it is never part of the stage fingerprint (exactly like `producedBy` and `subtype`). */
function withoutProvenance(e: ObservedExecution): ObservedExecution {
  if (e.kind === 'capability') {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { provenance: _drop, ...rest } = e;
    return rest;
  }
  return {
    ...e,
    steps: e.steps.map((st) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { provenance: _drop, ...rest } = st;
      return rest;
    }),
  };
}

/** What an execution recorded (verbatim) joined with P0.9B's agreement against the live-graph view. */
function toObservedExecutionProvenance(
  recorded: ObservedExecutionProvenance['recorded'],
  capabilityId: string,
  view: CapabilityProvenance | undefined,
): ObservedExecutionProvenance {
  const projected = projectExecutionProvenance(
    {
      capabilityId,
      ...(recorded.contractId !== undefined ? { contractId: recorded.contractId } : {}),
      ...(recorded.bindingId !== undefined ? { bindingId: recorded.bindingId } : {}),
      ...(recorded.sourceXoirNodeIds !== undefined ? { sourceXoirNodeIds: recorded.sourceXoirNodeIds } : {}),
      ...(recorded.graphHash !== undefined ? { graphHash: recorded.graphHash } : {}),
      ...(recorded.contractContentHash !== undefined ? { contractContentHash: recorded.contractContentHash } : {}),
    },
    view,
  );
  return { recorded, graphViewAvailable: view !== undefined, agreement: { ...projected.agreement } };
}

function recordedFacts(value: {
  readonly contractId?: string;
  readonly bindingId?: string;
  readonly sourceXoirNodeIds?: readonly string[];
  readonly graphHash?: string;
  readonly contractContentHash?: string;
}): ObservedExecutionProvenance['recorded'] {
  return {
    ...(value.contractId !== undefined ? { contractId: value.contractId } : {}),
    ...(value.bindingId !== undefined ? { bindingId: value.bindingId } : {}),
    ...(value.sourceXoirNodeIds !== undefined ? { sourceXoirNodeIds: [...value.sourceXoirNodeIds] } : {}),
    ...(value.graphHash !== undefined ? { graphHash: value.graphHash as string } : {}),
    ...(value.contractContentHash !== undefined ? { contractContentHash: value.contractContentHash as string } : {}),
  };
}

// ---------------------------------------------------------------------------
// Cross-path views (P0.9C Step 6): the same library calls the real paths make, run in-process on CLONES (the observed graph is never mutated)
// ---------------------------------------------------------------------------

function cloneGraph(graph: XoirGraph): XoirGraph | undefined {
  const cloned = fromJson(JSON.parse(JSON.stringify(toJson(graph))) as XoirGraphJson);
  return cloned.ok ? cloned.value : undefined;
}

function matchedOf(output: unknown): boolean | undefined {
  return isPlainObject(output) && typeof output['matched'] === 'boolean' ? output['matched'] : undefined;
}

/**
 * live_graph (the observation itself) + serialized_graph (a toJson/fromJson round trip of the same graph) + package_boundary (what the
 * packager does: capability lowering embeds contracts, the graph is serialized, and the installed router reads each contract back with
 * `extractContractFromPropertyBag` and resolves ONLY the structured-comparison binding). The archive / signing / install steps are not run.
 */
async function observePaths(
  graph: XoirGraph,
  observed: readonly ObservedCapabilityProvenance[],
  executions: readonly ObservedExecution[],
  requests: readonly (CapabilityExecutionCase | WorkflowExecutionCase)[],
  inputSchemaOf: (id: string) => CapabilityInputSchema | undefined,
  lower: typeof lowerCapabilitiesToManifest,
): Promise<readonly PathView[]> {
  const live: PathView = {
    path: 'live_graph',
    graphIdentity: 'unlowered',
    graphHash: graph.contentHash(),
    capabilities: observed.map((p): PathCapabilityView => ({
      capabilityId: p.capabilityId,
      name: p.name,
      contractContentHash: p.contractContentHash,
      binding: p.binding,
    })),
    executions: executions.flatMap((e): PathExecutionView[] =>
      e.kind === 'capability' && e.capabilityId !== undefined
        ? [
            {
              requestId: e.requestId,
              capabilityId: e.capabilityId,
              outcome: e.outcome,
              ...(matchedOf(e.output) !== undefined ? { matched: matchedOf(e.output)! } : {}),
              ...(e.provenance !== undefined ? { recorded: e.provenance.recorded } : {}),
            },
          ]
        : [],
    ),
  };
  const views: PathView[] = [live];

  const serialized = cloneGraph(graph);
  if (serialized !== undefined) {
    views.push({
      path: 'serialized_graph',
      graphIdentity: 'unlowered',
      graphHash: serialized.contentHash(),
      capabilities: projectAllCapabilityProvenance(serialized).map((p): PathCapabilityView => ({
        capabilityId: p.capabilityId,
        name: p.name,
        contractContentHash: p.contractContentHash,
        binding: {
          status: p.binding.status,
          ...(p.binding.bindingId !== undefined ? { bindingId: p.binding.bindingId } : {}),
          ...(p.binding.implementationClass !== undefined ? { implementationClass: p.binding.implementationClass } : {}),
        },
      })),
      executions: [],
    });
  }

  const lowered = cloneGraph(graph);
  if (lowered !== undefined) {
    lower(lowered);
    const packaged = cloneGraph(lowered); // the packager serializes the lowered graph; the installed router parses it back
    if (packaged !== undefined) {
      const contracts = new Map<string, ReturnType<typeof extractContractFromPropertyBag> & { ok: true }>();
      const caps: PathCapabilityView[] = [];
      for (const node of packaged.allNodes().filter((n) => n.kind === 'capability')) {
        const extracted = extractContractFromPropertyBag(node.properties as Readonly<Record<string, unknown>>);
        if (!extracted.ok) {
          caps.push({
            capabilityId: node.id,
            name: String((node.properties as Record<string, unknown>)['name'] ?? ''),
            contractEmbedded: false,
          });
          continue;
        }
        contracts.set(node.id, extracted as never);
        const outcome = resolveContractBinding(extracted.value, [new StructuredComparisonBindingResolver()]);
        caps.push({
          capabilityId: node.id,
          name: extracted.value.name,
          contractEmbedded: true,
          contractContentHash: computeContractContentHash(extracted.value),
          binding: {
            status: outcome.status,
            ...(outcome.status === 'resolved'
              ? { bindingId: outcome.binding.id, implementationClass: outcome.binding.implementationClass }
              : {}),
          },
        });
      }
      const runs: PathExecutionView[] = [];
      for (const e of executions) {
        if (e.kind !== 'capability' || e.capabilityId === undefined || (e.outcome !== 'succeeded' && e.outcome !== 'waiting_for_human'))
          continue;
        const entry = contracts.get(e.capabilityId);
        const request = requests.find((r) => r.id === e.requestId && r.kind === 'capability') as CapabilityExecutionCase | undefined;
        if (entry === undefined || request === undefined) continue;
        const contract = (entry as unknown as { value: SemanticCapabilityContract }).value;
        const outcome = resolveContractBinding(contract, [new StructuredComparisonBindingResolver()]); // mirrors `xo run`: never a wider set
        if (outcome.status !== 'resolved') continue;
        const input = request.input ?? {};
        const schema = inputSchemaOf(e.capabilityId);
        if (schema !== undefined && !validateCapabilityInput(schema, input).valid) continue;
        try {
          const result = await executeResolvedContract(contract, outcome.binding, {
            permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }),
            subject: HARNESS_SUBJECT,
            permissionDeclaration: resolveAuthoritativeDeclaration(contract.requiredPermissions, {
              capabilityId: contract.id,
              origin: 'trusted-host-registration', // evaluation harness acting as the host; self-attested from the contract it evaluates
              source: `contract ${contract.id}`,
            }),
            input,
          }); // no graphHash: there is no live graph on this path
          if (!result.ok) {
            runs.push({ requestId: e.requestId, capabilityId: e.capabilityId, outcome: 'error' });
            continue;
          }
          const output = result.value.output;
          const escalated = isPlainObject(output) && output['status'] === 'escalation_required';
          runs.push({
            requestId: e.requestId,
            capabilityId: e.capabilityId,
            outcome: escalated ? 'waiting_for_human' : 'succeeded',
            ...(matchedOf(output) !== undefined ? { matched: matchedOf(output)! } : {}),
            recorded: recordedFacts(result.value),
          });
        } catch {
          runs.push({ requestId: e.requestId, capabilityId: e.capabilityId, outcome: 'error' });
        }
      }
      views.push({
        path: 'package_boundary',
        graphIdentity: 'lowered',
        capabilities: caps.sort((a, b) => compareStrings(a.capabilityId, b.capabilityId)),
        executions: runs.sort((a, b) => compareStrings(a.requestId, b.requestId)),
      });
    }
  }
  return views;
}

function toObservedParam(p: SemanticCapabilityParameter): ObservedParam {
  return {
    name: p.name,
    runtimeKey: normalizeToFallbackKey(p.name),
    semanticType: p.semanticType ?? 'unknown',
    ...(p.derivedFrom !== undefined ? { derivedFrom: p.derivedFrom } : {}),
  };
}

async function loadSources(specs: readonly SourceSpec[], sourceRoot: string): Promise<unknown[]> {
  const inputs: unknown[] = [];
  for (const spec of specs) {
    const abs = join(sourceRoot, spec.path);
    if (spec.kind === 'pdf' || spec.kind === 'image') {
      inputs.push({ kind: spec.kind, bytes: new Uint8Array(await readFile(abs)), sourcePath: spec.path });
    } else {
      const text = await readFile(abs, 'utf8');
      if (spec.kind === 'document') inputs.push({ kind: 'document', text, sourcePath: spec.path });
      else if (spec.kind === 'html') inputs.push({ kind: 'html', html: text, sourcePath: spec.path });
      else if (spec.kind === 'openapi') inputs.push({ kind: 'openapi', text, sourcePath: spec.path });
      else inputs.push({ kind: 'structured', format: spec.format, text, sourcePath: spec.path });
    }
  }
  return inputs;
}

interface WorkflowHandle {
  readonly workflow: CandidateWorkflow;
  readonly observed: ObservedWorkflow;
}

export async function observeCase(definition: BenchmarkCaseDefinition, options: ObserveOptions): Promise<PipelineObservation> {
  const stages = baseStages();
  const entry: PipelineObservation['entry'] = definition.xoir !== undefined ? 'xoir' : 'sources';
  const harnessFailure = (message: string): PipelineObservation => ({
    entry,
    stages,
    harnessError: message,
    nodes: [],
    edgeCount: 0,
    capabilities: [],
    workflows: [],
    executions: [],
    fingerprints: emptyFingerprints(),
  });

  // ---- compile (or load a serialized XOIR graph) --------------------------------
  let graph: XoirGraph;
  let docPaths: DocumentPathMap = new Map();
  let sourceReports: ObservedSourceReport[] | undefined;
  if (definition.xoir !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(options.sourceRoot, definition.xoir), 'utf8'));
    } catch (cause) {
      return harnessFailure(`could not read XOIR fixture "${definition.xoir}": ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    const loaded = fromJson(parsed as XoirGraphJson);
    if (!loaded.ok)
      return harnessFailure(`XOIR fixture "${definition.xoir}" is not a valid graph: [${loaded.error.code}] ${loaded.error.message}`);
    graph = loaded.value;
    stages.compile = {
      stage: 'compile',
      status: 'skipped',
      note: 'entry is a serialized XOIR graph: source ingestion/extraction is not exercised; the real pipeline is entered at the packaging/contract stage',
    };
  } else {
    let inputs: unknown[];
    try {
      inputs = await loadSources(definition.sources ?? [], options.sourceRoot);
    } catch (cause) {
      return harnessFailure(`could not read source fixture: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    let compiled: Result<
      {
        readonly graph: XoirGraph;
        readonly sources: readonly {
          readonly sourceId: string;
          readonly sourcePath: string;
          readonly sourceType: string;
          readonly qualityState?: string;
          readonly semanticExtractionAvailable: boolean;
        }[];
      },
      { readonly code: string; readonly message: string }
    >;
    try {
      compiled = (await compileSources(
        inputs,
        definition.domainHint !== undefined ? { domainHint: definition.domainHint } : {},
      )) as typeof compiled;
    } catch (cause) {
      const message = `compiler threw unexpectedly: ${cause instanceof Error ? cause.message : String(cause)}`;
      stages.compile = { stage: 'compile', status: 'failed', errorCode: ErrorCode.UNKNOWN, errorMessage: message };
      return {
        entry,
        stages: withDownstreamSkipped(stages, 'compile'),
        nodes: [],
        edgeCount: 0,
        capabilities: [],
        workflows: [],
        executions: [],
        fingerprints: emptyFingerprints(),
      };
    }
    if (!compiled.ok) {
      stages.compile = { stage: 'compile', status: 'failed', errorCode: compiled.error.code, errorMessage: compiled.error.message };
      return {
        entry,
        stages: withDownstreamSkipped(stages, 'compile'),
        nodes: [],
        edgeCount: 0,
        capabilities: [],
        workflows: [],
        executions: [],
        fingerprints: emptyFingerprints(),
      };
    }
    graph = compiled.value.graph;
    docPaths = new Map(compiled.value.sources.map((src) => [src.sourceId, src.sourcePath]));
    sourceReports = compiled.value.sources.map((src) => ({
      sourceType: src.sourceType,
      path: src.sourcePath,
      ...(src.qualityState !== undefined ? { qualityState: src.qualityState } : {}),
      semanticExtractionAvailable: src.semanticExtractionAvailable,
    }));
    stages.compile = { stage: 'compile', status: 'ok' };
  }

  const nodes = toObservedNodes(graph, docPaths);
  const edgeCount = graph.allEdges().length;
  const compileFingerprint = fingerprintOf({
    nodes: nodes.map((n) => ({ id: n.id, kind: n.kind, properties: n.properties, confidence: n.confidence, refs: n.sourceRefs })),
    edges: graph
      .allEdges()
      .map((e) => [e.kind as string, e.fromId as unknown as string, e.toId as unknown as string])
      .sort((a, b) => compareStrings(a.join('|'), b.join('|'))),
  });

  // ---- capabilities (lowering / contracts / binding resolution) -----------------
  let lowered: LowerCapabilitiesResult | undefined;
  try {
    const resolved = discoverAndResolveCapabilities(graph, { previewLabel: 'benchmark observation preview' });
    if (!resolved.ok) {
      stages.capabilities = {
        stage: 'capabilities',
        status: 'failed',
        errorCode: resolved.error.code,
        errorMessage: resolved.error.message,
      };
    } else {
      lowered = resolved.value;
      stages.capabilities = { stage: 'capabilities', status: 'ok' };
    }
  } catch (cause) {
    stages.capabilities = {
      stage: 'capabilities',
      status: 'failed',
      errorCode: ErrorCode.UNKNOWN,
      errorMessage: `capability lowering threw unexpectedly: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  const nodeById = new Map(graph.allNodes().map((n) => [n.id as unknown as string, n]));
  const capabilities: ObservedCapability[] = [];
  if (lowered !== undefined) {
    for (const outcome of lowered.outcomes) {
      const node = nodeById.get(outcome.contractId);
      const contract = node !== undefined ? buildSemanticCapabilityContract(graph, XoirNodeId(outcome.contractId)) : undefined;
      const mode = outcome.declaration?.execution?.mode;
      const executionClass =
        mode === 'deterministic_rule' || mode === 'human_in_the_loop' || mode === 'model' || mode === 'hybrid' ? mode : 'not_executable';
      capabilities.push({
        capabilityId: outcome.contractId,
        name: outcome.declaration?.name ?? outcome.name,
        resolution: outcome.status,
        executionClass,
        ...(executionClass === 'not_executable' ? { notExecutableReason: outcome.reason ?? `binding status "${outcome.status}"` } : {}),
        inputs: contract?.ok === true ? contract.value.inputs.map(toObservedParam) : [],
        outputs: contract?.ok === true ? contract.value.outputs.map(toObservedParam) : [],
        confidence: node?.metadata.confidence ?? 0,
        sourceRefs: toObservedRefs(node?.metadata.sourceRefs ?? [], docPaths),
      });
    }
    capabilities.sort((a, b) => compareStrings(a.capabilityId, b.capabilityId));
  }
  const nameOfCapability = new Map(capabilities.map((c) => [c.capabilityId, c.name]));
  const inputSchemaOf = (capabilityId: string) =>
    lowered?.outcomes.find((o) => o.contractId === capabilityId)?.declaration?.execution?.inputSchema;

  // ---- workflows ----------------------------------------------------------------
  const workflowHandles: WorkflowHandle[] = [];
  let composed: readonly CandidateWorkflow[] = [];
  try {
    const result = composeWorkflows(graph, { now: FIXED_NOW });
    if (!result.ok) {
      stages.workflows = { stage: 'workflows', status: 'failed', errorCode: result.error.code, errorMessage: result.error.message };
    } else {
      composed = result.value;
      stages.workflows = { stage: 'workflows', status: 'ok' };
    }
  } catch (cause) {
    stages.workflows = {
      stage: 'workflows',
      status: 'failed',
      errorCode: ErrorCode.UNKNOWN,
      errorMessage: `workflow composition threw unexpectedly: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  for (const workflow of composed) {
    const audit = auditWorkflowExecutability(workflow, graph);
    const dataFlow = auditWorkflowDataFlow(workflow, graph);
    const prepared = prepareCandidateWorkflowForExecution(workflow, graph, new RuntimeCapabilityRegistry());
    const wired = new Set(
      prepared.wiredInjections.map(
        (b) => `${b.producerCapabilityId}|${b.outputParameterName}|${b.consumerCapabilityId}|${b.inputParameterName}`,
      ),
    );
    const nameOf = (id: string): string =>
      nameOfCapability.get(id) ?? workflow.steps.find((s) => s.capabilityId === id)?.capabilityName ?? id;
    const observed: ObservedWorkflow = {
      workflowId: workflow.id,
      steps: workflow.steps.map((step, i) => {
        const bridge = prepared.steps[i];
        const cls =
          bridge?.status === 'bound' &&
          (bridge.implementationClass === 'deterministic_rule' || bridge.implementationClass === 'human_in_the_loop')
            ? bridge.implementationClass
            : 'not_executable';
        return {
          order: step.order,
          capabilityId: step.capabilityId,
          name: step.capabilityName,
          bound: bridge?.status === 'bound',
          executionClass: cls,
        };
      }),
      executability: audit.status,
      blockerKinds: [...new Set(audit.blockers.map((b) => b.kind as string))].sort(compareStrings),
      bindings: dataFlow.bindings
        .map((b) => ({
          producerCapabilityId: b.producerCapabilityId,
          producerName: nameOf(b.producerCapabilityId),
          output: b.outputParameterName,
          consumerCapabilityId: b.consumerCapabilityId,
          consumerName: nameOf(b.consumerCapabilityId),
          input: b.inputParameterName,
          status: b.status as string,
          wired: wired.has(`${b.producerCapabilityId}|${b.outputParameterName}|${b.consumerCapabilityId}|${b.inputParameterName}`),
        }))
        .sort((a, b) =>
          compareStrings(
            `${a.producerCapabilityId}|${a.output}|${a.consumerCapabilityId}|${a.input}`,
            `${b.producerCapabilityId}|${b.output}|${b.consumerCapabilityId}|${b.input}`,
          ),
        ),
    };
    workflowHandles.push({ workflow, observed });
  }
  const workflows = workflowHandles.map((h) => h.observed).sort((a, b) => compareStrings(a.workflowId, b.workflowId));

  // ---- execution (only what the case asks for) ----------------------------------
  const provenance = toObservedCapabilityProvenance(graph, docPaths);
  const executions: ObservedExecution[] = [];
  const requests = definition.execution ?? [];
  if (requests.length > 0) {
    stages.execution = { stage: 'execution', status: 'ok' };
    for (const request of requests) {
      try {
        if (request.kind === 'capability')
          executions.push(await runCapabilityRequest(graph, capabilities, inputSchemaOf, request, provenance.byCapabilityId));
        else executions.push(await runWorkflowRequest(graph, workflowHandles, request, nameOfCapability, provenance.byContractId));
      } catch (cause) {
        // A runtime-internal throw is an honest execution failure of THIS request, never a crashed benchmark.
        const message = `runtime threw unexpectedly: ${cause instanceof Error ? cause.message : String(cause)}`;
        executions.push(
          request.kind === 'capability'
            ? { requestId: request.id, kind: 'capability', outcome: 'error', errorCode: ErrorCode.UNKNOWN, message }
            : {
                requestId: request.id,
                kind: 'workflow',
                outcome: 'ran',
                runStatus: 'failed',
                steps: [],
                errorCode: ErrorCode.UNKNOWN,
                message,
              },
        );
      }
    }
    executions.sort((a, b) => compareStrings(a.requestId, b.requestId));
  }

  return {
    entry,
    stages,
    ...(sourceReports !== undefined ? { sourceReports } : {}),
    nodes,
    edgeCount,
    capabilities,
    workflows,
    executions,
    provenance: { capabilities: provenance.observed },
    ...(entry === 'sources'
      ? {
          paths: await observePaths(
            graph,
            provenance.observed,
            executions,
            requests,
            inputSchemaOf,
            options.lowerCapabilities ?? lowerCapabilitiesToManifest,
          ),
        }
      : {}),
    fingerprints: {
      compile: compileFingerprint,
      capabilities: fingerprintOf(capabilities),
      workflows: fingerprintOf(workflows),
      execution: fingerprintOf(executions.map(withoutProvenance)),
    },
  };
}

function withDownstreamSkipped(stages: Record<StageName, StageStatus>, failed: StageName): Record<StageName, StageStatus> {
  const order: StageName[] = ['compile', 'capabilities', 'workflows', 'execution'];
  const out = { ...stages };
  for (const stage of order.slice(order.indexOf(failed) + 1)) {
    if (stage === 'execution' && out.execution.status === 'not_requested') continue;
    out[stage] = { stage, status: 'skipped', note: `skipped: the "${failed}" stage failed` };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Capability execution — the P0.5 single-capability path
// ---------------------------------------------------------------------------

async function runCapabilityRequest(
  graph: XoirGraph,
  capabilities: readonly ObservedCapability[],
  inputSchemaOf: (id: string) => CapabilityInputSchema | undefined,
  request: CapabilityExecutionCase,
  viewOf: ReadonlyMap<string, CapabilityProvenance>,
): Promise<ObservedCapabilityExecution> {
  const candidates = capabilities.filter((c) => matchesName(c.name, request.target));
  if (candidates.length === 0) return { requestId: request.id, kind: 'capability', outcome: 'target_not_found', candidateCount: 0 };
  if (candidates.length > 1)
    return { requestId: request.id, kind: 'capability', outcome: 'target_ambiguous', candidateCount: candidates.length };
  const cap = candidates[0]!;
  const base = {
    requestId: request.id,
    kind: 'capability' as const,
    capabilityId: cap.capabilityId,
    capabilityName: cap.name,
    resolution: cap.resolution,
  };

  const contract = buildSemanticCapabilityContract(graph, XoirNodeId(cap.capabilityId));
  if (!contract.ok) return { ...base, outcome: 'error', errorCode: contract.error.code, message: contract.error.message };
  const bindingOutcome = resolveContractBinding(contract.value);
  if (bindingOutcome.status !== 'resolved')
    return { ...base, outcome: 'not_executable', message: `${bindingOutcome.status}: ${bindingOutcome.reason}` };

  const input = request.input ?? {};
  const schema = inputSchemaOf(cap.capabilityId);
  if (schema !== undefined) {
    const validation = validateCapabilityInput(schema, input);
    if (!validation.valid)
      return { ...base, outcome: 'invalid_input', message: validation.issues.map((i) => `${i.property}: ${i.message}`).join('; ') };
  }

  const result = await executeResolvedContract(contract.value, bindingOutcome.binding, {
    permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }),
    subject: HARNESS_SUBJECT,
    permissionDeclaration: resolveAuthoritativeDeclaration(contract.value.requiredPermissions, {
      capabilityId: contract.value.id,
      origin: 'trusted-host-registration', // evaluation harness acting as the host; self-attested from the contract it evaluates
      source: `contract ${contract.value.id}`,
    }),
    input,
    graphHash: ContentHash(graph.contentHash()),
  });
  if (!result.ok) return { ...base, outcome: 'error', errorCode: result.error.code, message: result.error.message };
  const output = result.value.output;
  const escalated = isPlainObject(output) && output['status'] === 'escalation_required';
  const provenance = toObservedExecutionProvenance(recordedFacts(result.value), cap.capabilityId, viewOf.get(cap.capabilityId));
  return { ...base, outcome: escalated ? 'waiting_for_human' : 'succeeded', output, provenance };
}

// ---------------------------------------------------------------------------
// Workflow execution — the CLI `xo workflow` runtime path
// ---------------------------------------------------------------------------

/** Wraps the real executor to record the input each capability was ACTUALLY executed with (so runtime data-flow injection is observed, not inferred from configuration). Composition, not a second executor: every call is delegated. */
class InputRecordingExecutor {
  readonly inputsByContractId = new Map<string, Record<string, unknown>>();
  /** P0.9C Step 5: the runtime's own recorded provenance for each executed capability, verbatim. */
  readonly factsByContractId = new Map<string, ObservedExecutionProvenance['recorded']>();
  constructor(private readonly inner: RuntimeCapabilityExecutor) {}
  async execute(request: RuntimeCapabilityExecutionRequest): ReturnType<RuntimeCapabilityExecutor['execute']> {
    this.inputsByContractId.set(request.capabilityId, isPlainObject(request.input) ? { ...request.input } : {});
    const result = await this.inner.execute(request);
    if (result.ok) this.factsByContractId.set(request.capabilityId, recordedFacts(result.value));
    return result;
  }
}

async function runWorkflowRequest(
  graph: XoirGraph,
  handles: readonly WorkflowHandle[],
  request: WorkflowExecutionCase,
  nameOfCapability: ReadonlyMap<string, string>,
  viewOfContract: ReadonlyMap<string, CapabilityProvenance>,
): Promise<ObservedWorkflowExecution> {
  const matching = handles.filter((h) => perfectAssignment(request.steps, h.observed.steps, (s) => s.name));
  if (matching.length === 0) return { requestId: request.id, kind: 'workflow', outcome: 'target_not_found', steps: [], candidateCount: 0 };
  if (matching.length > 1)
    return { requestId: request.id, kind: 'workflow', outcome: 'target_ambiguous', steps: [], candidateCount: matching.length };
  const handle = matching[0]!;

  // The product gate: only an `executable_candidate` workflow whose every step binds may run (apps/api P0.8 returns 422 WORKFLOW_NOT_EXECUTABLE; `xo workflow` prints the audit verdict). The raw runtime bridge itself does not consult the audit, so the gate is applied here rather than letting a not-executable workflow "complete".
  if (handle.observed.executability !== 'executable_candidate' || handle.observed.steps.some((s) => !s.bound)) {
    return {
      requestId: request.id,
      kind: 'workflow',
      workflowId: handle.workflow.id,
      workflowExecutability: handle.observed.executability,
      outcome: 'refused',
      runStatus: 'not_executable_yet',
      steps: [],
      message: `workflow audit status is "${handle.observed.executability}"${handle.observed.steps.some((s) => !s.bound) ? ' and at least one step is unbound' : ''}; not run`,
    };
  }

  const registry = new RuntimeCapabilityRegistry();
  const prepared: PrepareCandidateWorkflowResult = prepareCandidateWorkflowForExecution(handle.workflow, graph, registry);
  const payload = request.input;
  // The CLI's documented "trigger payload" semantics: merged, unmodified, into every capability-authority node's structured input.
  const graphToRun =
    payload !== undefined
      ? {
          ...prepared.graph,
          nodes: prepared.graph.nodes.map((n) =>
            n.type === 'custom:capability-authority'
              ? {
                  ...n,
                  config: {
                    ...n.config,
                    structuredInput: { ...(n.config?.structuredInput as Record<string, unknown> | undefined), ...payload },
                  },
                }
              : n,
          ),
        }
      : prepared.graph;

  const real = new RuntimeCapabilityExecutor({
    registry,
    permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }),
    subject: HARNESS_SUBJECT,
  });
  const recorder = new InputRecordingExecutor(real);
  // `makeCapabilityAuthorityNodeHandler` types its parameter as the concrete class (private members make a structurally identical object non-assignable); it only ever calls `.execute`. One cast — composition rather than a subclass.
  const handler = makeCapabilityAuthorityNodeHandler(recorder as unknown as RuntimeCapabilityExecutor);
  const engine = new WorkflowExecutor(
    async () => {
      throw new Error('unreachable: this bridge graph contains no built-in "capability" nodes');
    },
    { customNodeHandlers: new Map([['custom:capability-authority', handler]]) },
  );
  const run = await engine.run(graphToRun, {
    environmentId: EnvironmentId(`env_benchmark_${handle.workflow.id}`),
    hostProfile: { family: 'generic' as const, capabilities: [] },
    createdAt: '1970-01-01T00:00:00.000Z',
  });

  const runStatus = deriveWorkflowRunStatus({
    engineStatus: run.instance.status,
    nodeOutputs: run.instance.state.outputs,
    unboundStepCount: prepared.unboundStepCount,
    boundStepCount: prepared.steps.length - prepared.unboundStepCount,
  });

  const steps: ObservedWorkflowStepRun[] = [];
  for (const node of prepared.graph.nodes.filter((n) => n.type === 'custom:capability-authority')) {
    const nodeId = node.id as unknown as string;
    const out = run.instance.state.outputs[nodeId] as { capabilityId?: string; result?: unknown } | undefined;
    const history = run.instance.state.history.find((h) => h.nodeId === nodeId);
    const contractId = typeof node.config?.capabilityId === 'string' ? node.config.capabilityId : undefined;
    const actualInput = contractId !== undefined ? recorder.inputsByContractId.get(contractId) : undefined;
    const facts = contractId !== undefined ? recorder.factsByContractId.get(contractId) : undefined;
    const outputStatus =
      isPlainObject(out?.result) && typeof out.result['status'] === 'string' ? (out.result['status'] as string) : undefined;
    steps.push({
      capabilityId: contractId ?? nodeId,
      name: contractId !== undefined ? (nameOfCapability.get(contractId) ?? node.name ?? contractId) : (node.name ?? nodeId),
      engineStepStatus: history?.status ?? 'not_reached',
      ...(outputStatus !== undefined ? { outputStatus } : {}),
      ...(out?.result !== undefined ? { output: out.result } : {}),
      ...(actualInput !== undefined ? { actualInput } : {}),
      ...(facts !== undefined && contractId !== undefined
        ? { provenance: toObservedExecutionProvenance(facts, contractId, viewOfContract.get(contractId)) }
        : {}),
    });
  }

  return {
    requestId: request.id,
    kind: 'workflow',
    workflowId: handle.workflow.id,
    workflowExecutability: handle.observed.executability,
    outcome: 'ran',
    runStatus,
    engineStatus: run.instance.status as string,
    steps,
    ...(run.error !== undefined ? { errorCode: run.error.code, message: run.error.message } : {}),
  };
}
