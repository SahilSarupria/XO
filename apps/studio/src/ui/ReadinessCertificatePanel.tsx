import { ProposeStandingForm } from './StandingApprovals';
import { useState } from 'react';
import { can, whyNot } from '../domain/access';
import type { ApiProblem } from '../platform/client';
import type { WorkspaceRole } from '../platform/wire';
import type {
  CertificateCheck,
  EmailTierLine,
  GateOutcome,
  GeneratedRunView,
  ReadinessCertificateView,
  ReadinessStatus,
} from '../platform/wire-readiness';
import { useGuardedAction } from './actions';
import { CancelRun } from './ControlCards';
import { Button, formatWhen, ProblemNotice } from './primitives';
import { useSession } from './session';
import { RunResults } from './RunResults';

const STATUS_LABEL: Record<ReadinessStatus, string> = {
  READY: 'Ready to start',
  READY_WITH_CONDITIONS: 'Ready, with conditions',
  NEEDS_REVIEW: 'Needs a person first',
  BLOCKED: 'Blocked',
};

const GATE_LABEL: Record<string, string> = {
  'source-quality': 'The documents could be read',
  completeness: 'Nothing is left open',
  knowledge: 'The business knowledge agrees',
  goal: 'It is the workflow you meant',
  capabilities: 'Every step can be carried out',
  authorization: 'Every step is approved',
  'workflow-definition': 'The workflow itself is sound',
};

const OUTCOME_MARK: Record<GateOutcome, string> = { pass: '✓', condition: '!', review: '?', block: '✕' };

/**
 * PX-8 (gap PX-G26) — the pre-start proof. This is NOT the mode readiness above (rules, runnable, signed, limits,
 * practice): it is the platform's Workflow Readiness Certificate, recomputed by the platform from everything the workflow
 * depends on. Studio only shows what the certificate says; it never decides readiness itself. A certificate can go stale
 * (a document, a rule, an approval or the knowledge changed) — "Check it is still current" asks the platform the same
 * question the start gate asks.
 */
