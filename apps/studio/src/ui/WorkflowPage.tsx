import { useState } from 'react';
import { nextStep, workflowStatus } from '../domain/workflowEntity';
import { tidyName } from '../domain/work';
import { useQuery, wsKey } from '../platform/query';
import type { Capability, WorkspaceRole } from '../platform/wire';
import type { WorkflowDetailView } from '../platform/wire-workflows';
import { can, whyNot } from '../domain/access';
import { ActionNoticeView } from './actions';
import {
  Banner,
  Breadcrumb,
  Button,
  Card,
  DescriptionList,
  ErrorState,
  Field,
  PageHeader,
  Skeleton,
  StatusPill,
  Tabs,
  TextField,
  WhoMark,
} from './kit';
import { tabPanelProps } from './kit';
import { formatWhen, loadedValue } from './primitives';
import { ItemSourcePicker } from './ItemSourcePicker';
import { SendSetup } from './SendSetup';
import { ReadinessCertificatePanel } from './ReadinessCertificatePanel';
import { WorkflowModeControls } from './WorkflowModeControls';
import { useSession } from './session';
import { useStartEntity } from './useStartEntity';
import { WORKFLOW_PAGE_TABS, type WorkflowPageTab } from './sectionRoute';
import '../styles/workflow-page.css';

const TAB_LABEL: Readonly<Record<WorkflowPageTab, string>> = {
  overview: 'Overview',
  runs: 'Runs',
  schedule: 'Schedule and approvals',
  setup: 'Setup',
  history: 'History',
};

/** The words for a run's state; an unknown state is shown as its own words, never guessed. */
const RUN_WORDS: Readonly<Record<string, string>> = {
  running: 'Running',
  waiting_for_approval: 'Waiting for a person',
  waiting_for_human: 'Waiting for a person',
  completed: 'Done',
  succeeded: 'Done',
  failed: 'Did not complete',
  cancelled: 'Cancelled',
  partially_completed: 'Partly done',
};
const runWords = (state: string): string => RUN_WORDS[state] ?? state.replace(/_/g, ' ');

/**
 * S1-5: a workflow's own page, at `/w/<workspace>/work/<workflowId>`. Everything shown is what the platform reports about it; the
 * buttons only ask, and the platform decides (readiness, approvals, pauses). Replaces the side drawer for named workflows.
 */
export function WorkflowPage(props: {
  workspaceId: string;
  workflowId: string;
  tab: WorkflowPageTab;
  onTab: (t: WorkflowPageTab) => void;
  role?: WorkspaceRole | undefined;
  caps: readonly Capability[] | undefined;
  onBack: () => void;
  onChanged: () => void;
  goToInbox: () => void;
  goToActivity: () => void;
  goToSources: () => void;
}) {
  const { client, mode } = useSession();
  const detail = useQuery(wsKey(props.workspaceId, `workflow/${props.workflowId}`), () =>
    client.getWorkflowEntity(props.workspaceId, props.workflowId),
  );
  const w = loadedValue(detail.state);
  const changed = () => {
    detail.reload();
    props.onChanged();
  };
  const crumbs = <Breadcrumb items={[{ label: 'Workflows', onSelect: props.onBack, href: '#' }, { label: w?.name ?? 'Workflow' }]} />;

  if (detail.state.phase === 'error' && w === undefined)
    return (
      <main className="page wfp" aria-label="Workflow">
        <PageHeader title="Workflow" breadcrumb={crumbs} />
        <ErrorState problem={detail.state.problem} onRetry={detail.reload} />
      </main>
    );
  if (w === undefined)
    return (
      <main className="page wfp" aria-label="Workflow">
        <PageHeader title="Workflow" breadcrumb={crumbs} />
        <Skeleton label="Loading the workflow" />
      </main>
    );

  const status = workflowStatus(w);
  const idBase = `wfp-${w.workflowId.slice(0, 12)}`;
  return (
    <main className="page wfp" aria-label={w.name}>
      <PageHeader
        title={w.name}
        status={<StatusPill status={status} />}
        lede={w.currentVersion.goalText}
        breadcrumb={crumbs}
        actions={<Rename workspaceId={props.workspaceId} w={w} role={props.role} onChanged={changed} />}
      />
      {detail.state.phase === 'error' ? (
        <Banner tone="attention" title="This page may be out of date">
          XO could not refresh it just now. What you see was loaded earlier.
        </Banner>
      ) : null}
      <Tabs
        label="Workflow"
        idBase={idBase}
        items={WORKFLOW_PAGE_TABS.map((id) => ({ id, label: TAB_LABEL[id] }))}
        current={props.tab}
        onSelect={(id) => props.onTab(id as WorkflowPageTab)}
      />
      <div {...tabPanelProps(idBase, props.tab)} className="wfp-panel">
        {props.tab === 'overview' ? <Overview {...props} w={w} onChanged={changed} /> : null}
        {props.tab === 'runs' ? <Runs w={w} goToActivity={props.goToActivity} /> : null}
        {props.tab === 'schedule' ? <Schedule {...props} w={w} onChanged={changed} mode={mode} /> : null}
        {props.tab === 'setup' ? <Setup {...props} w={w} /> : null}
        {props.tab === 'history' ? <History w={w} /> : null}
      </div>
    </main>
  );
}

