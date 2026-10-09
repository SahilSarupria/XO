import type { ObservedCapability, ObservedCapabilityExecution, ObservedNode, ObservedWorkflow, ObservedWorkflowExecution, PipelineObservation, StageName, StageStatus } from '../src/observation.js';
import { fingerprintOf } from '../src/json.js';
import type { BenchmarkCaseDefinition, CaseExpectations, ExecutionCase } from '../src/definition.js';
import type { MetricResult } from '../src/metrics.js';

/**
 * Builders for SYNTHETIC `PipelineObservation`s — used only to test the
 * PURE evaluator/comparator in isolation (what the evaluator concludes
 * from a given observation). They never stand in for the pipeline: every
 * test about what the real pipeline produces goes through `observeCase`
 * (see `pipeline.test.ts`, `suites.test.ts`).
 */

export const DOC = 'docs/policy.pdf';

export function node(id: string, kind: string, properties: Record<string, unknown>, opts: { pages?: number[]; refs?: number; doc?: string } = {}): ObservedNode {
  const refs = opts.refs ?? 1;
  return { id, kind, properties, confidence: 0.8, sourceRefs: Array.from({ length: refs }, () => ({ documentPath: opts.doc ?? DOC, ...(opts.pages !== undefined ? { pages: opts.pages } : {}) })) };
}

export function cap(id: string, name: string, over: Partial<ObservedCapability> = {}): ObservedCapability {
  return { capabilityId: id, name, resolution: 'resolved', executionClass: 'deterministic_rule', inputs: [], outputs: [], confidence: 0.8, sourceRefs: [{ documentPath: DOC, pages: [1] }], ...over };
}

export function param(name: string): { name: string; runtimeKey: string; semanticType: string } {
  return { name, runtimeKey: name.toLowerCase().replace(/[^a-z0-9]+/g, '_'), semanticType: 'number' };
}

export function wf(id: string, steps: [string, string, ObservedWorkflow['steps'][number]['executionClass']?][], over: Partial<ObservedWorkflow> = {}): ObservedWorkflow {
  return {
    workflowId: id,
    steps: steps.map(([capabilityId, name, cls], i) => ({ order: i, capabilityId, name, bound: cls !== 'not_executable', executionClass: cls ?? 'deterministic_rule' })),
    executability: 'executable_candidate',
    blockerKinds: [],
    bindings: [],
    ...over,
  };
}

export function okStages(over: Partial<Record<StageName, StageStatus>> = {}): Record<StageName, StageStatus> {
  return {
    compile: { stage: 'compile', status: 'ok' },
    capabilities: { stage: 'capabilities', status: 'ok' },
    workflows: { stage: 'workflows', status: 'ok' },
    execution: { stage: 'execution', status: 'ok' },
    ...over,
  };
}

export function observation(parts: { nodes?: ObservedNode[]; capabilities?: ObservedCapability[]; workflows?: ObservedWorkflow[]; executions?: (ObservedCapabilityExecution | ObservedWorkflowExecution)[]; stages?: Record<StageName, StageStatus>; harnessError?: string }): PipelineObservation {
  const nodes = parts.nodes ?? [];
  const capabilities = parts.capabilities ?? [];
  const workflows = parts.workflows ?? [];
  const executions = parts.executions ?? [];
  return {
    entry: 'sources',
    stages: parts.stages ?? okStages(),
    ...(parts.harnessError !== undefined ? { harnessError: parts.harnessError } : {}),
    nodes,
    edgeCount: 0,
    capabilities,
    workflows,
    executions,
    fingerprints: { compile: fingerprintOf(nodes), capabilities: fingerprintOf(capabilities), workflows: fingerprintOf(workflows), execution: fingerprintOf(executions) },
  };
}

export function caseDef(expect: CaseExpectations, execution?: ExecutionCase[], caseId = 'c1'): BenchmarkCaseDefinition {
  return { caseId, sources: [{ kind: 'document', path: 'x.txt' }], expect, ...(execution !== undefined ? { execution } : {}) };
}

export function capRun(requestId: string, over: Partial<ObservedCapabilityExecution> = {}): ObservedCapabilityExecution {
  return { requestId, kind: 'capability', outcome: 'succeeded', ...over };
}

export function metricOf(evaluation: { metrics: readonly { id: string }[] }, id: string) {
  return (evaluation.metrics as readonly MetricResult[]).find((m) => m.id === id);
}
