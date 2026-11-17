import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { RunStore } from '@xo/workflow-runtime';
import { NotFoundError } from '@xo/errors';
import type { WorkspaceRecord } from '../workspace/workspace.js';
import { workspaceDefinitionsStore, type WorkflowDefinitionRecord } from '../routes/pre-execution-routes.js';
import { readMeta, runnerFor, runsDir, view, type RunnerDeps } from '../routes/generated-run-routes.js';
import type { RunFacts, WorkflowEntity } from './entity.js';

/**
 * UW-2 (ADR 0032) — how a Workflow entity reaches its runs without owning them. The entity stores no run state; every run
 * records, before its first journal entry, which workflow and version it belongs to (`RunMeta.workflow`), and this port reads
 * the engine's own journal for the rest. ADR 0011 makes `@xo/workflow-runtime` the one engine; the port is the seam UW-7
 * extends (cancellation) without the entity changing.
 */

export interface PendingApprovalView {
  readonly approvalId: string;
  readonly step: string;
  readonly summary: string;
}

export interface WorkflowRunView extends RunFacts {
  readonly definitionId: string;
  readonly startedBy?: string;
  readonly certificateId?: string;
  readonly approvals: readonly PendingApprovalView[];
  readonly outputs?: unknown;
  readonly escalation?: unknown;
}

export interface WorkflowRunPort {
  /** Every run of the workflow, all versions, newest first. */
  runsOf(entity: WorkflowEntity): Promise<readonly WorkflowRunView[]>;
  /** One run in full (with its signed, re-verified decisions); 404 when it is not this workflow's. */
  run(entity: WorkflowEntity, runId: string): Promise<Record<string, unknown>>;
}

const RUN_ID = /^run_[0-9a-f]{32}$/;

export function generatedRunPort(deps: RunnerDeps, workspace: WorkspaceRecord): WorkflowRunPort {
  const definitions = workspaceDefinitionsStore(workspace, deps.dataConfig);
  const definitionOf = (entity: WorkflowEntity, id: string): Promise<WorkflowDefinitionRecord> => {
    if (!entity.versions.some((v) => v.definition.definitionId === id)) throw new NotFoundError(`definition "${id}"`);
    return definitions.get(id);
  };

  return {
    async runsOf(entity) {
      const out: WorkflowRunView[] = [];
      for (const definitionId of new Set(entity.versions.map((v) => v.definition.definitionId))) {
        const dir = runsDir(deps.dataConfig, workspace.workspaceId, definitionId);
        const mine: { runId: string; meta: NonNullable<Awaited<ReturnType<typeof readMeta>>> }[] = [];
        for (const f of await readdir(join(dir, 'meta')).catch(() => [] as string[])) {
          const runId = f.replace(/\.json$/, '');
          if (!RUN_ID.test(runId)) continue;
          const meta = await readMeta(dir, runId);
          if (meta?.workflow?.workflowId === entity.workflowId) mine.push({ runId, meta });
        }
        if (mine.length === 0) continue;
        const runner = await runnerFor(deps, workspace, await definitionOf(entity, definitionId));
        const pending = await runner.listApprovals();
        for (const { runId, meta } of mine) {
          // A run whose record exists but whose journal has no first entry yet (a start in flight, or one that crashed before
          // it) is reported as created: it is still this workflow's, and a retry with the same key resumes it.
          const status = await runner.status(runId).catch(() => undefined);
          const approvals = pending
            .filter((a) => a.runId === runId)
            .map((a) => ({ approvalId: a.approvalId, step: a.step, summary: a.summary }));
          out.push({
            runId,
            version: meta.workflow!.version,
            definitionId,
            state: status?.state ?? 'created',
            pendingApprovals: approvals.length,
            approvals,
            startedAt: meta.startedAt,
            startedBy: meta.initiator.id,
            certificateId: meta.certificateId,
            ...(status?.outputs !== undefined ? { outputs: status.outputs } : {}),
            ...(status?.escalation !== undefined ? { escalation: status.escalation } : {}),
          });
        }
      }
      return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : a.runId < b.runId ? 1 : -1));
    },

    async run(entity, runId) {
      if (!RUN_ID.test(runId)) throw new NotFoundError(`run "${runId}"`);
      for (const definitionId of new Set(entity.versions.map((v) => v.definition.definitionId))) {
        const dir = runsDir(deps.dataConfig, workspace.workspaceId, definitionId);
        const meta = await readMeta(dir, runId);
        if (meta?.workflow?.workflowId !== entity.workflowId) continue;
        if ((await new RunStore(dir).read(runId).catch(() => [])).length === 0) break;
        const runner = await runnerFor(deps, workspace, await definitionOf(entity, definitionId));
        return { ...(await view(runner, runId, dir, deps.dataConfig.dataRootDir)), definitionId, version: meta.workflow.version };
      }
      throw new NotFoundError(`run "${runId}" of workflow "${entity.workflowId}"`);
    },
  };
}
