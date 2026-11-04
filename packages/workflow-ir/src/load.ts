import type { CapabilityLayer } from '@xo/capability-layer';
import { validateAgainstBundle, validateWorkflowComponent, type BundleRefs, type WorkflowIssue } from './validate.js';
import type { WorkflowComponent } from './types.js';

export class WorkflowLoadError extends Error {
  constructor(readonly issues: readonly WorkflowIssue[]) {
    super(
      `workflow component refused: ${issues
        .filter((i) => i.severity === 'error')
        .map((i) => `${i.code} at ${i.path}: ${i.message}`)
        .join('; ')}`,
    );
    this.name = 'WorkflowLoadError';
  }
}

export interface LoadedWorkflows {
  readonly component: WorkflowComponent;
  readonly warnings: readonly WorkflowIssue[];
}

const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Parses and fully validates the bytes of `workflows/workflows.json`, including
 * cross-component references when `refs` is given. Throws {@link WorkflowLoadError}
 * on any error; a host never receives a partially valid component.
 */
export function loadWorkflowComponent(bytes: Uint8Array, refs?: BundleRefs): LoadedWorkflows {
  if (bytes.byteLength > MAX_BYTES)
    throw new WorkflowLoadError([
      { severity: 'error', code: 'TOO_LARGE', path: '$', message: `workflow component exceeds ${MAX_BYTES} bytes` },
    ]);
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (e) {
    throw new WorkflowLoadError([{ severity: 'error', code: 'NOT_JSON', path: '$', message: (e as Error).message }]);
  }
  const v = validateWorkflowComponent(doc);
  const issues = [...v.issues];
  if (v.valid && refs !== undefined) issues.push(...validateAgainstBundle(doc as WorkflowComponent, refs).issues);
  if (issues.some((i) => i.severity === 'error')) throw new WorkflowLoadError(issues);
  return { component: doc as WorkflowComponent, warnings: issues };
}

/**
 * Loads the workflows of a verified capability layer: bytes come from the layer (so bundle integrity and
 * signature checks already ran), and cross-component references are checked against the same package.
 * Returns undefined when the package has no workflows component or the host's manifest entry skips it.
 */
export function workflowsFromLayer(layer: CapabilityLayer): LoadedWorkflows | undefined {
  const bytes = layer.componentBytes('workflows');
  if (bytes === undefined) return undefined;
  return loadWorkflowComponent(bytes, { decisionTrees: { trees: layer.decisionTrees() } });
}
