import { useMemo, useState } from 'react';
import { formatOutput, layoutGraph, NODE_H, NODE_W } from '../domain/graph';
import { formatMs, runRow, runsOf, shortRunId, stepRecord } from '../domain/executions';
import { replayFrame } from '../domain/replay';
import { tidyName } from '../domain/work';
import type { Capability, Execution, Workflow, WorkflowRun } from '../platform/wire';
import { EmptyState, formatWhen } from './primitives';
import { REPLAY_STATE_LABEL, ReplayControls } from './RunReplay';
import { useSession } from './session';

type Drawer = 'output' | 'input' | 'trace';

/**
 * Two panes: the runs of one process, and the picture of the chosen run with what each step recorded. Built from the
 * platform's run and execution records only. It shows the order and outcome of each step; a duration appears only where
 * the platform recorded both a start and an end.
 */
export function ExecutionsPane(props: {
  workflow: Workflow;
  runs: readonly WorkflowRun[];
  executions: readonly Execution[];
  caps: readonly Capability[] | undefined;
  initialRunId?: string | undefined;
}) {
  const { mode } = useSession();
  const list = useMemo(() => runsOf(props.runs, props.workflow.workflowId, props.workflow.compilationId), [props.runs, props.workflow]);
  const [pickedRun, setPickedRun] = useState<string | undefined>(props.initialRunId);
  const run = list.find((r) => r.workflowExecutionId === pickedRun) ?? list[0];
  return (
    <div className="ex">
      <nav className="ex-runs" aria-label="Runs">
        <h2 className="chat-label">Runs</h2>
        {list.length === 0 ? <p className="muted small">This process has not been run yet.</p> : null}
        <ul className="bare-list">
          {list.map((r) => {
            const row = runRow(r);
            return (
              <li key={row.id}>
                <button
                  type="button"
                  className="ex-run"
                  aria-pressed={run?.workflowExecutionId === row.id}
                  onClick={() => setPickedRun(row.id)}
                >
                  <span className="ex-run-title">{row.title}</span>
                  <span className="ex-run-status" data-tone={row.tone}>
                    {row.status}
                    {row.duration !== undefined ? ` · ${row.duration}` : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      {run === undefined ? (
        <div className="ex-main">
          <EmptyState title="No runs to show">
            Start this process from the Editor. Each run will be listed here with what every step recorded.
          </EmptyState>
        </div>
      ) : (
        <RunView key={run.workflowExecutionId} run={run} executions={props.executions} caps={props.caps} builder={mode === 'builder'} />
      )}
    </div>
  );
}

function RunView(props: { run: WorkflowRun; executions: readonly Execution[]; caps: readonly Capability[] | undefined; builder: boolean }) {
  const { run } = props;
  const total = run.steps.length;
  const [position, setPosition] = useState(total); // a finished picture first; the scrubber steps back through it
  const [selectedStep, setSelectedStep] = useState<string | undefined>();
  const [drawer, setDrawer] = useState<Drawer>('output');
  const ordered = useMemo(() => [...run.steps].sort((a, b) => a.order - b.order), [run.steps]);
  const layout = useMemo(
    () =>
      layoutGraph(
        ordered.map((s) => ({ order: s.order, capabilityId: s.capabilityId, name: s.capabilityName, description: '' })),
        props.caps,
      ),
    [ordered, props.caps],
  );
  const frame = replayFrame(run, position);
  const stateOf = new Map(frame.nodes.map((n) => [n.stepId, n]));
  const focusStep =
    selectedStep ??
    ordered.find((s) => s.status === 'waiting_for_human' || s.status === 'failed' || s.status === 'rejected')?.stepId ??
    ordered[ordered.length - 1]?.stepId;
  const record = focusStep === undefined ? undefined : stepRecord(run, focusStep, props.executions);

  return (
    <div className="ex-main">
      <section className="ex-canvas" aria-label="Run graph">
        <div className="wf-scroll ex-scroll">
          <div className="wf-stage" style={{ width: layout.width, height: layout.height }}>
            <svg className="wf-edges" width={layout.width} height={layout.height} aria-hidden="true">
              {layout.edges.map((e, i) => (
                <path
                  key={e.id}
                  d={e.path}
                  data-taken={(stateOf.get(ordered[i]?.stepId ?? '')?.state ?? 'upcoming') === 'done' ? 'true' : 'false'}
                />
              ))}
            </svg>
            <ol className="wf-nodes" aria-label="Steps in the order they ran">
              {layout.nodes.map((n, i) => {
                const step = ordered[i]!;
                const f = stateOf.get(step.stepId);
                const state = f?.state ?? 'upcoming';
                const rec = stepRecord(run, step.stepId, props.executions);
                return (
                  <li key={n.id} style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H }}>
                    <button
                      type="button"
                      className="wf-node"
                      data-kind={n.kind}
                      data-state={state}
                      data-current={f?.current === true}
                      aria-pressed={focusStep === step.stepId}
                      onClick={() => setSelectedStep(step.stepId)}
                    >
                      <span className="wf-dot" aria-hidden="true" />
                      <span className="wf-node-name" title={step.capabilityName}>
                        {tidyName(step.capabilityName, 40)}
                      </span>
                      <span className="wf-node-sub">
                        {REPLAY_STATE_LABEL[state]}
                        {state === 'done' && rec?.durationMs !== undefined ? ` · ${formatMs(rec.durationMs)}` : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
        <div className="ex-scrub">
          <ReplayControls total={total} position={position} onPosition={setPosition} caption={frame.caption} />
        </div>
      </section>

      <section className="ex-drawer" aria-label="Step details">
        {record === undefined ? (
          <p className="muted small">Choose a step to see what it recorded.</p>
        ) : (
          <>
            <header className="ex-drawer-head">
              <h2>{tidyName(record.step.capabilityName, 60)}</h2>
              <span className="mono">
                {record.durationMs !== undefined ? `${formatMs(record.durationMs)} · ` : ''}Run {shortRunId(run.workflowExecutionId)}
              </span>
              <div className="ex-dtabs" role="tablist" aria-label="Step details">
                {(['output', 'input', 'trace'] as const).map((t) => (
                  <button key={t} type="button" role="tab" aria-selected={drawer === t} onClick={() => setDrawer(t)}>
                    {t === 'output' ? 'Output' : t === 'input' ? 'Input' : 'Trace'}
                  </button>
                ))}
              </div>
            </header>
            <div role="tabpanel" className="ex-dbody">
              {drawer === 'output' ? (
                record.execution?.output !== undefined ? (
                  <pre className="wf-output">{formatOutput(record.execution.output, 4000)}</pre>
                ) : (
                  <p className="muted small">
                    {record.execution === undefined
                      ? 'The platform recorded no execution for this step, so there is no output to show.'
                      : 'This step recorded no output.'}
                  </p>
                )
              ) : drawer === 'input' ? (
                record.execution === undefined ? (
                  <p className="muted small">The platform recorded no execution for this step, so there is no input to show.</p>
                ) : (
                  <pre className="wf-output">{formatOutput(record.execution.input, 4000)}</pre>
                )
              ) : (
                <ul className="bare-list ex-events">
                  <li>
                    <strong>
                      {REPLAY_STATE_LABEL[replayFrame(run, total).nodes.find((n) => n.stepId === record.step.stepId)?.state ?? 'upcoming']}
                    </strong>
                    <span className="muted small"> · as recorded</span>
                  </li>
                  {record.step.errorMessage !== undefined ? <li className="danger-text">{record.step.errorMessage}</li> : null}
                  {record.events.map((ev, i) => (
                    <li key={i}>
                      {ev.label}
                      {ev.at !== undefined ? <span className="muted small"> · {formatWhen(ev.at)}</span> : null}
                    </li>
                  ))}
                  {record.events.length === 0 ? <li className="muted small">No further events were recorded for this step.</li> : null}
                  {props.builder && record.step.executionId !== undefined ? <li className="mono">{record.step.executionId}</li> : null}
                </ul>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
