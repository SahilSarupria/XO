import { ErrorCode, XoError } from '@xo/errors';

/**
 * UW-2 (ADR 0032) — the Workflow entity: XO's durable identity for one piece of work a person asked for.
 *
 * A Workflow is distinct from an XO (an installed capability package) and from a conversation (where it was asked for). It
 * owns: a name, where it came from (an optional link to the `cnv_` conversation and message it was created from, ADR 0013),
 * an ordered list of immutable versions (each pointing at one content-addressed definition), and whether a person has paused
 * or archived it. It does NOT own run state: runs live in the engine's journal and are reached through `WorkflowRunPort`
 * (`run-port.ts`), so the entity never holds a second, divergent copy of what a run is doing. Its lifecycle is therefore
 * DERIVED (`deriveLifecycle`) from the stored flags, the current version's readiness certificate and its runs.
 *
 * Persistence (`entity-store.ts`) is one immutable snapshot per revision, created with an atomic create-if-absent, so two
 * writers (two requests, two API processes) can never both win the same revision: the loser gets a stale-revision error.
 * The chain of revisions is the entity's own history.
 */

export const WORKFLOW_ENTITY_SCHEMA = 'xo.workflow.v1';
export const WORKFLOW_ID = /^wfl_[0-9a-f]{32}$/;
export const MAX_WORKFLOWS_PER_WORKSPACE = 2000;
export const MAX_VERSIONS = 100;
export const MAX_NAME = 120;
export const MAX_NOTE = 500;

/** ADR 0013: a workflow may originate only from a `cnv_` conversation. The discriminator survives a storage change. */
export interface ConversationRef {
  readonly store: 'cnv';
  readonly conversationId: string;
  /** The message (normally the person's prompt) the workflow was created from. */
  readonly messageId?: string;
}

/**
 * What one version runs. Today only generated Workflow IR (`gwf_…`, PX-6 to PX-10) is a workflow definition with a digest,
 * a readiness certificate and a canonical engine (ADR 0011); the union is kept open so another definition kind can be added
 * without changing stored records.
 */
export interface GeneratedDefinitionRef {
  readonly kind: 'generated';
  readonly definitionId: string;
  readonly definitionDigest: string;
  readonly compilationId: string;
  readonly candidateWorkflowId: string;
  /** UW-6 (ADR 0043): digest of the proposal-to-validation trace stored with the definition this version points at. Absent on versions made before UW-6. */
  readonly intentTraceDigest?: string;
}
export type DefinitionRef = GeneratedDefinitionRef;

export interface WorkflowVersion {
  readonly version: number;
  readonly definition: DefinitionRef;
  readonly goalText: string;
  readonly createdAt: string;
  readonly createdBy: Actor;
  readonly note?: string;
}

export interface Actor {
  readonly id: string;
  readonly kind: string;
}

/** What produced a revision. The revision chain is the entity's history. */
export type WorkflowEventKind = 'created' | 'version_added' | 'renamed' | 'paused' | 'resumed' | 'archived' | 'restored';

export interface WorkflowEntity {
  readonly schema: typeof WORKFLOW_ENTITY_SCHEMA;
  readonly workflowId: string;
  readonly workspaceId: string;
  /** Monotonic, starting at 1; every change is a new revision. */
  readonly revision: number;
  readonly name: string;
  readonly origin: {
    readonly via: 'conversation' | 'api';
    readonly conversation?: ConversationRef;
    readonly createdBy: Actor;
    readonly createdAt: string;
  };
  readonly versions: readonly WorkflowVersion[];
  /** Holds new starts (the workspace-wide pause is separate and also holds them). Runs already started are not affected. */
  readonly paused: boolean;
  readonly archived: boolean;
  readonly updatedAt: string;
  readonly updatedBy: Actor;
  /** The change that produced this revision. */
  readonly event: {
    readonly kind: WorkflowEventKind;
    readonly at: string;
    readonly by: Actor;
    readonly detail?: Readonly<Record<string, string | number>>;
  };
}

