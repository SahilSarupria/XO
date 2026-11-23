import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NotFoundError } from '@xo/errors';
import { itemRunId, RunStore, type JournalEntry } from '@xo/workflow-runtime';
import { BatchStore, batchDir, type PreviewRecord } from '../approvals/batch-approval.js';
import { readMeta, runsDir, type RunnerDeps } from '../routes/generated-run-routes.js';
import type { WorkflowDefinitionRecord } from '../routes/pre-execution-routes.js';

import type { WorkspaceRecord } from '../workspace/workspace.js';

/**
 * UW-11b (ADR 0050 part 2): what a run teaches. Observations are derived from the run's own record (its journals, its preview and the
 * corrections people recorded), never from a model, in plain words built from codes. They hold no customer values: a person reads
 * them, and may propose some as knowledge for review.
 */
export type ObservationKind =
  'effect_reconciled' | 'approval_rejected' | 'task_not_done' | 'escalation' | 'left_out' | 'loose_match' | 'correction';

export interface Observation {
  readonly observationId: string;
  readonly kind: ObservationKind;
  /** The batch (root) run. */
  readonly runId: string;
  readonly item?: number;
  readonly row?: number;
  readonly step?: string;
  readonly at: string;
  readonly by?: string;
  /** The decision, escalation code or exclusion reason. */
  readonly code?: string;
  /** In plain words, built from codes. No values. */
  readonly summary: string;
  readonly correction?: { readonly field: string; readonly value: string | number | boolean; readonly reason: string };
}

export const OBSERVATION_ID = /^obs_[0-9a-f]{24}$/;
export const RUN_ID = /^run_[0-9a-f]{32}$/;

export const observationIdOf = (
  runId: string,
  kind: string,
  step: string,
  item: number | undefined,
  row: number | undefined,
  seq: number | string,
): string =>
  `obs_${createHash('sha256')
    .update([runId, kind, step, item ?? '', row ?? '', seq].join('\u0000'))
    .digest('hex')
    .slice(0, 24)}`;

/** A stored correction (`<runs>/learning/<runId>/corrections/<obs_id>.json`). */
export interface StoredCorrection {
  readonly observationId: string;
  readonly runId: string;
  readonly item?: number;
  readonly field: string;
  readonly value: string | number | boolean;
  readonly reason: string;
  readonly by: string;
  readonly at: string;
}

export const correctionsDir = (dir: string, runId: string): string => join(dir, 'learning', runId, 'corrections');

const words = (code: string): string => code.replace(/_/g, ' ');
const EXCLUDED: Readonly<Record<string, string>> = {
  no_document: 'no document found',
  several_documents: 'more than one document',
  name_on_several_rows: 'the same name on several rows',
  no_name: 'no name',
  blank: 'an empty row',
};

export const correctionSummary = (field: string, item: number | undefined): string =>
  `A person corrected "${field}"${item !== undefined ? ` for item ${item + 1}` : ''}.`;

/** The preview a batch run was started from, when it was (its input is where an item's fields are). */
export async function previewOfRun(dir: string, runId: string): Promise<PreviewRecord | undefined> {
  const meta = await readMeta(dir, runId);
  if (meta?.batch === undefined) return undefined;
  return new BatchStore(batchDir(dir)).getPreview(meta.batch.previewId);
}

/** The item count of a run: its fan-out, or undefined when it is not a once-per-item run. */
export async function fanoutOf(store: RunStore, runId: string): Promise<number | undefined> {
  const first = (await store.read(runId).catch(() => []))[0];
  const n = (first?.data as { fanout?: { count?: unknown } } | undefined)?.fanout?.count;
  return typeof n === 'number' ? n : undefined;
}