function Rename(props: { workspaceId: string; w: WorkflowDetailView; role: WorkspaceRole | undefined; onChanged: () => void }) {
  const { client } = useSession();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(props.w.name);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const allowed = can(props.role, 'author');
  if (!editing)
    return (
      <Button
        variant="secondary"
        {...(!allowed ? { disabledReason: whyNot(props.role, 'author', 'renaming workflows') } : {})}
        onClick={() => {
          setName(props.w.name);
          setEditing(true);
        }}
      >
        Rename
      </Button>
    );
  const save = async () => {
    setBusy(true);
    setError(undefined);
    const r = await client.renameWorkflowEntity(props.workspaceId, props.w.workflowId, name.trim(), props.w.revision);
    setBusy(false);
    if (!r.ok) return setError(r.problem.message);
    setEditing(false);
    props.onChanged();
  };
  return (
    <form
      className="wfp-rename"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field label="Name" {...(error !== undefined ? { error } : {})}>
        <TextField value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Button
        type="submit"
        variant="primary"
        loading={busy}
        {...(name.trim() === '' || name.trim() === props.w.name ? { disabledReason: 'Type a new name to save it.' } : {})}
      >
        Save name
      </Button>
      <Button variant="quiet" onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </form>
  );
}

function Overview(props: Parameters<typeof WorkflowPage>[0] & { w: WorkflowDetailView }) {
  const { w } = props;
  const { start, busy, notice, choices, chooseSource, cancelChoice } = useStartEntity({
    workspaceId: props.workspaceId,
    workflowId: w.workflowId,
    definitionId: w.currentVersion.definitionId,
    onChanged: props.onChanged,
  });
  const allowed = can(props.role, 'author');
  const blocked = w.archived || w.paused || w.workspacePaused || w.pendingApprovals.length > 0;
  const running = w.runs.find((r) => r.state === 'running');
  return (
    <div className="stack">
      <Card title="What happens next">
        <p>{nextStep(w)}</p>
        <div className="row">
          {w.pendingApprovals.length > 0 ? (
            <Button variant="primary" onClick={props.goToInbox}>
              Decide in the Inbox
            </Button>
          ) : (
            <Button
              variant="primary"
              loading={busy}
              {...(!allowed
                ? { disabledReason: whyNot(props.role, 'author', 'starting workflows') }
                : blocked
                  ? { disabledReason: nextStep(w) }
                  : {})}
              onClick={start}
            >
              Start this workflow
            </Button>
          )}
          {running !== undefined ? (
            <Button variant="secondary" onClick={props.goToActivity}>
              See progress
            </Button>
          ) : null}
        </div>
        <div aria-live="polite" className="wfp-live">
          {running !== undefined ? `A run is going now, started ${formatWhen(running.startedAt)}.` : ''}
        </div>
        <ActionNoticeView notice={notice} />
        <ItemSourcePicker sources={choices} onChoose={chooseSource} onCancel={cancelChoice} disabled={busy} />
      </Card>
      <Card title="At a glance">
        <DescriptionList
          items={[
            { term: 'Runs so far', value: String(w.runsTotal) },
            ...(w.runs[0] !== undefined
              ? [{ term: 'Latest run', value: `${runWords(w.runs[0].state)}, ${formatWhen(w.runs[0].startedAt)}` }]
              : []),
            { term: 'Waiting for a person', value: String(w.pendingApprovals.length) },
            { term: 'Check before starting', value: w.currentVersion.certificate !== undefined ? 'Done' : 'Not done yet' },
          ]}
        />
      </Card>
    </div>
  );
}

function Runs(props: { w: WorkflowDetailView; goToActivity: () => void }) {
  const { w } = props;
  if (w.runs.length === 0) return <Card title="Runs">This workflow has not run yet. Start it from the Overview.</Card>;
  return (
    <Card
      title="Runs"
      actions={
        <Button variant="quiet" onClick={props.goToActivity}>
          All runs in Activity
        </Button>
      }
    >
      <ul className="wfp-list" aria-label="Runs of this workflow">
        {w.runs.map((r) => (
          <li key={r.runId}>
            <span>{runWords(r.state)}</span>
            <span className="muted small">{formatWhen(r.startedAt)}</span>
            {r.pendingApprovals > 0 ? <span className="small">{r.pendingApprovals} waiting for a person</span> : null}
          </li>
        ))}
      </ul>
      {w.runsTotal > w.runs.length ? (
        <p className="muted small">
          Showing the latest {w.runs.length} of {w.runsTotal}. The rest are in Activity.
        </p>
      ) : null}
    </Card>
  );
}

