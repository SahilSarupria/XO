import { useState } from 'react';
import { can, whyNot } from '../domain/access';
import { describeEvery, modeLabel, type WorkflowSummary } from '../domain/workflowSummary';
import type { ApiProblem, Result } from '../platform/client';
import type { WorkflowControl, WorkflowMode, WorkspaceRole } from '../platform/wire';
import { useGuardedAction } from './actions';
import { Button, formatWhen, ProblemNotice } from './primitives';
import { useSession } from './session';

const MAX_SCHEDULE_INPUT = 8 * 1024;

/**
 * Where a workflow is in its life (draft, shadow, live, paused), and the controls around it: sign-off, the daily limit,
 * how it can start, and how its practice runs went. Every button asks the platform and shows what the platform says;
 * nothing here decides whether a change is allowed. A control the role cannot use is disabled with the reason.
 */
export function WorkflowModeControls(props: {
  workspaceId: string;
  s: WorkflowSummary;
  role: WorkspaceRole | undefined;
  allPaused: boolean;
  onChanged: () => void;
}) {
  const c = props.s.control;
  const { client } = useSession();
  const { run, busy } = useGuardedAction();
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [confirmLive, setConfirmLive] = useState(false);
  if (c === undefined) return null;
  const ids = { workflowId: c.workflowId, compilationId: c.compilationId };
  const author = can(props.role, 'author');
  const publish = can(props.role, 'publish');
  const review = can(props.role, 'review');
  const item = (id: string) => c.readiness.find((r) => r.id === id);
  const rulesOk = item('rules')?.ok === true && item('runnable')?.ok === true;

  /** Ask the platform; on success refresh everything, on refusal show its words. */
  const act = (call: () => Promise<Result<unknown>>) =>
    void run(async () => {
      setProblem(undefined);
      const r = await call();
      if (!r.ok) setProblem(r.problem);
      else props.onChanged();
    });
  const setMode = (mode: WorkflowMode) => act(() => client.setWorkflowMode(props.workspaceId, ids.workflowId, ids.compilationId, mode));

  const practiceReason = !author
    ? whyNot(props.role, 'author', 'changing this workflow')
    : !rulesOk
      ? 'Approve every rule first, and make sure the platform can run it.'
      : undefined;
  const liveReason = !publish
    ? whyNot(props.role, 'publish', 'taking a workflow live')
    : !c.canGoLive
      ? c.readiness
          .filter((r) => !r.ok)
          .map((r) => r.message)
          .join('. ') + '.'
      : undefined;

  return (
    <section className="wm" aria-label="Workflow controls">
      <div className="wp-head">
        <h3>Where it is</h3>
        <span data-mode={c.mode}>{modeLabel(c.mode)}</span>
      </div>
      <ol className="wm-rail" aria-label="Life of a workflow">
        {(['draft', 'shadow', 'live'] as const).map((m, i) => (
          <li
            key={m}
            data-state={c.mode === m ? 'now' : order(c.mode) > i ? 'done' : 'next'}
            aria-current={c.mode === m ? 'step' : undefined}
          >
            {modeLabel(m)}
          </li>
        ))}
      </ol>
      <p className="wm-explain">{explain(c.mode, props.allPaused)}</p>

      {confirmLive ? (
        <div className="wm-confirm" role="alertdialog" aria-labelledby="wm-live-h" aria-describedby="wm-live-d">
          <strong id="wm-live-h">Go live?</strong>
          <p id="wm-live-d">
            From now on its runs are real: they ask real people to decide, and a webhook or schedule can start them without anyone pressing
            Start. You can pause it at any time.
          </p>
          <div className="wm-row">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                setConfirmLive(false);
                setMode('live');
              }}
            >
              Go live
            </Button>
            <Button variant="quiet" onClick={() => setConfirmLive(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="wm-row">
          {c.mode === 'draft' || c.mode === 'paused' ? (
            <Button
              variant="primary"
              disabled={busy || practiceReason !== undefined}
              onClick={() => setMode('shadow')}
              aria-describedby={practiceReason !== undefined ? 'wm-why' : undefined}
            >
              {c.mode === 'paused' ? 'Resume practising' : 'Start practising'}
            </Button>
          ) : null}
          {c.mode === 'shadow' || c.mode === 'paused' ? (
            <Button
              variant={c.mode === 'shadow' ? 'primary' : 'secondary'}
              disabled={busy || liveReason !== undefined}
              onClick={() => setConfirmLive(true)}
              aria-describedby={liveReason !== undefined ? 'wm-why' : undefined}
            >
              Go live…
            </Button>
          ) : null}
          {c.mode === 'live' ? (
            <Button variant="secondary" disabled={busy || !author} onClick={() => setMode('shadow')}>
              Back to practising
            </Button>
          ) : null}
          {c.mode !== 'draft' ? (
            <Button variant="quiet" disabled={busy || !author} onClick={() => setMode('draft')}>
              Back to draft
            </Button>
          ) : null}
          {c.mode !== 'paused' ? (
            <Button variant="quiet" disabled={busy || !author} onClick={() => setMode('paused')}>
              Pause
            </Button>
          ) : null}
        </div>
      )}
      {c.mode === 'draft' || c.mode === 'paused' ? (
        practiceReason !== undefined ? (
          <p id="wm-why" className="wm-why">
            {practiceReason}
          </p>
        ) : null
      ) : c.mode === 'shadow' && liveReason !== undefined ? (
        <p id="wm-why" className="wm-why">
          Not ready to go live: {liveReason}
        </p>
      ) : null}
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}

      <h4 className="wm-h">Before it can go live</h4>
      <ul className="wp-checks">
        <SignOffItem
          c={c}
          review={review}
          role={props.role}
          rulesOk={rulesOk}
          busy={busy}
          act={act}
          client={client}
          workspaceId={props.workspaceId}
        />
        <LimitItem
          c={c}
          author={author}
          role={props.role}
          busy={busy}
          act={act}
          client={client}
          workspaceId={props.workspaceId}
          setProblem={setProblem}
        />
        <li data-state={item('practice')?.ok === true ? 'ok' : 'todo'}>
          <span className="wp-mark" aria-hidden="true">
            {item('practice')?.ok === true ? '✓' : '!'}
          </span>
          <div>{item('practice')?.message ?? 'Practice has not run'}</div>
        </li>
      </ul>

      <TriggerControls
        c={c}
        author={author}
        role={props.role}
        busy={busy}
        act={act}
        client={client}
        workspaceId={props.workspaceId}
        allPaused={props.allPaused}
      />
      <PracticeResults c={c} review={review} role={props.role} busy={busy} act={act} client={client} workspaceId={props.workspaceId} />
    </section>
  );
}