export async function observationsOf(
  deps: RunnerDeps,
  workspace: WorkspaceRecord,
  definition: WorkflowDefinitionRecord,
  runId: string,
): Promise<Observation[]> {
  if (!RUN_ID.test(runId)) throw new NotFoundError(`run "${runId}"`);
  const dir = runsDir(deps.dataConfig, workspace.workspaceId, definition.definitionId);
  const store = new RunStore(dir);
  const rootEntries = await store.read(runId).catch(() => [] as JournalEntry[]);
  if (rootEntries.length === 0) throw new NotFoundError(`run "${runId}"`);
  const count = await fanoutOf(store, runId);
  const runs: { readonly id: string; readonly item?: number }[] =
    count !== undefined ? Array.from({ length: count }, (_, i) => ({ id: itemRunId(runId, i), item: i })) : [{ id: runId }];
  const out: Observation[] = [];
  for (const r of runs) {
    const entries = r.id === runId ? rootEntries : await store.read(r.id).catch(() => [] as JournalEntry[]);
    entries.forEach((e, seq) => {
      const d = e.data as Record<string, unknown>;
      const step = typeof d['step'] === 'string' ? d['step'] : undefined;
      const at = e.ts;
      const base = { runId, ...(r.item !== undefined ? { item: r.item } : {}), at };
      if (e.type === 'effect_reconciled' && step !== undefined && typeof d['decision'] === 'string')
        out.push({
          ...base,
          observationId: observationIdOf(runId, 'effect_reconciled', step, r.item, undefined, seq),
          kind: 'effect_reconciled',
          step,
          code: d['decision'],
          ...(typeof d['by'] === 'string' ? { by: d['by'] } : {}),
          summary: `A person checked the destination and recorded the outcome of the call at step "${step}" as ${words(d['decision'])}.`,
        });
      else if (
        e.type === 'approval_decided' &&
        step !== undefined &&
        (d['payload'] as { action?: unknown } | undefined)?.action === 'reject'
      )
        out.push({
          ...base,
          observationId: observationIdOf(runId, 'approval_rejected', step, r.item, undefined, seq),
          kind: 'approval_rejected',
          step,
          ...(typeof d['reviewerId'] === 'string' ? { by: d['reviewerId'] } : {}),
          summary: `A person rejected step "${step}".`,
        });
      else if (e.type === 'escalation' && typeof d['code'] === 'string' && d['code'] !== 'PREVIEW_NOT_EXACT') {
        const notDone = step !== undefined && step.endsWith('_not_done');
        const label = notDone ? step!.slice(0, -'_not_done'.length) : step;
        out.push({
          ...base,
          observationId: observationIdOf(runId, notDone ? 'task_not_done' : 'escalation', step ?? '', r.item, undefined, seq),
          kind: notDone ? 'task_not_done' : 'escalation',
          ...(step !== undefined ? { step } : {}),
          code: d['code'],
          summary: notDone
            ? `A person marked the task at step "${label}" as not done.`
            : `The item stopped for a person${step !== undefined ? ` at step "${step}"` : ''} (${d['code']}).`,
        });
      }
    });
  }
  // What the preview left out and matched loosely: from the batch the run was started with.
  const preview = await previewOfRun(dir, runId);
  const src = preview?.itemsSource;
  if (src !== undefined) {
    const at = preview!.createdAt;
    for (const x of src.excludedRows)
      out.push({
        observationId: observationIdOf(runId, 'left_out', '', undefined, x.row, 0),
        kind: 'left_out',
        runId,
        row: x.row,
        at,
        code: x.reason,
        summary: `Row ${x.row} of ${src.label} was left out: ${EXCLUDED[x.reason] ?? words(x.reason)}.`,
      });
    for (const x of src.looseRows)
      out.push({
        observationId: observationIdOf(runId, 'loose_match', '', undefined, x.row, 0),
        kind: 'loose_match',
        runId,
        row: x.row,
        at,
        code: x.kind,
        summary: `Row ${x.row} of ${src.label} was matched to its document only loosely (${words(x.kind)}).`,
      });
  }
  const names = await readdir(correctionsDir(dir, runId)).catch(() => [] as string[]);
  for (const n of names.filter((x) => x.endsWith('.json')).sort()) {
    try {
      const c = JSON.parse(await readFile(join(correctionsDir(dir, runId), n), 'utf8')) as StoredCorrection;
      out.push({
        observationId: c.observationId,
        kind: 'correction',
        runId,
        ...(c.item !== undefined ? { item: c.item } : {}),
        at: c.at,
        by: c.by,
        summary: correctionSummary(c.field, c.item),
        correction: { field: c.field, value: c.value, reason: c.reason },
      });
    } catch {
      /* an unreadable correction is not an observation */
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.observationId < b.observationId ? -1 : 1));
}
