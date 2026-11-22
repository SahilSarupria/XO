/**
 * PX-6/PX-7 — everything the pre-execution pipeline knows about one compilation, assembled the same way for every route
 * (workflow definitions, readiness certificates, the start gate), so each consumer sees the same inventory, the same
 * candidate workflows and the same digests.
 */
import { NotFoundError } from '@xo/errors';
import type { CandidateWorkflow } from '@xo/workflow-composer';
import type { XoirGraph } from '@xo/xoir';
import {
  assessCompleteness,
  assessSourceQuality,
  buildCapabilityInventory,
  type CapabilityInventory,
  type ConnectorBinding,
  type CompilationArtifact,
  type CompletenessAssessment,
  type SourceQualityAssessment,
} from '@xo/pre-execution';
import type { WorkspaceRecord } from '../workspace/workspace.js';
import {
  workspaceApprovalsStore,
  workspaceCompilationsStore,
  workspaceRulingsStore,
  workspaceSourcesStore,
  workspaceWaiversStore,
  type WorkspaceDataConfig,
  installedAdapterIds,
} from '../workspace/workspace-context.js';
import { FsCompilationStore } from '../compilations/fs-compilation-store.js';
import { FsApprovalStore } from '../approvals/fs-approval-store.js';
import { deriveCapabilityApprovalStateFromJson } from '../approvals/approval-binding.js';
import { verifyApproval } from '../approvals/approval-enforcement.js';
import { FsWaiverStore } from '../waivers/waiver-store.js';
import { FsRulingStore } from '../waivers/ruling-store.js';
import { composeCompilationWorkflows } from '../workflows/workflow-catalog.js';
import { executableKnowledge } from '@xo/knowledge-base';
import { workspaceKnowledgeBase } from '../routes/knowledge-routes.js';
import { WorkspaceEvidenceSources } from '../knowledge/evidence-sources.js';
import { digestOf } from '@xo/pre-execution';
import { readConnectorBindings } from './connector-bindings.js';

export interface PreExecutionContext {
  readonly compilationId: string;
  readonly graph: XoirGraph;
  readonly workflows: readonly CandidateWorkflow[];
  readonly artifact: CompilationArtifact;
  readonly inventory: CapabilityInventory;
  readonly sourceQuality: SourceQualityAssessment;
  readonly completeness: CompletenessAssessment;
  /** The workspace's head knowledge state, when any change set has been approved. */
  readonly knowledge?: {
    readonly stateId: string;
    readonly digest: string;
    readonly unresolvedConflicts: readonly string[];
    readonly refused: readonly { readonly recordId: string; readonly reasons: readonly string[] }[];
  };
  /** Digests of the waivers and rulings these assessments applied. */
  readonly decisionDigests: readonly string[];
  /** The workspace's connector bindings (ADR 0030), by capability name. */
  readonly connectorBindings: ReadonlyMap<string, ConnectorBinding>;
  /** RX-1d (ADR 0048): the Domain Knowledge Packs installed in the workspace now (pinned by a certificate). */
  readonly packs: readonly { readonly packId: string; readonly namespace: string; readonly version: string; readonly digest: string }[];
}