const order = (m: WorkflowMode): number => (m === 'draft' ? 0 : m === 'shadow' ? 1 : m === 'live' ? 2 : -1);
function explain(mode: WorkflowMode, allPaused: boolean): string {
  if (allPaused) return 'Everything in this workspace is paused, so nothing can start until it is resumed.';
  switch (mode) {
    case 'draft':
      return 'Only a person starts it, from this page. Webhooks and schedules wait until it is practising or live.';
    case 'shadow':
      return 'Practising: it carries out the steps XO can and stops before any step that needs a person. Nobody is asked, and nothing is created for anyone to do.';
    case 'live':
      return 'Live: its runs are real, and a webhook or schedule can start them.';
    case 'paused':
      return 'Paused: nothing can start it, by hand or by a webhook or schedule.';
  }
}

interface Shared {
  c: WorkflowControl;
  role: WorkspaceRole | undefined;
  busy: boolean;
  act: (call: () => Promise<Result<unknown>>) => void;
  client: ReturnType<typeof useSession>['client'];
  workspaceId: string;
}

function SignOffItem(props: Shared & { review: boolean; rulesOk: boolean }) {
  const { c } = props;
  const ok = c.signOff?.current === true;
  const reason = !props.review
    ? whyNot(props.role, 'review', 'signing off a workflow')
    : !props.rulesOk
      ? 'Approve every rule first.'
      : undefined;
  return (
    <li data-state={ok ? 'ok' : 'todo'}>
      <span className="wp-mark" aria-hidden="true">
        {ok ? '✓' : '!'}
      </span>
      <div>
        {ok
          ? `Signed off by ${c.signOff?.displayName ?? c.signOff?.identityId ?? 'a reviewer'}`
          : c.signOff !== undefined
            ? 'It changed since it was signed off'
            : 'Nobody has signed this version off yet'}
        {ok && c.signOff !== undefined ? (
          <small>{formatWhen(c.signOff.at)}. A recorded sign-off, not a cryptographic signature.</small>
        ) : null}
        {!ok && reason !== undefined ? <small>{reason}</small> : null}
      </div>
      {!ok ? (
        <Button
          variant="secondary"
          disabled={props.busy || reason !== undefined}
          onClick={() => props.act(() => props.client.signOffWorkflow(props.workspaceId, c.workflowId, c.compilationId))}
        >
          Sign off this version
        </Button>
      ) : null}
    </li>
  );
}

