/**
 * ADR 0035 — triggers for certified workflows run on the Workflow IR runtime.
 *
 * A webhook call or a schedule slot that names a readiness certificate starts the certified generated definition through
 * `startGeneratedRun`, the same function the generated-workflow and Workflow-entity routes use: the certificate is verified
 * again now (every digest it binds is recomputed), the workspace pause applies, who started the run is on record before its
 * first journal entry, and every connector call is re-authorized against the starter when it happens (ADR 0031). The workflow's
 * own controls (paused, practice mode, daily limit) apply first, as for every trigger.
 */
import { ErrorCode, XoError } from '@xo/errors';
import type { AuthenticatedPrincipal } from '@xo/permissions';
import { startGeneratedRun, type RunnerDeps } from '../routes/generated-run-routes.js';
import { workspaceDefinitionsStore } from '../routes/pre-execution-routes.js';
import { workspaceCertificatesStore } from '../routes/readiness-routes.js';
import { workspaceStateStore } from '../workspace/workspace-context.js';
import type { WorkspaceRecord } from '../workspace/workspace.js';
import { makeRunnerContext } from '../workflows/workflow-views.js';
import { FsControlsStore } from './fs-controls-store.js';
import type { StartTrigger } from './model.js';
import { enforceStart, StartRefusedError } from './service.js';

export interface CertifiedTriggerStart {
  readonly workspace: WorkspaceRecord;
  /** Who the run starts as: the webhook caller, or the person who set the schedule. */
  readonly actor: AuthenticatedPrincipal;
  readonly compilationId: string;
  readonly workflowId: string;
  readonly certificateId: string;
  readonly input: Record<string, unknown>;
  /** Same key, same run (a retried webhook; one schedule slot fired by two instances). */
  readonly idempotencyKey?: string;
  readonly correlationId: string;
  readonly trigger: Extract<StartTrigger, 'schedule' | 'webhook'>;
  readonly now: Date;
}

/** The certificate must be for exactly this compilation's workflow (checked before anything else, and again at every start). */
export async function certificateForWorkflow(
  workspace: WorkspaceRecord,
  dataConfig: RunnerDeps['dataConfig'],
  certificateId: string,
  target: { readonly compilationId: string; readonly workflowId: string },
): Promise<{ readonly definitionId: string }> {
  const cert = await workspaceCertificatesStore(workspace, dataConfig).get(certificateId);
  if (
    cert.scope.compilationId !== target.compilationId ||
    cert.scope.candidateWorkflowId !== target.workflowId ||
    cert.scope.definitionId === undefined
  )
    throw new XoError(
      ErrorCode.INVALID_ARGUMENT,
      `certificate ${certificateId} is not for workflow ${target.workflowId} of compilation ${target.compilationId}`,
    );
  return { definitionId: cert.scope.definitionId };
}

export async function startCertifiedTrigger(
  deps: RunnerDeps,
  s: CertifiedTriggerStart,
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const target = { compilationId: s.compilationId, workflowId: s.workflowId };
  const { definitionId } = await certificateForWorkflow(s.workspace, deps.dataConfig, s.certificateId, target);
  const ctx = makeRunnerContext(s.workspace, s.actor, deps.dataConfig, deps.permissionManager);
  const { shadow } = await enforceStart(
    new FsControlsStore(workspaceStateStore(s.workspace, deps.dataConfig), s.workspace.workspaceId),
    ctx,
    target,
    s.trigger,
    s.now,
  );
  // Practice mode is a composed-runner feature (shadow runs with reviewer judgements); a certified workflow is not practised by
  // a trigger. Say so instead of running it for real.
  if (shadow)
    throw new StartRefusedError(
      'practice_mode',
      'this workflow is in practice mode; a certified workflow is started by a trigger only in live mode',
    );
  const definition = await workspaceDefinitionsStore(s.workspace, deps.dataConfig).get(definitionId);
  return startGeneratedRun(deps, {
    workspace: s.workspace,
    actor: s.actor,
    definition,
    input: s.input,
    certificateId: s.certificateId,
    ...(s.idempotencyKey !== undefined ? { idempotencyKey: s.idempotencyKey } : {}),
    correlationId: s.correlationId,
  });
}
