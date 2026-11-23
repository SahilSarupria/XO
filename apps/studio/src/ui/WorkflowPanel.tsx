import { useEffect, useRef } from 'react';
import { useQuery, wsKey } from '../platform/query';
import { describeRun, runtimeRunBucket, runtimeRunWords, tidyName } from '../domain/work';
import type { WorkflowSummary } from '../domain/workflowSummary';
import type { Capability, WorkflowRun, WorkspaceRole } from '../platform/wire';
import { ActionNoticeView } from './actions';
import { Icon } from './icons';
import { Button, formatWhen, loadedValue } from './primitives';
import { useSession } from './session';
import { useStartWorkflow } from './useStartWorkflow';
import { ItemSourcePicker } from './ItemSourcePicker';
import { ReadinessCertificatePanel } from './ReadinessCertificatePanel';
import { WorkflowModeControls } from './WorkflowModeControls';

/**
 * The details of one workflow, in a panel beside the list. It holds everything needed to act on it: what is still
 * needed before it can start, how it works, its recent runs, and the Start button with the same guards as before
 * (the platform is asked for an existing active run first, and approvals are re-checked server-side).
 */
export function WorkflowPanel(props: {
  workspaceId: string;
  s: WorkflowSummary;
  caps: readonly Capability[] | undefined;
  capsFailed: boolean;
  runs: readonly WorkflowRun[];
  role?: WorkspaceRole | undefined;
  allPaused?: boolean;
  onClose: () => void;
  onChanged: () => void;
  goToSetup: () => void;
  goToTasks: () => void;
  goToActivity: () => void;
  onOpenGraph: (workflowId: string) => void;
}) {
  const { mode, client } = useSession();
  const { s } = props;
  const w = s.workflow;
  // S1-0 (F2): this workflow's runs on the workflow runtime, read from the platform and re-read after every start, so a start
  // shows its run at once. Matched by the compiled workflow its definition was generated from.
  const runtime = useQuery(wsKey(props.workspaceId, 'runtime-runs?limit=200'), () =>
    client.listWorkspaceRuns(props.workspaceId, { limit: 200 }),
  );
  const mine = (loadedValue(runtime.state)?.runs ?? []).filter(
    (r) => r.compilationId === w.compilationId && r.candidateWorkflowId === w.workflowId,
  );
  const latest = mine[0];
  const latestActive =
    latest !== undefined && (runtimeRunBucket(latest) === 'running' || runtimeRunBucket(latest) === 'attention') ? latest : undefined;
  const onChanged = props.onChanged;
  const reloadRuntime = runtime.reload;
  const { start, busy, notice, ready, active, choices, chooseSource, cancelChoice } = useStartWorkflow({
    ...props,
    onChanged: () => {
      reloadRuntime();
      onChanged();
    },
    workflow: w,
    goToActivity: props.goToActivity,
  });
  const root = useRef<HTMLElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const runView = active === undefined ? undefined : describeRun(active);
  const person = s.split?.person;
  const recent = props.runs
    .filter((r) => r.workflowId === w.workflowId && r.compilationId === w.compilationId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 3);

  useEffect(() => {
    closeBtn.current?.focus();
  }, []);

  // Escape closes the panel from anywhere while it is open: clicking a non-interactive spot inside it moves keyboard focus to the page body.
  const onClose = props.onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Leave Escape to an open menu or field that handles it itself.
      const t = e.target as HTMLElement | null;
      if (t?.closest('[role="menu"], [role="alertdialog"]') != null) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Keep keyboard focus inside the panel while it is open; Escape closes it.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || root.current === null) return;
    const items = Array.from(
      root.current.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])'),
    ).filter((el) => !el.hasAttribute('disabled') && focusable(el));
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // The platform refuses a start while everything or this workflow is paused, or today's limit is used; say so up front.
  const ctl = s.control;
  const blocked =
    props.allPaused === true
      ? 'Everything is paused for this workspace. Resume it on the Workflows page.'
      : ctl?.mode === 'paused'
        ? 'This workflow is paused. Resume it above first.'
        : ctl?.limits.dailyRunCap !== undefined && ctl.limits.runsToday >= ctl.limits.dailyRunCap
          ? `It has reached its limit of ${ctl.limits.dailyRunCap} ${ctl.limits.dailyRunCap === 1 ? 'run' : 'runs'} today.`
          : undefined;
  const rulesDone = props.caps !== undefined && ready.needApproval.length === 0;
  const checks = [
    { done: rulesDone, key: 'rules' },
    { done: w.executable, key: 'run' },
  ];
  if (person !== undefined && person > 0) checks.push({ done: true, key: 'person' });
  const doneCount = checks.filter((c) => c.done).length;

  const now =
    latestActive !== undefined
      ? `${runtimeRunWords(latestActive)}, started ${formatWhen(latestActive.startedAt)}.`
      : active !== undefined && runView !== undefined
        ? runView.summary
        : runtime.state.phase === 'loading'
          ? 'Checking for runs…'
          : ready.canStart
            ? 'Nothing is running. Start it when you are ready.'
            : 'Not started. What is still needed is listed below.';

  return (
    <div className="wp-layer">
      <div className="wp-scrim" onClick={props.onClose} aria-hidden="true" />
      <aside ref={root} className="wp" role="dialog" aria-modal="true" aria-labelledby="wp-title" tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="wp-body">
          <div className="wp-top">
            <div>
              <h2 id="wp-title">{s.title}</h2>
              <p className="wp-lead">{s.sub}</p>
            </div>
            <button ref={closeBtn} type="button" className="wp-x" aria-label="Close details" onClick={props.onClose}>
              <Icon name="x" size={20} />
            </button>
          </div>

          <div className="wp-now">
            <b>Right now.</b> {now}
          </div>

          <div className="wp-head">
            <h3>Before you can start</h3>
            <span>
              {doneCount} of {checks.length} done
            </span>
          </div>
          <ul className="wp-checks">
            <li data-state={rulesDone ? 'ok' : props.caps === undefined ? 'half' : 'todo'}>
              <span className="wp-mark" aria-hidden="true">
                {rulesDone ? '✓' : props.caps === undefined ? '…' : '!'}
              </span>
              <div>
                {rulesDone ? (
                  'Every rule is approved'
                ) : props.caps === undefined ? (
                  props.capsFailed ? (
                    'XO could not check approvals just now'
                  ) : (
                    'Checking approvals…'
                  )
                ) : (
                  <>
                    {ready.needApproval.length} of {w.stepCount} {w.stepCount === 1 ? 'rule' : 'rules'} still need your approval
                    <ul className="wp-needs">
                      {ready.needApproval.map((n) => (
                        <li key={n}>Needs approval: {n}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
              {!rulesDone && props.caps !== undefined ? (
                <Button variant="secondary" onClick={props.goToSetup}>
                  Review rules in Sources
                </Button>
              ) : null}
            </li>
            <li data-state={w.executable ? 'ok' : 'todo'}>
              <span className="wp-mark" aria-hidden="true">
                {w.executable ? '✓' : '!'}
              </span>
              <div>
                {w.executable ? 'XO can carry this out' : 'The platform cannot run this yet'}
                {w.gapCount > 0 ? (
                  <small>
                    XO flagged {w.gapCount} {w.gapCount === 1 ? 'uncertainty' : 'uncertainties'} about the order.
                  </small>
                ) : null}
              </div>
            </li>
            {person !== undefined && person > 0 ? (
              <li data-state="ok">
                <span className="wp-mark" aria-hidden="true">
                  ✓
                </span>
                <div>
                  A person decides {person} {person === 1 ? 'step' : 'steps'}, on purpose
                  <small>XO stops and waits for them. It never decides these itself.</small>
                </div>
              </li>
            ) : null}
          </ul>

          <WorkflowModeControls
            workspaceId={props.workspaceId}
            s={s}
            role={props.role}
            allPaused={props.allPaused === true}
            onChanged={props.onChanged}
          />

          <ReadinessCertificatePanel
            workspaceId={props.workspaceId}
            compilationId={w.compilationId}
            workflowId={w.workflowId}
            workflowName={s.title}
            role={props.role}
          />

          <details className="wp-how">
            <summary>See how it works</summary>
            <ol className="flow" aria-label="Steps in this process">
              {w.steps.map((st, i) => {
                const isPerson = props.caps?.find((c) => c.capabilityId === st.capabilityId)?.executionClass === 'human_in_the_loop';
                return (
                  <li key={st.capabilityId} className="flow-step" data-who={isPerson ? 'person' : 'xo'}>
                    <span className="flow-dot" aria-hidden="true">
                      {i + 1}
                    </span>
                    <div className="flow-body">
                      <span className="step-name">{tidyName(st.name)}</span>
                      {props.caps !== undefined ? (
                        <span className="flow-who">{isPerson ? 'A person decides here' : 'XO carries this out'}</span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
            <details>
              <summary>What each step is based on</summary>
              <ul className="plain">
                {w.steps.map((st) => (
                  <li key={st.capabilityId} className="small muted">
                    <strong>{tidyName(st.name, 60)}</strong>
                    {st.description.length > 0 ? ` — ${st.description}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          </details>

          <div className="wp-head">
            <h3>Recent runs</h3>
            <button type="button" className="chat-link" onClick={props.goToActivity}>
              View all in Activity
            </button>
          </div>
          {recent.length === 0 && mine.length === 0 ? (
            <p className="muted">{runtime.state.phase === 'loading' ? 'Checking for runs…' : 'It has not been run yet.'}</p>
          ) : (
            <ul className="wp-runs">
              {mine.slice(0, 3).map((r) => {
                const b = runtimeRunBucket(r);
                return (
                  <li key={r.runId}>
                    <span
                      className="wp-run-dot"
                      data-tone={b === 'attention' ? 'warning' : b === 'failed' ? 'danger' : b === 'finished' ? 'success' : 'neutral'}
                      aria-hidden="true"
                    />
                    {runtimeRunWords(r)}
                    <small>{formatWhen(r.startedAt)}</small>
                  </li>
                );
              })}
              {recent.slice(0, Math.max(0, 3 - mine.length)).map((r) => {
                const v = describeRun(r);
                return (
                  <li key={r.workflowExecutionId}>
                    <span className="wp-run-dot" data-tone={v.tone} aria-hidden="true" />
                    {v.label}
                    <small>{formatWhen(r.createdAt)}</small>
                  </li>
                );
              })}
            </ul>
          )}

          {mode === 'builder' ? (
            <details>
              <summary>Technical details</summary>
              <p className="mono small">
                {w.workflowId} · {w.status} · confidence {Math.round(w.confidence * 100)}%
              </p>
              {w.description.length > 0 ? <p className="small muted">{w.description}</p> : null}
              {w.notExecutableReasons.length > 0 ? (
                <ul className="plain">
                  {w.notExecutableReasons.slice(0, 20).map((r, i) => (
                    <li key={i} className="mono small">
                      {r}
                    </li>
                  ))}
                </ul>
              ) : null}
            </details>
          ) : null}

          <ActionNoticeView
            notice={notice}
            action={
              notice !== undefined && 'view' in notice && notice.view.kind === 'needs_approval' ? (
                <Button variant="secondary" onClick={props.goToSetup}>
                  Review rules in Sources
                </Button>
              ) : undefined
            }
          />
          <ItemSourcePicker sources={choices} onChoose={chooseSource} onCancel={cancelChoice} disabled={busy} />
        </div>

        <div className="wp-bar">
          <div className="wp-actions">
            <Button variant="secondary" onClick={() => props.onOpenGraph(w.workflowId)} aria-label={`View graph of ${s.title}`}>
              View graph
            </Button>
            <span className="wp-grow" />
            {latestActive !== undefined ? (
              // Disabled while a start settles, so the second click of a double click does not land on this button and navigate away.
              <Button variant="primary" disabled={busy} onClick={latestActive.pendingApprovals > 0 ? props.goToTasks : props.goToActivity}>
                {latestActive.pendingApprovals > 0 ? 'Decide in the Inbox' : 'See progress'}
              </Button>
            ) : active !== undefined && runView !== undefined ? (
              <Button
                variant="primary"
                onClick={active.status === 'waiting_for_human' || active.status === 'interrupted' ? props.goToTasks : props.goToActivity}
              >
                {active.status === 'waiting_for_human' || active.status === 'interrupted' ? 'Continue in Tasks' : 'See progress'}
              </Button>
            ) : (
              <Button
                variant="primary"
                className="btn-lg"
                disabled={busy || !ready.canStart || blocked !== undefined}
                onClick={start}
                aria-describedby={`why-${w.workflowId}`}
              >
                {busy ? 'Starting…' : 'Start this workflow'}
              </Button>
            )}
          </div>
          {latestActive === undefined && active === undefined && ready.canStart && blocked !== undefined ? (
            <p id={`why-${w.workflowId}`} className="wp-hint">
              {blocked}
            </p>
          ) : null}
          {latestActive === undefined && active === undefined && !ready.canStart && ready.reason !== undefined ? (
            <p id={`why-${w.workflowId}`} className="wp-hint">
              {props.capsFailed && props.caps === undefined
                ? 'XO could not check approvals just now, so this cannot be started. Use Try again above.'
                : ready.reason}
            </p>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

/** Not disabled, and not tucked inside a collapsed <details> (whose own <summary> is still reachable). */
function focusable(el: HTMLElement): boolean {
  for (let n: HTMLElement | null = el.parentElement; n !== null; n = n.parentElement) {
    if (n.tagName === 'DETAILS' && !(n as HTMLDetailsElement).open && !(el.tagName === 'SUMMARY' && el.parentElement === n)) return false;
  }
  return true;
}
