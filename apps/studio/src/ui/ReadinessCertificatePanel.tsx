import { useState } from 'react';
import { can, whyNot } from '../domain/access';
import type { ApiProblem } from '../platform/client';
import type { WorkspaceRole } from '../platform/wire';
import type { CertificateCheck, GateOutcome, ReadinessCertificateView, ReadinessStatus } from '../platform/wire-readiness';
import { useGuardedAction } from './actions';
import { Button, formatWhen, ProblemNotice } from './primitives';
import { useSession } from './session';

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
  const author = can(props.role, 'author');

  const certify = () =>
    void run(async () => {
      setProblem(undefined);
      setCheck(undefined);
      const r = await client.certifyWorkflow(props.workspaceId, props.compilationId, props.workflowId, props.workflowName);
      if (r.ok) setCert(r.value);
      else setProblem(r.problem);
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
      </div>
    </section>
  );
}