/**
 * The lifecycle a client shows. ADR 0032 fixes the set (the plan's seven, plus the engine's escalated and cancelled outcomes
 * and the person's archive):
 *  - draft: the current version has no READY certificate yet;
 *  - ready: the current version has a READY / READY_WITH_CONDITIONS certificate (re-verified at every start) and no run;
 *  - awaiting_approval: a run is waiting for a person's decision;
 *  - running: a run is in progress (including one waiting on a timer);
 *  - paused: new starts are held (the workflow or the whole workspace is paused) and nothing is in progress;
 *  - needs_attention: the latest run escalated to a person (for example an unknown connector outcome);
 *  - completed / failed / cancelled: the latest run of the current version ended so (a run cancelled and undone under
 *    `onCancel: compensate` is cancelled; a failure that was undone is failed);
 *  - partially_completed (UW-7, ADR 0033): the latest run was a batch in which some items completed and the others failed;
 *  - archived: put away by a person; history and runs are kept.
 */
export const WORKFLOW_LIFECYCLE = [
  'draft',
  'ready',
  'awaiting_approval',
  'running',
  'paused',
  'needs_attention',
  'completed',
  'partially_completed',
  'failed',
  'cancelled',
  'archived',
] as const;
export type WorkflowLifecycle = (typeof WORKFLOW_LIFECYCLE)[number];

/** What the run port reports about one run, enough to derive the lifecycle. */
export interface RunFacts {
  readonly runId: string;
  readonly version: number;
  /** The engine's run state (`@xo/workflow-ir` RUN_STATES). */
  readonly state: string;
  readonly pendingApprovals: number;
  readonly startedAt: string;
  /** UW-7: the run ended because a person cancelled it (its result says so). */
  readonly cancelled?: boolean;
  /** UW-7: a batch's outcome (`all_completed`, `partially_completed`, `none_completed`). */
  readonly batchOutcome?: string;
}

const ACTIVE = new Set(['created', 'running', 'waiting', 'compensating']);

export function deriveLifecycle(input: {
  readonly entity: WorkflowEntity;
  readonly runs: readonly RunFacts[];
  readonly currentCertificateStatus?: string;
  readonly workspacePaused: boolean;
}): WorkflowLifecycle {
  const { entity, runs } = input;
  if (entity.archived) return 'archived';
  const newestFirst = [...runs].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  // Anything in progress, of any version, is what a person needs to see first.
  const active = newestFirst.filter((r) => ACTIVE.has(r.state));
  if (active.some((r) => r.pendingApprovals > 0)) return 'awaiting_approval';
  if (active.length > 0) return 'running';
  if (entity.paused || input.workspacePaused) return 'paused';
  const current = currentVersion(entity).version;
  const latest = newestFirst.find((r) => r.version === current);
  if (latest !== undefined) {
    if (latest.state === 'completed') return 'completed';
    if (latest.state === 'escalated') return 'needs_attention';
    if (latest.state === 'cancelled') return 'cancelled';
    // Compensated means undone: after a cancel it is a cancel, after a failure it is a failure (never "completed").
    if (latest.state === 'compensated') return latest.cancelled === true ? 'cancelled' : 'failed';
    if (latest.batchOutcome === 'partially_completed') return 'partially_completed';
    return 'failed';
  }
  const s = input.currentCertificateStatus;
  return s === 'READY' || s === 'READY_WITH_CONDITIONS' ? 'ready' : 'draft';
}

export function currentVersion(entity: WorkflowEntity): WorkflowVersion {
  const v = entity.versions[entity.versions.length - 1];
  if (v === undefined) throw new XoError(ErrorCode.UNKNOWN, `workflow ${entity.workflowId} has no version`);
  return v;
}

export function parseName(v: unknown, fallback: string): string {
  if (v === undefined) return fallback.trim().slice(0, MAX_NAME) || 'Untitled workflow';
  if (typeof v !== 'string' || v.trim().length === 0 || v.trim().length > MAX_NAME)
    throw new XoError(ErrorCode.INVALID_ARGUMENT, `name must be a non-empty string of at most ${MAX_NAME} characters`);
  return v.trim();
}

export function parseNote(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > MAX_NOTE)
    throw new XoError(ErrorCode.INVALID_ARGUMENT, `note must be a string of at most ${MAX_NOTE} characters`);
  return v.trim() || undefined;
}

/** Rejects every field a client may not set (identity, ids, paths, revisions other than expectedRevision). */
export function onlyFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length > 0)
    throw new XoError(ErrorCode.INVALID_ARGUMENT, `unknown field(s): ${unknown.join(', ')}`, { context: { unknownFields: unknown } });
}
