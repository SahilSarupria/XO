import { useState } from 'react';
import { can, whyNot } from '../domain/access';
import type { ApiProblem } from '../platform/client';
import type { WorkspaceRole } from '../platform/wire';
import type { InboxItem, Notification } from '../platform/wire-studio';
import { Badge, Button, formatWhen, loadedValue, ProblemNotice, Skeleton, useLoad } from './primitives';
import { useSession } from './session';

const KIND_TEXT: Record<Notification['kind'], string> = {
  escalation: 'Something needs a person to decide',
  run_failure: 'A run failed',
  workflow_complete: 'A process finished',
};

/**
 * Notifications are the platform's own feed, built from its audit log and filtered by the notification settings. They are
 * in-app only: nothing is emailed or pushed, and the panel says so rather than implying it.
 */
export function NotificationsPanel(props: { workspaceId: string; onChanged?: () => void }) {
  const { client } = useSession();
  const feed = useLoad(() => client.listNotifications(props.workspaceId), [client, props.workspaceId]);
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const f = loadedValue(feed.state);
  async function markRead() {
    if (f === undefined || f.notifications.length === 0) return;
    setProblem(undefined);
    const r = await client.markNotificationsRead(props.workspaceId, Math.max(...f.notifications.map((n) => n.seq)));
    if (!r.ok) return setProblem(r.problem);
    feed.reload();
    props.onChanged?.();
  }
  return (
    <section className="ib-notes" aria-labelledby="ib-notes-h">
      <div className="row between">
        <h2 id="ib-notes-h" className="ib-sub">
          Notifications{f !== undefined && f.unread > 0 ? <span className="muted small"> · {f.unread} new</span> : null}
        </h2>
        {f !== undefined && f.unread > 0 ? (
          <Button variant="quiet" onClick={() => void markRead()}>
            Mark all read
          </Button>
        ) : null}
      </div>
      {feed.state.phase === 'loading' ? <Skeleton label="Loading notifications" rows={2} /> : null}
      {feed.state.phase === 'error' ? <ProblemNotice problem={feed.state.problem} onRetry={feed.reload} /> : null}
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
      {f !== undefined && f.notifications.length === 0 ? <p className="muted small">No notifications.</p> : null}
      {f !== undefined && f.notifications.length > 0 ? (
        <ul className="bare-list small" aria-label="Notifications">
          {f.notifications.slice(0, 8).map((n) => (
            <li key={n.seq} className={n.read ? 'muted' : undefined}>
              <span>{KIND_TEXT[n.kind]}</span>
              {n.targetLabel !== undefined ? <span className="mono"> · {n.targetLabel}</span> : null}
              <span className="muted"> · {formatWhen(n.at)}</span>
              {n.read ? null : <Badge tone="accent">New</Badge>}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="muted small">
        Shown here only. XO does not send email or push notifications. What appears is set in Settings → Notifications.
      </p>
    </section>
  );
}

/**
 * The "ask for more information" thread on one waiting item. Asking never decides, rejects or changes the item: it only
 * records a question for someone to answer. The platform shows the thread to every member; asking needs review access
 * and answering needs author access. Studio disables a control with the reason, and the platform still decides.
 */
export function InfoThread(props: {
  workspaceId: string;
  executionId: string;
  role: WorkspaceRole | undefined;
  resolved?: boolean;
  onChanged?: () => void;
}) {
  const { client } = useSession();
  const detail = useLoad(() => client.getInboxItem(props.workspaceId, props.executionId), [client, props.workspaceId, props.executionId]);
  const [question, setQuestion] = useState('');
  const [answers, setAnswers] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const canAsk = can(props.role, 'review') && props.resolved !== true;
  const canAnswer = can(props.role, 'author');

  // Not every waiting item is a platform human task; if the platform has no such task there is no thread to show.
  if (detail.state.phase === 'error' && detail.state.problem.kind === 'not_found') return null;
  const d = loadedValue(detail.state);

  async function run(action: () => Promise<{ ok: boolean; problem?: ApiProblem }>) {
    setBusy(true);
    setProblem(undefined);
    const r = await action();
    setBusy(false);
    if (!r.ok && r.problem !== undefined) return setProblem(r.problem);
    detail.reload();
    props.onChanged?.();
    return r.ok;
  }

  return (
    <section className="ib-card" aria-labelledby={`thread-${props.executionId}`}>
      <h3 id={`thread-${props.executionId}`}>Questions about this</h3>
      {detail.state.phase === 'loading' ? <Skeleton label="Loading questions" rows={2} /> : null}
      {detail.state.phase === 'error' ? <ProblemNotice problem={detail.state.problem} onRetry={detail.reload} /> : null}
      {d !== undefined && d.infoRequests.length === 0 ? <p className="muted small">No questions yet.</p> : null}
      {d !== undefined && d.infoRequests.length > 0 ? (
        <ul className="bare-list" aria-label="Questions">
          {d.infoRequests.map((r) => (
            <li key={r.requestId} className="ib-q">
              <p>
                <strong>{r.requestedBy}</strong> asked <span className="muted small">{formatWhen(r.requestedAt)}</span>
              </p>
              <p>{r.question}</p>
              {r.answer !== undefined ? (
                <p className="recorded-note">
                  <strong>{r.answeredBy ?? 'Someone'}</strong> answered{r.answeredAt !== undefined ? ` ${formatWhen(r.answeredAt)}` : ''}:{' '}
                  {r.answer}
                </p>
              ) : props.resolved === true ? (
                <p className="muted small">Not answered.</p>
              ) : (
                <form
                  className="field-row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const text = (answers[r.requestId] ?? '').trim();
                    if (text !== '') void run(() => client.answerInfoRequest(props.workspaceId, props.executionId, r.requestId, text));
                  }}
                >
                  <label className="field">
                    Answer
                    <input
                      value={answers[r.requestId] ?? ''}
                      onChange={(e) => setAnswers({ ...answers, [r.requestId]: e.target.value })}
                      disabled={busy || !canAnswer}
                      title={canAnswer ? undefined : whyNot(props.role, 'author', 'answering questions')}
                      autoComplete="off"
                    />
                  </label>
                  <Button
                    type="submit"
                    variant="secondary"
                    disabled={busy || !canAnswer || (answers[r.requestId] ?? '').trim() === ''}
                    title={canAnswer ? undefined : whyNot(props.role, 'author', 'answering questions')}
                  >
                    Send answer
                  </Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {props.resolved === true ? (
        <p className="muted small">This was decided, so no more questions can be asked.</p>
      ) : (
        <form
          className="field-row"
          onSubmit={(e) => {
            e.preventDefault();
            const text = question.trim();
            if (text !== '')
              void run(() => client.requestMoreInfo(props.workspaceId, props.executionId, text)).then((ok) => ok && setQuestion(''));
          }}
        >
          <label className="field">
            Ask for more information
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={busy || !canAsk}
              maxLength={2000}
              autoComplete="off"
              title={canAsk ? undefined : whyNot(props.role, 'review', 'asking questions')}
            />
          </label>
          <Button
            type="submit"
            variant="secondary"
            disabled={busy || !canAsk || question.trim() === ''}
            title={canAsk ? undefined : whyNot(props.role, 'review', 'asking questions')}
          >
            Ask
          </Button>
        </form>
      )}
      <p className="muted small">
        Asking does not decide or change anything. The item stays waiting until a person approves or rejects it.
      </p>
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
    </section>
  );
}

export function DoneList(props: { items: readonly InboxItem[]; picked: string | undefined; onPick: (id: string) => void }) {
  if (props.items.length === 0) return <p className="muted small">Nothing has been decided yet.</p>;
  return (
    <ul className="ib-rows" aria-label="Decided">
      {props.items.map((i) => (
        <li key={i.executionId}>
          <button
            type="button"
            className="ib-row"
            aria-current={props.picked === i.executionId ? 'true' : undefined}
            onClick={() => props.onPick(i.executionId)}
          >
            <span className="ib-row-title">{i.title}</span>
            <span className="ib-row-sub">
              {i.decision === 'approve' ? 'Approved' : i.decision === 'reject' ? 'Rejected' : 'Decided'}
              {i.resolvedAt !== undefined ? ` · ${formatWhen(i.resolvedAt)}` : ''}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