function Schedule(props: Parameters<typeof WorkflowPage>[0] & { w: WorkflowDetailView; mode: string }) {
  const { w } = props;
  return (
    <div className="stack">
      <Card title="Waiting for a person">
        {w.pendingApprovals.length === 0 ? (
          <p>Nothing is waiting for a decision.</p>
        ) : (
          <>
            <ul className="wfp-list">
              {w.pendingApprovals.map((a) => (
                <li key={a.approvalId}>{a.summary}</li>
              ))}
            </ul>
            <Button variant="primary" onClick={props.goToInbox}>
              Decide in the Inbox
            </Button>
          </>
        )}
      </Card>
      <Card title="Pause and resume">
        <p>
          {w.paused
            ? 'This workflow is paused. Nothing will start until you resume it.'
            : 'This workflow is on. You can pause it at any time.'}
        </p>
        <PauseButtons workspaceId={props.workspaceId} w={w} role={props.role} onChanged={props.onChanged} />
        <ReadinessCertificatePanel
          workspaceId={props.workspaceId}
          compilationId=""
          entity
          workflowId={w.workflowId}
          workflowName={w.name}
          role={props.role}
        />
      </Card>
      <p className="muted small">Recurring runs are not set up from this page yet.</p>
    </div>
  );
}

function PauseButtons(props: { workspaceId: string; w: WorkflowDetailView; role: WorkspaceRole | undefined; onChanged: () => void }) {
  const { client } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const allowed = can(props.role, 'author');
  const act = async () => {
    setBusy(true);
    setError(undefined);
    const r = await client.setWorkflowEntityFlag(props.workspaceId, props.w.workflowId, props.w.paused ? 'resume' : 'pause');
    setBusy(false);
    if (!r.ok) return setError(r.problem.message);
    props.onChanged();
  };
  return (
    <div className="stack">
      <Button
        variant="secondary"
        loading={busy}
        {...(!allowed ? { disabledReason: whyNot(props.role, 'author', 'pausing workflows') } : {})}
        onClick={() => void act()}
      >
        {props.w.paused ? 'Resume this workflow' : 'Pause this workflow'}
      </Button>
      {error !== undefined ? (
        <Banner tone="danger" title="That did not work">
          {error}
        </Banner>
      ) : null}
    </div>
  );
}

function Setup(props: Parameters<typeof WorkflowPage>[0] & { w: WorkflowDetailView }) {
  const { client } = useSession();
  const all = useQuery(wsKey(props.workspaceId, 'workflows'), () => client.listWorkflows(props.workspaceId));
  const compiled = loadedValue(all.state)?.find(
    (c) =>
      c.workflowId === props.w.currentVersion.candidateWorkflowId &&
      (props.w.currentVersion.compilationId === undefined || c.compilationId === props.w.currentVersion.compilationId),
  );
  if (loadedValue(all.state) === undefined)
    return all.state.phase === 'error' ? (
      <ErrorState problem={all.state.problem} onRetry={all.reload} />
    ) : (
      <Skeleton label="Loading the steps" />
    );
  const steps = compiled?.steps ?? [];
  const stepNames = steps.map((n) => ({ name: n.name, label: tidyName(n.name, 80) }));
  return (
    <div className="stack">
      <Card title="Steps">
        {steps.length === 0 ? (
          <p>XO has not listed any steps for this workflow yet.</p>
        ) : (
          <ol className="wfp-steps" aria-label="Steps in this workflow">
            {steps.map((n) => {
              const cap = props.caps?.find((c) => c.capabilityId === n.capabilityId);
              const who = cap?.executionClass === 'human_in_the_loop' ? 'person' : 'xo';
              return (
                <li key={`${n.order}-${n.capabilityId}`}>
                  <WhoMark who={who} showLabel />
                  <span>{tidyName(n.name, 80)}</span>
                </li>
              );
            })}
          </ol>
        )}
      </Card>
      {steps.length > 0 ? (
        <SendSetup
          workspaceId={props.workspaceId}
          definitionId={props.w.currentVersion.definitionId}
          workflowId={props.w.workflowId}
          revision={props.w.revision}
          steps={stepNames}
          role={props.role}
          onSaved={props.onChanged}
        />
      ) : null}
    </div>
  );
}

function History(props: { w: WorkflowDetailView }) {
  const { w } = props;
  return (
    <Card title="History">
      <DescriptionList
        items={[
          { term: 'Versions', value: String(w.versionCount) },
          { term: 'Current version', value: String(w.currentVersion.version) },
          ...(w.currentVersion.certificate !== undefined
            ? [
                {
                  term: 'Last check before starting',
                  value: `${w.currentVersion.certificate.status.replace(/_/g, ' ').toLowerCase()}, ${formatWhen(w.currentVersion.certificate.issuedAt)}`,
                },
              ]
            : []),
        ]}
      />
      <ul className="wfp-list" aria-label="Changes">
        {[...w.history].reverse().map((h) => (
          <li key={h.revision}>
            <span>{h.kind.replace(/_/g, ' ')}</span>
            <span className="muted small">{formatWhen(h.at)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