function LimitItem(props: Shared & { author: boolean; setProblem: (p: ApiProblem | undefined) => void }) {
  const { c } = props;
  const [text, setText] = useState(c.limits.dailyRunCap !== undefined ? String(c.limits.dailyRunCap) : '');
  const [error, setError] = useState<string | undefined>();
  const cap = c.limits.dailyRunCap;
  const save = () => {
    const n = Number(text);
    if (!Number.isInteger(n) || n < 1 || n > 100000) {
      setError('Enter a whole number from 1 to 100000.');
      return;
    }
    setError(undefined);
    props.act(() => props.client.setWorkflowLimit(props.workspaceId, c.workflowId, c.compilationId, n));
  };
  return (
    <li data-state={cap !== undefined ? 'ok' : 'todo'}>
      <span className="wp-mark" aria-hidden="true">
        {cap !== undefined ? '✓' : '!'}
      </span>
      <div>
        {cap !== undefined ? `At most ${cap} ${cap === 1 ? 'run' : 'runs'} a day` : 'No daily limit is set'}
        <small>
          {c.limits.runsToday} {c.limits.runsToday === 1 ? 'run' : 'runs'} started today (UTC), practice runs included. A start over the
          limit is refused.
        </small>
        <div className="wm-inline">
          <label>
            <span className="visually-hidden">Daily limit</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={100000}
              value={text}
              placeholder="e.g. 50"
              disabled={!props.author || props.busy}
              onChange={(e) => setText(e.target.value)}
              aria-invalid={error !== undefined}
              aria-label="Daily limit"
            />
          </label>
          <Button variant="secondary" disabled={!props.author || props.busy || text.trim() === ''} onClick={save}>
            Save limit
          </Button>
          {cap !== undefined ? (
            <Button
              variant="quiet"
              disabled={!props.author || props.busy}
              onClick={() => {
                setText('');
                props.act(() => props.client.setWorkflowLimit(props.workspaceId, c.workflowId, c.compilationId, null));
              }}
            >
              Remove limit
            </Button>
          ) : null}
        </div>
        {error !== undefined ? (
          <small role="alert" className="wm-error">
            {error}
          </small>
        ) : null}
        {!props.author ? <small>{whyNot(props.role, 'author', 'changing limits')}</small> : null}
      </div>
    </li>
  );
}

