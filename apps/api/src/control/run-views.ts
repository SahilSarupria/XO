import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { effectsOf, itemRunId, RunStore, type EffectView, type JournalEntry } from '@xo/workflow-runtime';
import type { WorkflowComponent } from '@xo/workflow-ir';
import { BatchStore, batchDir } from '../approvals/batch-approval.js';
import { fanoutOf, observationsOf, previewOfRun, RUN_ID } from '../learning/observations.js';
import { readManifest } from '../runs/run-manifest.js';
import { readMeta, runnerFor, runsDir, type RunnerDeps } from '../routes/generated-run-routes.js';
import type { WorkflowDefinitionRecord } from '../routes/pre-execution-routes.js';
import type { WorkspaceRecord } from '../workspace/workspace.js';

/** UW-12b (ADR 0052 decisions 2 and 4): the evidence of one item, and a run's typed outputs. Read-only views over what is already stored. */

const text = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');

export async function runEvidence(
  deps: RunnerDeps,
  workspace: WorkspaceRecord,
  definition: WorkflowDefinitionRecord,
  runId: string,
  itemParam: unknown,
): Promise<Record<string, unknown>> {
  if (!RUN_ID.test(runId)) throw new NotFoundError(`run "${runId}"`);
  const dir = runsDir(deps.dataConfig, workspace.workspaceId, definition.definitionId);
  const store = new RunStore(dir);
  const count = await fanoutOf(store, runId);
  let item: number | undefined;
  if (count !== undefined) {
    const n = typeof itemParam === 'string' && /^\d{1,7}$/.test(itemParam) ? Number(itemParam) : NaN;
    if (!Number.isInteger(n) || n < 0 || n >= count)
      throw new XoError(ErrorCode.INVALID_ARGUMENT, `item must be a whole number from 0 to ${count - 1}`);
    item = n;
  } else if (itemParam !== undefined && itemParam !== null && itemParam !== '')
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'this run has no items');
  const id = item !== undefined ? itemRunId(runId, item) : runId;
  const entries: JournalEntry[] = await store.read(id).catch(() => []);
  if (entries.length === 0) throw new NotFoundError(`run "${runId}"`);
  const runner = await runnerFor(deps, workspace, definition);
  const status = await runner.status(id);
  const meta = await readMeta(dir, runId);
  const preview = await previewOfRun(dir, runId);
  const bs = new BatchStore(batchDir(dir));
  const approval = meta?.batch !== undefined ? await bs.getApprovalOfPreview(meta.batch.previewId) : undefined;
  const over = (definition.lowered.component as WorkflowComponent | undefined)?.workflows[0]?.forEach?.over;
  const itemInput =
    item !== undefined && over !== undefined ? ((preview?.input[over] as Record<string, unknown>[] | undefined)?.[item] ?? {}) : {};

  const src = preview?.itemsSource;
  const rowInfo = item !== undefined ? src?.itemRows?.find((r) => r.index === item) : undefined;
  const docName = text(itemInput['document_name']);
  const source =
    src !== undefined && rowInfo !== undefined
      ? {
          connectionName: src.connectionName,
          label: src.label,
          row: rowInfo.row,
          match: rowInfo.loose ?? 'exact',
          ...(docName !== '' ? { document: { name: docName, sha256: text(itemInput['document_sha256'], 80) } } : {}),
        }
      : undefined;

  const standing = approval?.payload.standing;
  const steps = entries
    .filter((e) => e.type === 'approval_decided' || e.type === 'approval_presigned')
    .map((e) => {
      const d = e.data as { step: string; reviewerId?: string; action?: string };
      return {
        step: d.step,
        type: 'approval',
        decidedBy: e.type === 'approval_decided' ? 'person' : standing !== undefined ? 'standing_approval' : 'batch_approval',
        ...(d.reviewerId !== undefined ? { by: d.reviewerId } : {}),
        at: e.ts,
        outcome: String(d.action ?? ''),
      };
    });
  const previewItem = item !== undefined ? preview?.items.find((i) => i.index === item) : preview?.items[0];
  const effects = new Map<string, EffectView>(effectsOf(entries).map((e) => [e.step, e]));
  const actions = (previewItem?.actions ?? [])
    .filter((a) => effects.has(a.step))
    .map((a) => ({
      step: a.step,
      connector: a.connector,
      operation: a.operation,
      sideEffect: a.sideEffect,
      args: a.args,
      effect: effects.get(a.step)!,
    }));
  const manifest = await readManifest(dir, runId);
  const observations = (await observationsOf(deps, workspace, definition, runId)).filter(
    (o) => item === undefined || o.item === item,
  ).length;
  return {
    runId,
    ...(item !== undefined ? { item } : {}),
    state: status.state,
    ...(source !== undefined ? { source } : {}),
    ...(approval !== undefined
      ? {
          approval: {
            kind: standing !== undefined ? 'standing' : 'batch',
            approvalId: approval.payload.approvalId,
            reviewerId: approval.payload.reviewerId,
            at: approval.payload.at,
            presignSteps: [...(approval.payload.presignSteps ?? [])],
            ...(standing !== undefined ? { standingApprovalId: standing.standingApprovalId } : {}),
            selfApproved: preview !== undefined && preview.createdBy === approval.payload.reviewerId,
          },
        }
      : {}),
    steps,
    actions,
    manifest: {
      digestOk: manifest !== undefined && manifest.digest !== 'mismatch',
      certificateId: manifest?.manifest.certificate.certificateId ?? meta?.certificateId ?? '',
      ...(manifest?.manifest.knowledge !== undefined ? { knowledgeStateId: manifest.manifest.knowledge.stateId } : {}),
    },
    observations,
  };
}

