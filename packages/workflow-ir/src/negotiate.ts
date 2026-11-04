import {
  WORKFLOW_FEATURES,
  WORKFLOW_SEMANTICS_VERSION,
  type ConnectorKind,
  type WorkflowComponent,
  type WorkflowFeature,
} from './types.js';

/**
 * Host/XO compatibility negotiation for workflows (SPECIFICATION.md §2.1 steps 3-5,
 * applied to the workflow component). A host declares what it implements; each
 * workflow is either runnable as written or refused with reasons. There is no
 * "partially runnable": a workflow that needs something the host lacks is never
 * executed with that part dropped.
 */

export interface WorkflowHostSupport {
  /** `major.minor` semantics versions this runtime implements, e.g. ['1.0']. */
  readonly semanticsVersions: readonly string[];
  readonly features: readonly WorkflowFeature[];
  /** Connector kinds the runtime can instantiate (independent of operator grants). */
  readonly connectorKinds: readonly ConnectorKind[];
  /** Abstract model capabilities available for extract steps. Empty = deterministic-only host. */
  readonly modelCapabilities: readonly ('structured_output' | 'long_context')[];
}

export interface WorkflowNegotiation {
  readonly runnable: readonly string[];
  readonly refused: readonly { readonly workflow: string; readonly reasons: readonly string[] }[];
  /** Workflows that run without any model call at all, given this host. */
  readonly modelFree: readonly string[];
}

/** The reference deterministic runner's support (no model, every feature except model_extract). */
export const DETERMINISTIC_HOST: WorkflowHostSupport = {
  semanticsVersions: [WORKFLOW_SEMANTICS_VERSION],
  features: WORKFLOW_FEATURES.filter((f) => f !== 'model_extract'),
  connectorKinds: ['http', 'webhook_out', 'file', 'smtp', 'slack_webhook', 'database', 'mcp'],
  modelCapabilities: [],
};

export function negotiateWorkflows(comp: WorkflowComponent, host: WorkflowHostSupport): WorkflowNegotiation {
  const runnable: string[] = [];
  const modelFree: string[] = [];
  const refused: { workflow: string; reasons: string[] }[] = [];
  const semanticsOk = host.semanticsVersions.includes(comp.semanticsVersion);
  const kindById = new Map(comp.connectors.map((c) => [c.id, c.kind]));
  for (const wf of comp.workflows) {
    const reasons: string[] = [];
    if (!semanticsOk)
      reasons.push(`runtime does not implement semantics ${comp.semanticsVersion} (has ${host.semanticsVersions.join(', ') || 'none'})`);
    for (const f of wf.requiresFeatures ?? []) if (!host.features.includes(f)) reasons.push(`requires feature "${f}"`);
    const used = new Set<string>();
    for (const s of wf.steps) {
      if (s.type === 'act' || s.type === 'compensate') used.add(s.connector);
      if (s.type === 'extract')
        for (const r of s.requires ?? [])
          if (!host.modelCapabilities.includes(r)) reasons.push(`step "${s.id}" needs model capability "${r}"`);
    }
    for (const id of used) {
      const kind = kindById.get(id);
      if (kind !== undefined && !host.connectorKinds.includes(kind))
        reasons.push(`connector "${id}" needs kind "${kind}" which this runtime cannot provide`);
    }
    if (reasons.length > 0) refused.push({ workflow: wf.id, reasons });
    else {
      runnable.push(wf.id);
      if (!wf.steps.some((s) => s.type === 'extract')) modelFree.push(wf.id);
    }
  }
  return { runnable, refused, modelFree };
}