export async function loadPreExecutionContext(
  workspace: WorkspaceRecord,
  dataConfig: WorkspaceDataConfig,
  compilationId: string,
  needs: readonly string[] = [],
): Promise<PreExecutionContext> {
  const store = new FsCompilationStore(workspaceCompilationsStore(workspace, dataConfig));
  const record = await store.get(compilationId);
  if (!record.ok) throw record.error;
  if (record.value.status !== 'succeeded')
    throw new NotFoundError(`compilation "${compilationId}" has no compiled graph (status: ${record.value.status})`);
  const graphJson = await store.getCompiledGraph(compilationId);
  if (!graphJson.ok) throw graphJson.error;
  const artifact = await store.getArtifact(compilationId);
  if (!artifact.ok) throw artifact.error;
  const composed = composeCompilationWorkflows(graphJson.value, record.value.completedAt ?? record.value.createdAt);
  if (!composed.ok) throw composed.error;
  const { graph, workflows } = composed.value;

  const approvalStore = new FsApprovalStore(workspaceApprovalsStore(workspace, dataConfig));
  const approved = new Map<string, boolean>();
  for (const node of graph.allNodes()) {
    if (node.kind !== 'capability') continue;
    const current = deriveCapabilityApprovalStateFromJson(graphJson.value, node.id, record.value.sourceDigestSha256);
    const verdict = await verifyApproval(
      approvalStore,
      { workspaceId: workspace.workspaceId, compilationId, capabilityId: node.id },
      current,
    );
    approved.set(node.id, verdict.ok && verdict.value.approved);
  }
  const bindings = await readConnectorBindings(workspace, dataConfig);
  const connectorBindings = new Map(bindings.bindings.map((b) => [b.capability, b] as const));
  const inventory = buildCapabilityInventory(graph, {
    externalBindings: connectorBindings,
    availableAdapters: installedAdapterIds(dataConfig),
    artifactDigest: artifact.value.digest,
    decisions: new Map([...approved].filter(([, a]) => a).map(([id]) => [id, 'accepted' as const])),
    authorize: (c) =>
      approved.get(c.capabilityId) === true
        ? { value: 'yes', reason: 'approved for its current contract; permission is rechecked when a workflow starts' }
        : { value: 'no', reason: 'not approved for its current contract' },
    needs,
  });

  const digests = new Set(artifact.value.sourceSet.entries.map((e) => e.digestSha256));
  const waivers = await new FsWaiverStore(workspaceWaiversStore(workspace, dataConfig)).forDigests(digests);
  const rulings = await new FsRulingStore(workspaceRulingsStore(workspace, dataConfig)).forSourceSet(artifact.value.sourceSet.sourceSetId);
  const sourceQuality = assessSourceQuality(artifact.value, waivers, 'readiness');
  const completeness = assessCompleteness(artifact.value, rulings, waivers);

  const kb = await workspaceKnowledgeBase(workspace, dataConfig);
  const head = await kb.head();
  let knowledge: PreExecutionContext['knowledge'];
  if (!(head.parentStateId === null && head.entries.length === 0)) {
    // UW-4a (UAC-12): the approved knowledge drawn from THIS workflow's sources goes through the executable-use gate; anything
    // it refuses (evidence that no longer resolves, a lost conflict) is held for review. Other workspace knowledge is not this
    // workflow's concern.
    const fromTheseSources = (await kb.records(head.stateId))
      .filter(({ record }) => record.evidence.some((e) => digests.has(e.sourceDigestSha256)))
      .map(({ record }) => record.id);
    const gate = await executableKnowledge(kb, head.stateId, new WorkspaceEvidenceSources(workspaceSourcesStore(workspace, dataConfig)), {
      recordIds: fromTheseSources,
    });
    knowledge = {
      stateId: head.stateId,
      digest: head.digest,
      unresolvedConflicts: head.conflicts.filter((c) => c.status === 'unresolved').map((c) => c.id),
      refused: gate.refused.map((v) => ({ recordId: v.recordId, reasons: v.reasons })),
    };
  }

  const packs = (await kb.packs())
    .bindings()
    .map((p) => ({ packId: p.packId, namespace: p.namespace, version: p.version, digest: String(p.digest) }));
  return {
    compilationId,
    packs,
    graph,
    workflows,
    artifact: artifact.value,
    inventory,
    sourceQuality,
    completeness,
    ...(knowledge !== undefined ? { knowledge } : {}),
    connectorBindings,
    decisionDigests: [
      ...sourceQuality.appliedWaivers.map((w) => digestOf(w)),
      ...rulings.filter((r) => completeness.appliedRulings.includes(r.rulingId)).map((r) => digestOf(r)),
    ],
  };
}
