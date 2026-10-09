import { compileSources, type CompileSourcesOptions, type CompileSourcesResult } from '@xo/compiler';
import { composeWorkflows, auditWorkflowExecutability, auditWorkflowDataFlow, type CandidateWorkflow, type WorkflowExecutabilityReport, type WorkflowDataFlowReport } from '@xo/workflow-composer';
import {
  RuntimeCapabilityRegistry,
  RuntimeCapabilityExecutor,
  WorkflowExecutor,
  EnvironmentId,
  prepareCandidateWorkflowForExecution,
  makeCapabilityAuthorityNodeHandler,
  deriveWorkflowRunStatus,
  type PrepareCandidateWorkflowResult,
  type CandidateWorkflowRunStatus,
} from '@xo/runtime';
import { PermissionManager, RuleBasedPolicy } from '@xo/permissions';
import { collectSources } from '../compiler/source-collection.js';

/**
 * The single set of inputs every "compile a source, compose a real
 * workflow, execute it through the real runtime" command needs. Both
 * `workflow.ts` (`xo workflow`) and `demo.ts` (`xo demo`) build one of
 * these from their own CLI flags and hand it to {@link runWorkflowPipeline}
 * — neither file re-implements compilation, composition, binding
 * resolution, or execution itself.
 */
export interface WorkflowPipelineOptions {
  readonly source: string;
  readonly domainHint?: string;
  readonly workflowId?: string;
  readonly workflowIndex?: number;
  /** A real, user-supplied "trigger payload" — see `workflow.ts`'s own doc comment for the exact contract (merged unmodified, never inferred/defaulted). */
  readonly input?: Readonly<Record<string, unknown>>;
}

export interface WorkflowStepResult {
  readonly nodeId: unknown;
  readonly capabilityName: string;
  readonly engineStepStatus: string;
  readonly output: { readonly status?: string } | undefined;
}

export type WorkflowPipelineFailure = { readonly ok: false; readonly message: string };

export interface WorkflowPipelineSuccess {
  readonly ok: true;
  readonly compiled: CompileSourcesResult;
  readonly discoveredWorkflowCount: number;
  readonly workflow: CandidateWorkflow;
  readonly selectionRationale: string;
  readonly execReport: WorkflowExecutabilityReport;
  readonly dataFlow: WorkflowDataFlowReport;
  readonly prepared: PrepareCandidateWorkflowResult;
  readonly engineStatus: string;
  readonly runStatus: CandidateWorkflowRunStatus;
  readonly stepResults: readonly WorkflowStepResult[];
}

export type WorkflowPipelineResult = WorkflowPipelineFailure | WorkflowPipelineSuccess;

/**
 * Runs the exact production path — `compileSources` -> `composeWorkflows`
 * -> (select) -> `auditWorkflowExecutability`/`auditWorkflowDataFlow` ->
 * `prepareCandidateWorkflowForExecution` -> `WorkflowExecutor` +
 * `RuntimeCapabilityExecutor` — once, and returns every intermediate
 * result a caller might want to render. This is the only place either
 * `xo workflow` or `xo demo` touches these packages; both commands are
 * presentation over this shared result.
 */