export interface OutputArtefact {
  readonly kind: 'delivery' | 'document' | 'result';
  readonly item?: number;
  readonly name: string;
  readonly type: string;
  readonly value?: unknown;
  readonly ref?: { readonly sha256: string; readonly name: string };
  readonly state?: string;
  readonly access: 'workspace_members';
  readonly kept: 'until_workspace_deleted';
}

const ACCESS = { access: 'workspace_members', kept: 'until_workspace_deleted' } as const;

/** Deliveries (every external call of the run), documents (attachments that name a workspace source) and results of the workflow. */
export async function runOutputs(
  deps: RunnerDeps,
  workspace: WorkspaceRecord,
  definition: WorkflowDefinitionRecord,
  runId: string,
): Promise<{ runId: string; artefacts: OutputArtefact[] }> {
  if (!RUN_ID.test(runId)) throw new NotFoundError(`run "${runId}"`);
  const dir = runsDir(deps.dataConfig, workspace.workspaceId, definition.definitionId);
  const store = new RunStore(dir);
  const count = await fanoutOf(store, runId);
  const preview = await previewOfRun(dir, runId);
  const ids =
    count !== undefined
      ? Array.from({ length: count }, (_, i) => ({ id: itemRunId(runId, i), item: i }))
      : [{ id: runId, item: undefined }];
  const artefacts: OutputArtefact[] = [];
  const runner = await runnerFor(deps, workspace, definition);
  let known = false;
  for (const r of ids) {
    const entries: JournalEntry[] = await store.read(r.id).catch(() => []);
    if (entries.length > 0) known = true;
    const previewItem = preview?.items.find((i) => i.index === (r.item ?? 0));
    for (const e of effectsOf(entries)) {
      artefacts.push({
        kind: 'delivery',
        ...(r.item !== undefined ? { item: r.item } : {}),
        name: `${e.connector} ${e.operation}`,
        type: e.operation,
        state: e.state,
        ...ACCESS,
      });
      const action = previewItem?.actions.find((a) => a.step === e.step);
      for (const [key, v] of Object.entries(action?.args ?? {}))
        if (/attachment/i.test(key) && typeof v === 'string' && /^(sha256[-:])?[0-9a-f]{16,64}$/i.test(v))
          artefacts.push({
            kind: 'document',
            ...(r.item !== undefined ? { item: r.item } : {}),
            name: key,
            type: 'attachment',
            ref: { sha256: v, name: key },
            ...ACCESS,
          });
    }
    if (r.item === undefined && entries.length > 0) {
      const outputs = (await runner.status(r.id)).outputs ?? {};
      for (const [name, value] of Object.entries(outputs))
        artefacts.push({
          kind: 'result',
          name,
          type: value === null ? 'null' : Array.isArray(value) ? 'list' : typeof value,
          value: typeof value === 'string' ? value.slice(0, 500) : value,
          ...ACCESS,
        });
    }
  }
  if (!known) throw new NotFoundError(`run "${runId}"`);
  return { runId, artefacts };
}
