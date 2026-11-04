import type { ConnectorHost } from '@xo/connectors';
import type { ApprovalRequest, ApprovalSink } from './approvals.js';
import type { Escalation } from './runner.js';

export interface DeliveryTarget {
  readonly host: ConnectorHost;
  /** A manifest-declared connector with a `send`-style write operation taking `{ to, subject, body }` (SMTP). */
  readonly connector: string;
  readonly operation: string;
  readonly to: readonly string[];
}

/**
 * Delivers through the same connector host as workflow actions, so grants, redaction, hashing and the allowlist of recipient
 * domains all apply. Delivery failure THROWS: an unreachable approver must surface, never be swallowed (the runner then fails the step
 * and escalates). The idempotency key is the approval id, so a retry carries the same Message-ID.
 */
export function connectorApprovalSink(t: DeliveryTarget): ApprovalSink {
  return async (r: ApprovalRequest) => {
    const body = [
      r.summary,
      '',
      `Workflow: ${r.workflow}@${r.version}  Step: ${r.step}  Run: ${r.runId}`,
      `Approval id: ${r.approvalId}`,
      `Roles allowed to decide: ${r.roles.join(', ')}`,
      `Expires: ${r.expiresAt}`,
      r.proposedActions.length > 0 ? `If approved, this will: ${r.proposedActions.join('; ')}` : '',
      '',
      'Case:',
      JSON.stringify(r.case, null, 2),
      '',
      'Decide with a signed decision through the approvals API. Replying to this message does nothing.',
    ].join('\n');
    await t.host.call({
      connector: t.connector,
      operation: t.operation,
      args: { to: [...t.to], subject: `[approval needed] ${r.workflow}: ${r.summary}`.slice(0, 190), body },
      runId: r.runId,
      stepId: r.step,
      timeoutMs: 20_000,
      idempotencyKey: r.approvalId,
    });
  };
}

export function connectorEscalationSink(t: DeliveryTarget): (e: Escalation) => Promise<void> {
  return async (e) => {
    await t.host.call({
      connector: t.connector,
      operation: t.operation,
      args: {
        to: [...t.to],
        subject: `[escalation] ${e.workflow}: ${e.code}`.slice(0, 190),
        body: [
          `Run ${e.runId} needs a person.`,
          `Step: ${e.step ?? '(run level)'}`,
          `Reason: ${e.reason}`,
          e.target !== undefined ? `Suggested owner: ${e.target}` : '',
          e.uncompensated?.length ? `Could not be undone: ${e.uncompensated.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
      runId: e.runId,
      stepId: e.step ?? 'run',
      timeoutMs: 20_000,
      idempotencyKey: `esc:${e.runId}:${e.code}:${e.step ?? 'run'}`.replace(/[^A-Za-z0-9._:-]/g, ''),
    });
  };
}
