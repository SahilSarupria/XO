/**
 * PX-8 (gap PX-G26) — the Workflow Readiness Certificate as Studio reads it. Parsed strictly: a certificate Studio cannot
 * read is reported as untrusted, never shown as ready.
 */
import { WireParseError, arr, obj, optStr, str, strArr } from './wire';

export const READINESS_STATUSES = ['READY', 'READY_WITH_CONDITIONS', 'NEEDS_REVIEW', 'BLOCKED'] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];
export const GATE_OUTCOMES = ['pass', 'condition', 'review', 'block'] as const;
export type GateOutcome = (typeof GATE_OUTCOMES)[number];

export interface ReadinessGateView {
  readonly id: string;
  readonly outcome: GateOutcome;
  readonly findings: readonly string[];
}

export interface ReadinessCertificateView {
  readonly certificateId: string;
  readonly status: ReadinessStatus;
  readonly scope: {
    readonly compilationId?: string;
    readonly definitionId?: string;
    readonly candidateWorkflowId: string;
    readonly workflowName: string;
  };
  readonly gates: readonly ReadinessGateView[];
  readonly blockers: readonly string[];
  readonly reviewItems: readonly string[];
  readonly conditions: readonly string[];
  readonly issuedAt: string;
  readonly digest: string;
}

export interface CertificateCheck {
  readonly certificateId: string;
  readonly startAllowed: boolean;
  readonly reasons: readonly string[];
}

export function parseReadinessCertificate(v: unknown, path = 'certificate'): ReadinessCertificateView {
  const o = obj(v, path);
  const status = str(o['status'], `${path}.status`);
  if (!(READINESS_STATUSES as readonly string[]).includes(status))
    throw new WireParseError(`${path}.status`, READINESS_STATUSES.join(', '));
  const sc = obj(o['scope'], `${path}.scope`);
  const compilationId = optStr(sc['compilationId'], `${path}.scope.compilationId`);
  const definitionId = optStr(sc['definitionId'], `${path}.scope.definitionId`);
  return {
    certificateId: str(o['certificateId'], `${path}.certificateId`),
    status: status as ReadinessStatus,
    scope: {
      ...(compilationId !== undefined ? { compilationId } : {}),
      ...(definitionId !== undefined ? { definitionId } : {}),
      candidateWorkflowId: str(sc['candidateWorkflowId'], `${path}.scope.candidateWorkflowId`),
      workflowName: str(sc['workflowName'], `${path}.scope.workflowName`),
    },
    gates: arr(o['gates'], `${path}.gates`).map((g, i) => {
      const go = obj(g, `${path}.gates[${i}]`);
      const outcome = str(go['outcome'], `${path}.gates[${i}].outcome`);
      if (!(GATE_OUTCOMES as readonly string[]).includes(outcome))
        throw new WireParseError(`${path}.gates[${i}].outcome`, GATE_OUTCOMES.join(', '));
      return {
        id: str(go['id'], `${path}.gates[${i}].id`),
        outcome: outcome as GateOutcome,
        findings: strArr(go['findings'], `${path}.gates[${i}].findings`),
      };
    }),
    blockers: strArr(o['blockers'], `${path}.blockers`),
    reviewItems: strArr(o['reviewItems'], `${path}.reviewItems`),
    conditions: strArr(o['conditions'], `${path}.conditions`),
    issuedAt: str(o['issuedAt'], `${path}.issuedAt`),
    digest: str(o['digest'], `${path}.digest`),
  };
}

export function parseCertificateCheck(v: unknown): CertificateCheck {
  const o = obj(v, 'body');
  const allowed = o['startAllowed'];
  if (typeof allowed !== 'boolean') throw new WireParseError('startAllowed', 'a boolean');
  return {
    certificateId: str(o['certificateId'], 'certificateId'),
    startAllowed: allowed,
    reasons: o['reasons'] === undefined ? [] : strArr(o['reasons'], 'reasons'),
  };
}

/** The reply to generating a workflow: the definition id, or why the goal did not select one. */
export function parseGeneratedWorkflowReply(v: unknown): { readonly definitionId?: string; readonly question?: string } {
  const o = obj(v, 'body');
  if (o['definition'] === null) {
    const sel = obj(o['selection'], 'selection');
    return {
      question:
        optStr(sel['question'], 'selection.question') ?? optStr(sel['reason'], 'selection.reason') ?? 'The goal did not select a workflow.',
    };
  }
  const d = obj(o['definition'], 'definition');
  return { definitionId: str(d['definitionId'], 'definition.definitionId') };
}

/**
 * ADR 0031 — a run of a generated workflow on the Workflow IR runtime, as Studio reads it: its state, the approvals it
 * waits for, and the decisions already made (each re-verified by the platform against its signing keyring).
 */
export interface GeneratedRunView {
  readonly runId: string;
  readonly state: string;
  readonly startedBy?: string;
  readonly pendingApprovals: readonly {
    readonly approvalId: string;
    readonly step: string;
    readonly summary: string;
    readonly expiresAt: string;
  }[];
  readonly decisions: readonly {
    readonly step: string;
    readonly reviewerId: string;
    readonly action: string;
    readonly signatureVerified: boolean;
  }[];
}

export function parseGeneratedRun(v: unknown, path = 'run'): GeneratedRunView {
  const o = obj(v, path);
  const startedBy = optStr(o['startedBy'], `${path}.startedBy`);
  return {
    runId: str(o['runId'], `${path}.runId`),
    state: str(o['state'], `${path}.state`),
    ...(startedBy !== undefined ? { startedBy } : {}),
    pendingApprovals: arr(o['pendingApprovals'] ?? [], `${path}.pendingApprovals`).map((a, i) => {
      const ao = obj(a, `${path}.pendingApprovals[${i}]`);
      return {
        approvalId: str(ao['approvalId'], `${path}.pendingApprovals[${i}].approvalId`),
        step: str(ao['step'], `${path}.pendingApprovals[${i}].step`),
        summary: str(ao['summary'], `${path}.pendingApprovals[${i}].summary`),
        expiresAt: str(ao['expiresAt'], `${path}.pendingApprovals[${i}].expiresAt`),
      };
    }),
    decisions: arr(o['decisions'] ?? [], `${path}.decisions`).map((d, i) => {
      const dobj = obj(d, `${path}.decisions[${i}]`);
      const verified = dobj['signatureVerified'];
      if (typeof verified !== 'boolean') throw new WireParseError(`${path}.decisions[${i}].signatureVerified`, 'a boolean');
      return {
        step: str(dobj['step'], `${path}.decisions[${i}].step`),
        reviewerId: str(dobj['reviewerId'], `${path}.decisions[${i}].reviewerId`),
        action: str(dobj['action'], `${path}.decisions[${i}].action`),
        signatureVerified: verified,
      };
    }),
  };
}

export function parseGeneratedRunList(v: unknown): GeneratedRunView[] {
  return arr(obj(v, 'body')['runs'], 'runs').map((r, i) => parseGeneratedRun(r, `runs[${i}]`));
}