export async function runWorkflowPipeline(options: WorkflowPipelineOptions): Promise<WorkflowPipelineResult> {
  let collected: Awaited<ReturnType<typeof collectSources>>;
  try {
    collected = await collectSources([options.source]);
  } catch (cause) {
    return { ok: false, message: `could not read "${options.source}": ${(cause as Error).message}` };
  }

  try {
    const compileOptions: CompileSourcesOptions = options.domainHint !== undefined ? { domainHint: options.domainHint } : {};
    const compileResult = await compileSources(collected.inputs, compileOptions);
    if (!compileResult.ok) return { ok: false, message: `[${compileResult.error.code}] ${compileResult.error.message}` };
    const compiled = compileResult.value;
    const { graph } = compiled;

    const composed = composeWorkflows(graph, {});
    if (!composed.ok) return { ok: false, message: `[${composed.error.code}] ${composed.error.message}` };
    if (composed.value.length === 0) return { ok: false, message: 'no candidate workflows were discovered in this source' };

    const { workflow, rationale } = selectWorkflow(composed.value, options);
    if (!workflow) return { ok: false, message: rationale };

    const execReport = auditWorkflowExecutability(workflow, graph);
    const dataFlow = auditWorkflowDataFlow(workflow, graph);

    const registry = new RuntimeCapabilityRegistry();
    const prepared = prepareCandidateWorkflowForExecution(workflow, graph, registry);
    const graphToRun = options.input
      ? {
          ...prepared.graph,
          nodes: prepared.graph.nodes.map((n) =>
            n.type === 'custom:capability-authority'
              ? { ...n, config: { ...n.config, structuredInput: { ...(n.config?.structuredInput as Record<string, unknown> | undefined), ...options.input } } }
              : n,
          ),
        }
      : prepared.graph;

    const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }) });
    const workflowExecutor = new WorkflowExecutor(
      async () => {
        throw new Error('unreachable: this bridge graph contains no built-in "capability" nodes');
      },
      { customNodeHandlers: new Map([['custom:capability-authority', makeCapabilityAuthorityNodeHandler(executor)]]) },
    );

    const environment = { environmentId: EnvironmentId(`env_cli_${workflow.id}`), hostProfile: { family: 'generic' as const, capabilities: [] }, createdAt: new Date().toISOString() };
    const runResult = await workflowExecutor.run(graphToRun, environment);

    const runStatus = deriveWorkflowRunStatus({
      engineStatus: runResult.instance.status,
      nodeOutputs: runResult.instance.state.outputs,
      unboundStepCount: prepared.unboundStepCount,
      boundStepCount: prepared.steps.length - prepared.unboundStepCount,
    });

    const stepResults: WorkflowStepResult[] = prepared.graph.nodes
      .filter((n) => n.type === 'custom:capability-authority')
      .map((n) => {
        const raw = runResult.instance.state.outputs[n.id as unknown as string] as { result?: { status?: string } } | undefined;
        const historyEntry = runResult.instance.state.history.find((h) => h.nodeId === (n.id as unknown as string));
        return { nodeId: n.id, capabilityName: n.name ?? String(n.id), engineStepStatus: historyEntry?.status ?? '(not reached)', output: raw?.result };
      });

    return {
      ok: true,
      compiled,
      discoveredWorkflowCount: composed.value.length,
      workflow,
      selectionRationale: rationale,
      execReport,
      dataFlow,
      prepared,
      engineStatus: runResult.instance.status,
      runStatus,
      stepResults,
    };
  } finally {
    await collected.cleanup();
  }
}

export function selectWorkflow(workflows: readonly CandidateWorkflow[], options: WorkflowPipelineOptions): { workflow: CandidateWorkflow | undefined; rationale: string } {
  if (options.workflowId !== undefined) {
    const found = workflows.find((w) => w.id === options.workflowId);
    return found ? { workflow: found, rationale: `explicit --workflow-id "${options.workflowId}"` } : { workflow: undefined, rationale: `no discovered workflow has id "${options.workflowId}" (found: ${workflows.map((w) => w.id).join(', ')})` };
  }
  if (options.workflowIndex !== undefined) {
    const found = workflows[options.workflowIndex];
    return found ? { workflow: found, rationale: `explicit --workflow-index ${options.workflowIndex}` } : { workflow: undefined, rationale: `no discovered workflow at index ${options.workflowIndex} (${workflows.length} discovered)` };
  }
  const ranked = [...workflows].sort((a, b) => (b.steps.length !== a.steps.length ? b.steps.length - a.steps.length : b.confidence - a.confidence));
  const best = ranked[0]!;
  return { workflow: best, rationale: `highest-confidence workflow with the most steps (${best.steps.length} steps, confidence ${best.confidence.toFixed(2)}) among ${workflows.length} discovered` };
}

export function describeStepOutput(output: { readonly status?: string } | undefined): string {
  if (!output || typeof output !== 'object') return '(no result — step not reached or unresolved)';
  const status = output.status;
  if (status === 'escalation_required') return 'escalation_required (human action needed — not completed)';
  if (status === 'recorded' || status === 'ok') return `completed — ${JSON.stringify(output)}`;
  return JSON.stringify(output);
}
