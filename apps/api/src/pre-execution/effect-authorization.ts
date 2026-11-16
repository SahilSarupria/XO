/**
 * ADR 0031 — authorization at the side-effect boundary of a generated workflow.
 *
 * A certificate proves a workflow was ready when it started. It does not keep every later action authorized: a member can
 * lose their role, the operator can narrow the policy, pause the workspace, change a connector binding or withdraw an
 * approval while a run waits for a person or a timer. So every connector call is authorized again, immediately before it
 * is made, from the current records (nothing cached):
 *
 *   1. the person who started the run is still a member with the `author` permission under the operator policy;
 *   2. the workspace is not paused;
 *   3. the workspace still binds this connector operation, to the same host adapter and with the same side effect;
 *   4. the step's capability is still approved for its current contract.
 *
 * An undo (`compensate`) is checked only for 3: undoing an effect must not be blocked by the same revocation that stopped
 * the run, but it still goes only where the operator's binding says. A refusal is `DENIED` with no effect sent: the run
 * fails closed (escalates or compensates as the definition says) and the denial is audited.
 */
import type { PermissionManager } from '@xo/permissions';
import type { WorkflowComponent } from '@xo/workflow-ir';
import { FsApprovalStore } from '../approvals/fs-approval-store.js';
import { deriveCapabilityApprovalStateFromJson } from '../approvals/approval-binding.js';
import { verifyApproval } from '../approvals/approval-enforcement.js';
import { FsCompilationStore } from '../compilations/fs-compilation-store.js';
import { FsControlsStore } from '../workflow-controls/fs-controls-store.js';
import { isWorkspaceAllowed } from '../workspace/authorizer.js';
import { roleOf, type WorkspaceStore } from '../workspace/workspace.js';
import {
  workspaceApprovalsStore,
  workspaceCompilationsStore,
  workspaceStateStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import type { WorkflowDefinitionRecord } from '../routes/pre-execution-routes.js';
import { readConnectorBindings } from './connector-bindings.js';

export interface EffectCall {
  readonly stepId: string;
  readonly connector: string;
  readonly operation: string;
  /** The host adapter this runner was built with for the connector. */
  readonly adapterId: string;
  readonly initiator: { readonly kind: 'human' | 'service'; readonly id: string };
}

export interface EffectAuthorizer {
  /** `undefined` when the call may go ahead; otherwise the reason it may not. */
  check(call: EffectCall): Promise<string | undefined>;
}

export function effectAuthorizer(deps: {
  readonly workspaceStore: WorkspaceStore;
  readonly dataConfig: WorkspaceDataConfig;
  readonly permissionManager: PermissionManager;
  readonly workspaceId: string;
  readonly definition: WorkflowDefinitionRecord;
}): EffectAuthorizer {
  const component = deps.definition.lowered.component as WorkflowComponent | undefined;
  const steps = new Map((component?.workflows[0]?.steps ?? []).map((s) => [s.id, s] as const));
  const capabilityOf = new Map(deps.definition.lowered.rationale.map((r) => [r.stepId, r] as const));
  let graphJson: Promise<{ json: unknown; sourceDigest: string } | undefined> | undefined;

  return {
    async check(call) {
      const ws = await deps.workspaceStore.get(deps.workspaceId);
      if (!ws.ok) return 'the workspace no longer exists';
      const workspace = ws.value;
      const step = steps.get(call.stepId);
      if (step === undefined || (step.type !== 'act' && step.type !== 'compensate'))
        return `step "${call.stepId}" is not a connector step of the certified definition`;
      const undo = step.type === 'compensate';

      const bindings = (await readConnectorBindings(workspace, deps.dataConfig)).bindings;
      const b = bindings.find(
        (x) => x.connector === call.connector && (x.operation === call.operation || x.compensation?.operation === call.operation),
      );
      if (b === undefined) return `the workspace no longer binds ${call.connector}.${call.operation}`;
      if (b.adapter !== call.adapterId) return `${call.connector} is now bound to another adapter`;
      const sideEffect = b.operation === call.operation ? b.sideEffect : b.compensation?.sideEffect;
      if (sideEffect !== step.sideEffect)
        return `${call.connector}.${call.operation} is now declared ${sideEffect ?? 'differently'}, not ${step.sideEffect}`;
      if (undo) return undefined;

      const role = roleOf(workspace, call.initiator.id);
      if (role === undefined) return `${call.initiator.id}, who started this run, is no longer a member of the workspace`;
      const allowed = await isWorkspaceAllowed(deps.permissionManager, {
        principal: call.initiator,
        role,
        workspaceId: workspace.workspaceId,
        permission: 'author',
      });
      if (!allowed) return `${call.initiator.id}, who started this run, may no longer run workflows here`;

      const controls = await new FsControlsStore(workspaceStateStore(workspace, deps.dataConfig), workspace.workspaceId).getControls();
      if (controls.paused) return 'the workspace is paused';

      const cap = capabilityOf.get(call.stepId);
      if (cap === undefined) return `step "${call.stepId}" has no recorded capability`;
      if (b.capability !== cap.capabilityName) return `${call.connector}.${call.operation} is now bound to another capability`;
      graphJson ??= (async () => {
        const store = new FsCompilationStore(workspaceCompilationsStore(workspace, deps.dataConfig));
        const record = await store.get(deps.definition.compilationId);
        const json = await store.getCompiledGraph(deps.definition.compilationId);
        return record.ok && json.ok ? { json: json.value, sourceDigest: record.value.sourceDigestSha256 } : undefined;
      })();
      const g = await graphJson;
      if (g === undefined) return 'the compilation this workflow came from is no longer readable';
      const verdict = await verifyApproval(
        new FsApprovalStore(workspaceApprovalsStore(workspace, deps.dataConfig)),
        { workspaceId: workspace.workspaceId, compilationId: deps.definition.compilationId, capabilityId: cap.capabilityId },
        deriveCapabilityApprovalStateFromJson(g.json, cap.capabilityId, g.sourceDigest),
      );
      if (!verdict.ok) return `the approval of "${cap.capabilityName}" could not be checked: ${verdict.error.message}`;
      if (!verdict.value.approved) return `"${cap.capabilityName}" is no longer approved: ${verdict.value.message}`;
      return undefined;
    },
  };
}
