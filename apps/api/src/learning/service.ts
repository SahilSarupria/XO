import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { actorFromPrincipal } from '@xo/audit';
import { idOf, type ChangeSet, type ClaimRecord, type EvidenceRef } from '@xo/knowledge-base';
import { RunStore } from '@xo/workflow-runtime';
import { readManifest } from '../runs/run-manifest.js';
import { workspaceKnowledgeBase } from '../routes/knowledge-routes.js';
import { runsDir, type RunnerDeps } from '../routes/generated-run-routes.js';
import type { WorkflowDefinitionRecord } from '../routes/pre-execution-routes.js';
import type { WorkspaceRecord } from '../workspace/workspace.js';
import type { AuthenticatedPrincipal } from '@xo/permissions';
import {
  OBSERVATION_ID,
  RUN_ID,
  correctionSummary,
  correctionsDir,
  fanoutOf,
  observationIdOf,
  observationsOf,
  previewOfRun,
  type Observation,
  type StoredCorrection,
} from './observations.js';

const FIELD = /^[a-z][a-z0-9_]{0,63}$/;
const bad = (m: string): XoError => new XoError(ErrorCode.INVALID_ARGUMENT, m);

export interface RecordCorrection {
  readonly workspace: WorkspaceRecord;
  readonly actor: AuthenticatedPrincipal;
  readonly definition: WorkflowDefinitionRecord;
  readonly runId: string;
  readonly item?: unknown;
  readonly field: unknown;
  readonly value: unknown;
  readonly reason: unknown;
  readonly correlationId: string;
}

