/**
 * UW-2 (ADR 0032) — the Workflow entity as Studio reads it: compact summaries for lists (phone-friendly), the detail for one
 * workflow, and the change feed. Parsed strictly; an unknown lifecycle is reported as unreadable, never shown as a state.
 */
import { WireParseError, arr, bool, num, obj, optStr, str } from './wire';

export const WORKFLOW_LIFECYCLES = [
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
export type WorkflowLifecycle = (typeof WORKFLOW_LIFECYCLES)[number];

function lifecycle(v: unknown, path: string): WorkflowLifecycle {
  const s = str(v, path);
  if (!(WORKFLOW_LIFECYCLES as readonly string[]).includes(s)) throw new WireParseError(path, `one of ${WORKFLOW_LIFECYCLES.join(', ')}`);
  return s as WorkflowLifecycle;
}

export interface WorkflowSummaryView {
  readonly workflowId: string;
  readonly name: string;
  readonly lifecycle: WorkflowLifecycle;
  readonly revision: number;
  readonly currentVersion: number;
  readonly pendingApprovals: number;
  readonly latestRun?: { readonly runId: string; readonly state: string; readonly startedAt: string };
  /** Present only when the caller owns the conversation the workflow came from. */
  readonly conversationId?: string;
  readonly paused: boolean;
  readonly archived: boolean;
  readonly updatedAt: string;
}

export interface WorkflowPage {
  readonly workflows: readonly WorkflowSummaryView[];
  readonly nextCursor?: string;
  readonly changesCursor: string;
}

export interface WorkflowRunSummaryView {
  readonly runId: string;
  readonly version: number;
  readonly state: string;
  readonly pendingApprovals: number;
  readonly startedAt: string;
  readonly startedBy?: string;
}

export interface WorkflowDetailView {
  readonly workflowId: string;
  readonly name: string;
  readonly revision: number;
  readonly lifecycle: WorkflowLifecycle;
  readonly paused: boolean;
  readonly archived: boolean;
  readonly workspacePaused: boolean;
  readonly origin: {
    readonly via: string;
    /** The conversation and message, for the conversation's owner; for anyone else only `linked: true`. */
    readonly conversation?: {
      readonly conversationId?: string;
      readonly messageId?: string;
      readonly available?: boolean;
      readonly linked?: boolean;
    };
  };
  readonly currentVersion: {
    readonly version: number;
    readonly definitionId: string;
    readonly goalText: string;
    readonly certificate?: { readonly certificateId: string; readonly status: string; readonly issuedAt: string };
  };
  readonly versionCount: number;
  readonly pendingApprovals: readonly {
    readonly runId: string;
    readonly approvalId: string;
    readonly step: string;
    readonly summary: string;
  }[];
  readonly runs: readonly WorkflowRunSummaryView[];
  readonly runsTotal: number;
  readonly history: readonly { readonly revision: number; readonly kind: string; readonly at: string }[];
  readonly updatedAt: string;
}

export interface WorkflowChangeView {
  readonly at: string;
  readonly workflowId: string;
  readonly kind: 'entity' | 'run';
  readonly event?: string;
  readonly runId?: string;
  readonly state?: string;
}

export function parseWorkflowSummary(v: unknown, path = 'workflow'): WorkflowSummaryView {
  const o = obj(v, path);
  const lr = o['latestRun'];
  const conversationId = optStr(o['conversationId'], `${path}.conversationId`);
  return {
    workflowId: str(o['workflowId'], `${path}.workflowId`),
    name: str(o['name'], `${path}.name`),
    lifecycle: lifecycle(o['lifecycle'], `${path}.lifecycle`),
    revision: num(o['revision'], `${path}.revision`),
    currentVersion: num(o['currentVersion'], `${path}.currentVersion`),
    pendingApprovals: num(o['pendingApprovals'], `${path}.pendingApprovals`),
    ...(lr !== undefined
      ? {
          latestRun: (() => {
            const r = obj(lr, `${path}.latestRun`);
            return {
              runId: str(r['runId'], `${path}.latestRun.runId`),
              state: str(r['state'], `${path}.latestRun.state`),
              startedAt: str(r['startedAt'], `${path}.latestRun.startedAt`),
            };
          })(),
        }
      : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
    paused: bool(o['paused'], `${path}.paused`),
    archived: bool(o['archived'], `${path}.archived`),
    updatedAt: str(o['updatedAt'], `${path}.updatedAt`),
  };
}

export function parseWorkflowPage(v: unknown): WorkflowPage {
  const o = obj(v, 'body');
  const next = optStr(o['nextCursor'], 'nextCursor');
  return {
    workflows: arr(o['workflows'], 'workflows').map((w, i) => parseWorkflowSummary(w, `workflows[${i}]`)),
    ...(next !== undefined ? { nextCursor: next } : {}),
    changesCursor: str(o['changesCursor'], 'changesCursor'),
  };
}

export function parseWorkflowDetail(v: unknown, path = 'workflow'): WorkflowDetailView {
  const o = obj(v, path);
  const origin = obj(o['origin'], `${path}.origin`);
  const conv = origin['conversation'];
  const cur = obj(o['currentVersion'], `${path}.currentVersion`);
  const def = obj(cur['definition'], `${path}.currentVersion.definition`);
  const cert = cur['certificate'];
  return {
    workflowId: str(o['workflowId'], `${path}.workflowId`),
    name: str(o['name'], `${path}.name`),
    revision: num(o['revision'], `${path}.revision`),
    lifecycle: lifecycle(o['lifecycle'], `${path}.lifecycle`),
    paused: bool(o['paused'], `${path}.paused`),
    archived: bool(o['archived'], `${path}.archived`),
    workspacePaused: bool(o['workspacePaused'], `${path}.workspacePaused`),
    origin: {
      via: str(origin['via'], `${path}.origin.via`),
      ...(conv !== undefined
        ? {
            conversation: (() => {
              const c = obj(conv, `${path}.origin.conversation`);
              const id = optStr(c['conversationId'], `${path}.origin.conversation.conversationId`);
              const mid = optStr(c['messageId'], `${path}.origin.conversation.messageId`);
              return {
                ...(id !== undefined ? { conversationId: id } : {}),
                ...(mid !== undefined ? { messageId: mid } : {}),
                ...(typeof c['available'] === 'boolean' ? { available: c['available'] } : {}),
                ...(c['linked'] === true ? { linked: true } : {}),
              };
            })(),
          }
        : {}),
    },
    currentVersion: {
      version: num(cur['version'], `${path}.currentVersion.version`),
      definitionId: str(def['definitionId'], `${path}.currentVersion.definition.definitionId`),
      goalText: str(cur['goalText'], `${path}.currentVersion.goalText`),
      ...(cert !== undefined
        ? {
            certificate: (() => {
              const c = obj(cert, `${path}.currentVersion.certificate`);
              return {
                certificateId: str(c['certificateId'], `${path}.currentVersion.certificate.certificateId`),
                status: str(c['status'], `${path}.currentVersion.certificate.status`),
                issuedAt: str(c['issuedAt'], `${path}.currentVersion.certificate.issuedAt`),
              };
            })(),
          }
        : {}),
    },
    versionCount: arr(o['versions'], `${path}.versions`).length,
    pendingApprovals: arr(o['pendingApprovals'], `${path}.pendingApprovals`).map((a, i) => {
      const p = `${path}.pendingApprovals[${i}]`;
      const ao = obj(a, p);
      return {
        runId: str(ao['runId'], `${p}.runId`),
        approvalId: str(ao['approvalId'], `${p}.approvalId`),
        step: str(ao['step'], `${p}.step`),
        summary: str(ao['summary'], `${p}.summary`),
      };
    }),
    runs: arr(o['runs'], `${path}.runs`).map((r, i) => {
      const p = `${path}.runs[${i}]`;
      const ro = obj(r, p);
      const by = optStr(ro['startedBy'], `${p}.startedBy`);
      return {
        runId: str(ro['runId'], `${p}.runId`),
        version: num(ro['version'], `${p}.version`),
        state: str(ro['state'], `${p}.state`),
        pendingApprovals: num(ro['pendingApprovals'], `${p}.pendingApprovals`),
        startedAt: str(ro['startedAt'], `${p}.startedAt`),
        ...(by !== undefined ? { startedBy: by } : {}),
      };
    }),
    runsTotal: num(o['runsTotal'], `${path}.runsTotal`),
    history: arr(o['history'], `${path}.history`).map((h, i) => {
      const p = `${path}.history[${i}]`;
      const ho = obj(h, p);
      return { revision: num(ho['revision'], `${p}.revision`), kind: str(ho['kind'], `${p}.kind`), at: str(ho['at'], `${p}.at`) };
    }),
    updatedAt: str(o['updatedAt'], `${path}.updatedAt`),
  };
}

/** `{ workflow }` from create and change calls; `null` when the goal asked a question instead (nothing was created). */
export function parseWorkflowReply(v: unknown): WorkflowDetailView | null {
  const o = obj(v, 'body');
  return o['workflow'] === null ? null : parseWorkflowDetail(o['workflow']);
}

export function parseWorkflowChanges(v: unknown): { readonly changes: readonly WorkflowChangeView[]; readonly cursor: string } {
  const o = obj(v, 'body');
  return {
    changes: arr(o['changes'], 'changes').map((c, i) => {
      const p = `changes[${i}]`;
      const co = obj(c, p);
      const kind = str(co['kind'], `${p}.kind`);
      if (kind !== 'entity' && kind !== 'run') throw new WireParseError(`${p}.kind`, 'entity or run');
      const event = optStr(co['event'], `${p}.event`);
      const runId = optStr(co['runId'], `${p}.runId`);
      const state = optStr(co['state'], `${p}.state`);
      return {
        at: str(co['at'], `${p}.at`),
        workflowId: str(co['workflowId'], `${p}.workflowId`),
        kind,
        ...(event !== undefined ? { event } : {}),
        ...(runId !== undefined ? { runId } : {}),
        ...(state !== undefined ? { state } : {}),
      };
    }),
    cursor: str(o['cursor'], 'cursor'),
  };
}

/** S1-0: one run in the workspace's run list (Activity), across workflows and runs started on a generated definition directly. */
export interface WorkspaceRunView {
  readonly runId: string;
  readonly definitionId: string;
  /** The compilation and the compiled workflow the definition was generated from (how a run is matched to its workflow). */
  readonly compilationId: string;
  readonly candidateWorkflowId: string;
  /** Present when the run was started on a Workflow entity. */
  readonly workflowId?: string;
  readonly version?: number;
  readonly name: string;
  /** The engine's run state; an unfamiliar state is shown as it is, never mapped to a known one. */
  readonly state: string;
  readonly pendingApprovals: number;
  readonly startedAt: string;
  readonly startedBy?: string;
  readonly cancelled?: boolean;
  readonly batchOutcome?: string;
}

export interface WorkspaceRunPage {
  readonly runs: readonly WorkspaceRunView[];
  readonly nextCursor?: string;
}

export function parseWorkspaceRunPage(v: unknown): WorkspaceRunPage {
  const o = obj(v, 'body');
  const next = optStr(o['nextCursor'], 'nextCursor');
  return {
    runs: arr(o['runs'], 'runs').map((x, i) => {
      const p = `runs[${i}]`;
      const r = obj(x, p);
      const workflowId = optStr(r['workflowId'], `${p}.workflowId`);
      const startedBy = optStr(r['startedBy'], `${p}.startedBy`);
      const batchOutcome = optStr(r['batchOutcome'], `${p}.batchOutcome`);
      return {
        runId: str(r['runId'], `${p}.runId`),
        definitionId: str(r['definitionId'], `${p}.definitionId`),
        compilationId: str(r['compilationId'], `${p}.compilationId`),
        candidateWorkflowId: str(r['candidateWorkflowId'], `${p}.candidateWorkflowId`),
        ...(workflowId !== undefined ? { workflowId, version: num(r['version'], `${p}.version`) } : {}),
        name: str(r['name'], `${p}.name`),
        state: str(r['state'], `${p}.state`),
        pendingApprovals: num(r['pendingApprovals'], `${p}.pendingApprovals`),
        startedAt: str(r['startedAt'], `${p}.startedAt`),
        ...(startedBy !== undefined ? { startedBy } : {}),
        ...(r['cancelled'] === true ? { cancelled: true } : {}),
        ...(batchOutcome !== undefined ? { batchOutcome } : {}),
      };
    }),
    ...(next !== undefined ? { nextCursor: next } : {}),
  };
}