export function ReadinessCertificatePanel(props: {
  workspaceId: string;
  compilationId: string;
  workflowId: string;
  workflowName: string;
  role: WorkspaceRole | undefined;
}) {
  const { client } = useSession();
  const { run, busy } = useGuardedAction();
  const [cert, setCert] = useState<ReadinessCertificateView | undefined>();
  const [check, setCheck] = useState<CertificateCheck | undefined>();
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [runs, setRuns] = useState<readonly GeneratedRunView[] | undefined>();
  const [email, setEmail] = useState<readonly EmailTierLine[] | undefined>();
  const author = can(props.role, 'author');
  const reviewer = can(props.role, 'review');
  const definitionId = cert?.scope.definitionId;

  const loadRuns = (id: string) =>
    void run(async () => {
      const r = await client.listGeneratedRuns(props.workspaceId, id);
      if (r.ok) setRuns(r.value);
      else setProblem(r.problem);
    });
  const decide = (id: string, runId: string, approvalId: string, action: 'approve' | 'reject') =>
    void run(async () => {
      setProblem(undefined);
      const r = await client.decideGeneratedApproval(props.workspaceId, id, runId, approvalId, action);
      if (!r.ok) setProblem(r.problem);
      const all = await client.listGeneratedRuns(props.workspaceId, id);
      if (all.ok) setRuns(all.value);
    });

  const certify = () =>
    void run(async () => {
      setProblem(undefined);
      setCheck(undefined);
      const r = await client.certifyWorkflow(props.workspaceId, props.compilationId, props.workflowId, props.workflowName);
      if (r.ok) setCert(r.value);
      else setProblem(r.problem);
      // UW-10: how email would be sent, in plain words. Not part of the certificate; a failure to load it just leaves it out.
      const e = await client.emailTiers(props.workspaceId);
      setEmail(e.ok ? e.value : undefined);
    });
  const recheck = (id: string) =>
    void run(async () => {
      setProblem(undefined);
      const r = await client.checkReadinessCertificate(props.workspaceId, id);
      if (r.ok) setCheck(r.value);
      else setProblem(r.problem);
    });

  return (
    <section className="wr" aria-label="Pre-start check">
      <div className="wp-head">
        <h3>Pre-start check</h3>
        {cert !== undefined ? <span data-readiness={cert.status}>{STATUS_LABEL[cert.status]}</span> : null}
      </div>
      <p className="wm-explain">
        Before this workflow runs, XO can check everything it depends on and issue a certificate. A start that presents it is checked again;
        if anything changed since, the start is refused.
      </p>
      {cert !== undefined ? (
        <>
          <ul className="wr-gates" aria-label="What was checked">
            {cert.gates.map((g) => (
              <li key={g.id} data-outcome={g.outcome}>
                <span className="wp-mark" aria-hidden="true">
                  {OUTCOME_MARK[g.outcome]}
                </span>
                <div>
                  {GATE_LABEL[g.id] ?? g.id}
                  {g.outcome !== 'pass' ? (
                    <ul className="wr-findings">
                      {g.findings.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {email !== undefined && email.length > 0 ? (
            <section aria-label="How email is sent">
              <h4>How email is sent</h4>
              <ul className="wr-findings">
                {email.map((e) => (
                  <li key={e.connector} data-tier={e.tier}>
                    {e.explanation}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {cert.status === 'READY' && cert.scope.definitionId !== undefined ? (
            <ProposeStandingForm
              workspaceId={props.workspaceId}
              definitionId={cert.scope.definitionId}
              certificateId={cert.certificateId}
              role={props.role}
            />
          ) : null}
          <small>
            Certificate {cert.certificateId}, issued {formatWhen(cert.issuedAt)}
          </small>
          {check !== undefined ? (
            <p role="status" data-current={check.startAllowed}>
              {check.startAllowed ? 'Still current: a start can present it.' : `No longer allows a start: ${check.reasons.join('; ')}`}
            </p>
          ) : null}
        </>
      ) : null}
      {definitionId !== undefined && runs !== undefined ? (
        <section aria-label="Runs on the workflow runtime">
          <h4>Runs on the workflow runtime</h4>
          {runs.length === 0 ? <p>No runs yet.</p> : null}
          <ul className="wr-runs">
            {runs.map((r) => (
              <li key={r.runId} data-state={r.state}>
                {r.runId}: {r.state}
                {r.startedBy !== undefined ? `, started by ${r.startedBy}` : ''}
                {/* UW-12b: a run still in progress can be cancelled; the platform records it first and starts no call after it. */}
                {['created', 'running', 'waiting'].includes(r.state) ? (
                  <div className="wm-row">
                    <CancelRun
                      workspaceId={props.workspaceId}
                      definitionId={definitionId}
                      runId={r.runId}
                      batch={false}
                      role={props.role}
                      onChanged={() => loadRuns(definitionId)}
                    />
                  </div>
                ) : null}
                <RunResults workspaceId={props.workspaceId} definitionId={definitionId} runId={r.runId} role={props.role} />
                {r.pendingApprovals.map((a) => (
                  <div key={a.approvalId} className="wm-row">
                    <span>Waiting for a person: {a.summary}</span>
                    <Button
                      onClick={() => decide(definitionId, r.runId, a.approvalId, 'approve')}
                      disabled={!reviewer || busy}
                      title={reviewer ? undefined : whyNot(props.role, 'review', 'deciding a step')}
                    >
                      Done as instructed
                    </Button>
                    <Button
                      onClick={() => decide(definitionId, r.runId, a.approvalId, 'reject')}
                      disabled={!reviewer || busy}
                      title={reviewer ? undefined : whyNot(props.role, 'review', 'deciding a step')}
                    >
                      Reject
                    </Button>
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
      <div className="wm-row">
        <Button
          onClick={certify}
          disabled={!author || busy}
          title={author ? undefined : whyNot(props.role, 'author', 'checking a workflow')}
        >
          {cert === undefined ? 'Check before starting' : 'Check again'}
        </Button>
        {cert !== undefined ? (
          <Button onClick={() => recheck(cert.certificateId)} disabled={busy}>
            Check it is still current
          </Button>
        ) : null}
        {definitionId !== undefined ? (
          <Button onClick={() => loadRuns(definitionId)} disabled={busy}>
            Show runs on the workflow runtime
          </Button>
        ) : null}
      </div>
    </section>
  );
}