function TriggerControls(props: Shared & { author: boolean; allPaused: boolean }) {
  const { c } = props;
  const sched = c.triggers.schedule;
  const [every, setEvery] = useState(sched !== undefined ? String(sched.everyMinutes) : '60');
  const [inputText, setInputText] = useState(sched?.input !== undefined ? JSON.stringify(sched.input, null, 2) : '');
  const [error, setError] = useState<string | undefined>();
  const firing = (c.mode === 'shadow' || c.mode === 'live') && !props.allPaused;
  const changeTriggers = (change: Parameters<typeof props.client.setWorkflowTriggers>[3]) =>
    props.act(() => props.client.setWorkflowTriggers(props.workspaceId, c.workflowId, c.compilationId, change));
  const saveSchedule = () => {
    const n = Number(every);
    if (!Number.isInteger(n) || n < 5 || n > 10080) return setError('Enter a whole number of minutes from 5 to 10080 (one week).');
    let input: Record<string, unknown> | undefined;
    if (inputText.trim() !== '') {
      if (inputText.length > MAX_SCHEDULE_INPUT) return setError('The input is too long (8 KB at most).');
      try {
        const parsed: unknown = JSON.parse(inputText);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
          return setError('The input must be a JSON object, like {"claim_amount": 100}.');
        input = parsed as Record<string, unknown>;
      } catch {
        return setError('The input is not valid JSON.');
      }
    }
    setError(undefined);
    changeTriggers({ schedule: { everyMinutes: n, ...(input !== undefined ? { input } : {}) } });
  };
  const url = `/workspaces/${props.workspaceId}/workflows/${c.workflowId}/webhook`;
  return (
    <details className="wm-section" open={c.triggers.webhook || sched !== undefined}>
      <summary>How it starts</summary>
      <p className="wm-note">
        {firing
          ? 'Switched-on triggers are firing now.'
          : 'Triggers you switch on wait until the workflow is practising or live (and nothing is paused).'}
      </p>
      <ul className="wm-triggers">
        <li>Someone starts it from this page. Always available.</li>
        <li>
          <label className="wm-check">
            <input
              type="checkbox"
              checked={c.triggers.webhook}
              disabled={!props.author || props.busy}
              onChange={(e) => changeTriggers({ webhook: e.target.checked })}
            />
            Start it from a webhook
          </label>
          {c.triggers.webhook ? (
            <small>
              Another system starts it with <code>POST {url}</code>, a JSON body{' '}
              <code>{`{"compilationId": "${c.compilationId}", "input": { … }}`}</code> and an API key of a workspace member who may author.
              There is no separate secret.
            </small>
          ) : null}
        </li>
        <li>
          <label className="wm-check">
            <input
              type="checkbox"
              checked={sched !== undefined}
              disabled={!props.author || props.busy}
              onChange={(e) => (e.target.checked ? saveSchedule() : changeTriggers({ schedule: null }))}
            />
            Start it on a schedule{sched !== undefined ? `: ${describeEvery(sched.everyMinutes).toLowerCase()}` : ''}
          </label>
          <div className="wm-inline">
            <label>
              <span className="wm-lab">Every (minutes)</span>
              <input
                type="number"
                min={5}
                max={10080}
                value={every}
                disabled={!props.author || props.busy}
                onChange={(e) => setEvery(e.target.value)}
                aria-label="Minutes between scheduled runs"
              />
            </label>
            <label className="wm-grow">
              <span className="wm-lab">Input for each run (JSON, optional)</span>
              <textarea
                rows={3}
                value={inputText}
                disabled={!props.author || props.busy}
                onChange={(e) => setInputText(e.target.value)}
                aria-label="Input for each scheduled run"
                spellCheck={false}
              />
            </label>
            <Button variant="secondary" disabled={!props.author || props.busy} onClick={saveSchedule}>
              {sched !== undefined ? 'Update schedule' : 'Turn on schedule'}
            </Button>
          </div>
          {error !== undefined ? (
            <small role="alert" className="wm-error">
              {error}
            </small>
          ) : null}
          <small>
            It runs while the XO server is running, once per interval, and does not catch up after downtime.
            {sched?.lastOutcome !== undefined ? ` Last slot: ${sched.lastOutcome}.` : ''}
          </small>
        </li>
      </ul>
      {!props.author ? <p className="wm-note">{whyNot(props.role, 'author', 'changing triggers')}</p> : null}
    </details>
  );
}

function PracticeResults(props: Shared & { review: boolean }) {
  const { c } = props;
  const s = c.shadow;
  return (
    <details className="wm-section" open={c.mode === 'shadow'}>
      <summary>Practice results</summary>
      {s.runs === 0 ? (
        <p className="wm-note">No practice runs yet. Start practising, then start the workflow once.</p>
      ) : (
        <>
          <p className="wm-note">
            {s.runs} practice {s.runs === 1 ? 'run' : 'runs'}: {s.wouldComplete} could be done without a person, {s.wouldEscalate} stopped
            at a step that needs one.
            {s.reviewed > 0
              ? ` You judged ${s.reviewed}, and agreed with what XO did on ${s.agreed} of them. That is agreement on whether a person was needed, for the cases you chose to judge; it is not a measure of accuracy.`
              : ' Judge a few below to see how often you agree.'}
          </p>
          <ul className="wm-cases">
            {c.shadowCases.map((k) => (
              <li key={k.workflowExecutionId}>
                <div>
                  {k.outcome === 'would_complete'
                    ? 'Would finish on its own'
                    : `Would stop at: ${k.stepName ?? 'a step that needs a person'}`}
                  <small>{formatWhen(k.createdAt)}</small>
                </div>
                <div className="wm-judge" role="group" aria-label={`Your judgement of the run from ${formatWhen(k.createdAt)}`}>
                  <button
                    type="button"
                    aria-pressed={k.judgement === 'automatic'}
                    disabled={!props.review || props.busy}
                    onClick={() =>
                      props.act(() =>
                        props.client.reviewPracticeRun(
                          props.workspaceId,
                          c.workflowId,
                          c.compilationId,
                          k.workflowExecutionId,
                          'automatic',
                        ),
                      )
                    }
                  >
                    No person needed
                  </button>
                  <button
                    type="button"
                    aria-pressed={k.judgement === 'person'}
                    disabled={!props.review || props.busy}
                    onClick={() =>
                      props.act(() =>
                        props.client.reviewPracticeRun(props.workspaceId, c.workflowId, c.compilationId, k.workflowExecutionId, 'person'),
                      )
                    }
                  >
                    A person would handle it
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {!props.review ? <p className="wm-note">{whyNot(props.role, 'review', 'judging practice runs')}</p> : null}
        </>
      )}
    </details>
  );
}