/** A person says what a field of an item should have been. Nothing in the run, the source or the knowledge base changes. */
export async function recordCorrection(deps: RunnerDeps, r: RecordCorrection): Promise<{ observation: Observation }> {
  const { workspace, definition, runId } = r;
  if (!RUN_ID.test(runId)) throw new NotFoundError(`run "${runId}"`);
  const dir = runsDir(deps.dataConfig, workspace.workspaceId, definition.definitionId);
  const store = new RunStore(dir);
  const first = (await store.read(runId).catch(() => []))[0];
  if (first === undefined) throw new NotFoundError(`run "${runId}"`);
  if (typeof r.field !== 'string' || !FIELD.test(r.field)) throw bad('field must be lower_snake_case, at most 64 characters');
  const v = r.value;
  if (!((typeof v === 'string' && v.length <= 4000) || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean'))
    throw bad('value must be a string of at most 4000 characters, a number or a boolean');
  if (typeof r.reason !== 'string' || r.reason.trim().length === 0 || r.reason.length > 1000)
    throw bad('reason (why it should be this) is required, at most 1000 characters');
  const data = first.data as { inputs?: Record<string, unknown>; fanout?: { over: string; count: number } };
  const count = await fanoutOf(store, runId);
  let fields: Record<string, unknown> | undefined;
  let item: number | undefined;
  if (count !== undefined) {
    if (typeof r.item !== 'number' || !Number.isInteger(r.item) || r.item < 0 || r.item >= count)
      throw bad(`item must be a whole number from 0 to ${count - 1}`);
    item = r.item;
    const list = data.inputs?.[data.fanout!.over];
    fields = Array.isArray(list) ? (list[item] as Record<string, unknown> | undefined) : undefined;
  } else {
    if (r.item !== undefined) throw bad('this run has no items');
    fields = data.inputs;
  }
  if (fields === undefined || typeof fields !== 'object' || !(r.field in fields))
    throw bad('field is not a field of this item (or run) input');
  const stamp = randomBytes(8).toString('hex');
  const observationId = observationIdOf(runId, 'correction', r.field, item, undefined, stamp);
  const stored: StoredCorrection = {
    observationId,
    runId,
    ...(item !== undefined ? { item } : {}),
    field: r.field,
    value: v as string | number | boolean,
    reason: r.reason.trim(),
    by: r.actor.id,
    at: new Date().toISOString(),
  };
  const folder = correctionsDir(dir, runId);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${observationId}.json`), JSON.stringify(stored), { flag: 'wx', mode: 0o600 });
  // Ids and counts only: not the field, not the value, not the reason.
  await deps.audit?.tryRecord({
    action: 'run-learning.correction',
    actor: actorFromPrincipal(r.actor),
    correlationId: r.correlationId,
    target: { kind: 'workflow', id: 'run-learning', workspaceId: workspace.workspaceId },
    type: 'run-learning.correction-recorded',
    outcome: 'completed',
    metadata: { runId, ...(item !== undefined ? { item } : {}), observationId },
  });
  return {
    observation: {
      observationId,
      kind: 'correction',
      runId,
      ...(item !== undefined ? { item } : {}),
      at: stored.at,
      by: stored.by,
      summary: correctionSummary(r.field, item),
      correction: { field: r.field, value: stored.value, reason: stored.reason },
    },
  };
}

const CLAIMS: Readonly<Record<Observation['kind'], readonly [string, string]>> = {
  correction: ['xo-run:correction', 'xo-run:field.'],
  effect_reconciled: ['xo-run:effect', 'xo-run:outcome'],
  approval_rejected: ['xo-run:decision', 'xo-run:rejected'],
  task_not_done: ['xo-run:exception', 'xo-run:task-not-done'],
  escalation: ['xo-run:exception', 'xo-run:escalated'],
  left_out: ['xo-run:left-out', 'xo-run:excluded'],
  loose_match: ['xo-run:match', 'xo-run:matched-loosely'],
};

export interface ProposeFromObservations {
  readonly workspace: WorkspaceRecord;
  readonly actor: AuthenticatedPrincipal;
  readonly definition: WorkflowDefinitionRecord;
  readonly runId: string;
  readonly observationIds: unknown;
  readonly note?: unknown;
  readonly correlationId: string;
}

/** Proposes the chosen observations as claims for review. The knowledge head moves only when a reviewer approves the change set. */
export async function proposeFromObservations(
  deps: RunnerDeps,
  p: ProposeFromObservations,
): Promise<{ changeSet: ChangeSet; proposed: number }> {
  const { workspace, definition, runId } = p;
  const ids = p.observationIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !ids.every((x) => typeof x === 'string' && OBSERVATION_ID.test(x)))
    throw bad('observationIds must be 1 to 100 observation ids');
  if (p.note !== undefined && (typeof p.note !== 'string' || p.note.length > 1000))
    throw bad('note must be a string of at most 1000 characters');
  const chosen = [...new Set(ids as string[])];
  const all = await observationsOf(deps, workspace, definition, runId);
  const byId = new Map(all.map((o) => [o.observationId, o]));
  const unknown = chosen.filter((x) => !byId.has(x));
  if (unknown.length > 0)
    throw new XoError(ErrorCode.INVALID_ARGUMENT, `unknown_observation: ${unknown.length} id(s) are not observations of this run`, {
      context: { code: 'unknown_observation', count: unknown.length },
    });
  const dir = runsDir(deps.dataConfig, workspace.workspaceId, definition.definitionId);
  const manifest = await readManifest(dir, runId).catch(() => undefined);
  if (manifest === undefined || manifest.digest === 'mismatch' || typeof manifest.digest !== 'string')
    throw new XoError(ErrorCode.PRECONDITION_FAILED, 'this run has no readable manifest, so what it taught cannot be tied to it');
  const hex = manifest.digest.replace(/^sha256:/, '');
  const preview = await previewOfRun(dir, runId);
  const label = preview?.itemsSource;
  const now = new Date().toISOString();
  const claims: ClaimRecord[] = [];
  for (const id of chosen) {
    const o = byId.get(id)!;
    const [type, base] = CLAIMS[o.kind];
    const predicate = o.kind === 'correction' ? `${base}${o.correction!.field}` : base;
    const subject =
      o.row !== undefined && label !== undefined
        ? `${label.connectionName} / ${label.label}, row ${o.row}`
        : `run ${runId}, item ${o.item ?? 0}`;
    const content = { tenant: workspace.workspaceId, observation: id, type, predicate };
    const evidence: EvidenceRef = {
      sourceDigestSha256: hex,
      sourceName: `run ${runId}`,
      locator: { run: { runId, ...(o.step !== undefined ? { step: o.step } : {}), ...(o.item !== undefined ? { item: o.item } : {}) } },
      method: { kind: o.kind === 'correction' ? 'human' : 'system', name: 'xo.run-learning', version: '1' },
      observedAt: now,
    };
    claims.push({
      kind: 'claim',
      id: idOf('clm', content),
      tenantId: workspace.workspaceId,
      type,
      subject: { literal: subject },
      predicate,
      object: { value: o.kind === 'correction' ? o.correction!.value : (o.code ?? o.kind) },
      polarity: 'positive',
      modality: 'fact',
      authority: { level: 'source', basis: `observed in run ${runId}` },
      text: o.kind === 'correction' ? `${o.summary} ${o.correction!.reason}` : o.summary,
      origin: o.kind === 'correction' ? 'stated' : 'observed',
      evidence: [evidence],
      derivation: o.kind === 'correction' ? 'human' : 'system',
      confidence: 1,
      recordedAt: now,
    });
  }
  const kb = await workspaceKnowledgeBase(workspace, deps.dataConfig);
  const existing = (await kb.changeSets()).filter((c) => c.origin.kind === 'run-outcome' && c.status !== 'rejected');
  const taken = new Set(existing.flatMap((c) => c.operations.flatMap((op) => (op.op === 'add' ? [op.record.id] : []))));
  const dup = claims.filter((c) => taken.has(c.id));
  if (dup.length > 0)
    throw new XoError(ErrorCode.PRECONDITION_FAILED, `already_proposed: ${dup.length} of these observations are already in a change set`, {
      context: { code: 'already_proposed', count: dup.length },
    });
  const actor = p.actor;
  const changeSet = await kb.propose({
    operations: claims.map((record) => ({ op: 'add' as const, record })),
    origin: { kind: 'run-outcome', ref: runId },
    proposedBy: { id: actor.id, kind: actor.kind },
  });
  if (changeSet === undefined) throw bad('nothing to propose');
  await deps.audit?.tryRecord({
    action: 'run-learning.propose',
    actor: actorFromPrincipal(p.actor),
    correlationId: p.correlationId,
    target: { kind: 'knowledge-change-set', id: changeSet.changeSetId, workspaceId: workspace.workspaceId },
    type: 'knowledge.change-set.proposed',
    outcome: 'completed',
    metadata: { runId, observations: claims.length },
  });
  return { changeSet, proposed: claims.length };
}
