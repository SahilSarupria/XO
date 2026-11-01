import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { describeRun, workflowTitle } from '../domain/work';
import { workflowStatus } from '../domain/graph';
import type { Capability, Execution, Workflow, WorkflowRun } from '../platform/wire';
import type { XoItem } from '../domain/xo';
import { ActionNoticeView } from './actions';
import { can } from '../domain/access';
import type { WorkspaceRole } from '../platform/wire';
import { Badge, Button, EmptyState } from './primitives';
import { DraftInspector, DraftPalette } from './DraftEditor';
import { FlowCanvas, type InsertTarget, type NodeBadge } from './FlowCanvas';
import { useWorkflowDraft } from './useWorkflowDraft';
import { WorkflowDraftPanel } from './WorkflowDraftPanel';
import { useSession } from './session';
import { useStartWorkflow } from './useStartWorkflow';
import { ExecutionsPane } from './ExecutionsPane';
import '../styles/graph.css';
import '../styles/flow.css';

export type WorkflowTab = 'editor' | 'executions' | 'settings';

/** The bar every workflow screen shares: where you are, the three tabs, and the actions. */
export function WorkflowBar(props: {
  workflow: Workflow;
  tab: WorkflowTab;
  onTab: (t: WorkflowTab) => void;
  onBack: () => void;
  status: { label: string; tone: 'success' | 'warning' | 'neutral' };
  actions?: ReactNode;
}) {
  const tabs: readonly [WorkflowTab, string][] = [
    ['editor', 'Editor'],
    ['executions', 'Executions'],
    ['settings', 'Settings'],
  ];
  return (
    <header className="wf-bar">
      <nav className="wf-crumbs" aria-label="Breadcrumb">
        <button type="button" className="crumb-link" onClick={props.onBack}>
          Workflows
        </button>
        <span aria-hidden="true"> / </span>
        <h1 className="wf-title">{workflowTitle(props.workflow)}</h1>
        <Badge tone={props.status.tone}>{props.status.label}</Badge>
      </nav>
      <div className="wf-tabs" role="tablist" aria-label="Workflow views">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={props.tab === id} onClick={() => props.onTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="wf-actions">{props.actions}</div>
    </header>
  );
}

/** The workflow editor: the draft graph with a platform-driven node palette and an inspector. Every change is validated by the platform; Save stores the draft. */
export function WorkflowEditor(props: {
  workspaceId: string;
  role?: WorkspaceRole | undefined;
  workflows: readonly Workflow[];
  workflow: Workflow;
  onSelectWorkflow: (id: string) => void;
  caps: readonly Capability[] | undefined;
  executions: readonly Execution[];
  runs: readonly WorkflowRun[];
  xos: readonly XoItem[];
  tab: WorkflowTab;
  onTab: (t: WorkflowTab) => void;
  onBack: () => void;
  onChanged: () => void;
  goToTasks: () => void;
  goToActivity: () => void;
  initialRunId?: string | undefined;
}) {
  const { mode } = useSession();
  const w = props.workflow;
  const draft = useWorkflowDraft(props.workspaceId, w, props.caps);
  const { start, busy, notice, ready, active } = useStartWorkflow({ ...props, workflow: w });
  const status = workflowStatus({
    executable: w.executable,
    needApproval: ready.needApproval.length,
    canStart: ready.canStart,
    activeLabel: active === undefined ? undefined : describeRun(active).label,
  });
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [panel, setPanel] = useState<'step' | 'draft'>('step');
  const [target, setTarget] = useState<InsertTarget | undefined>();
  const selected = draft.nodes.find((n) => n.id === selectedId) ?? draft.nodes[0];
  const mayEdit = can(props.role, 'author');
  const select = (id: string) => {
    setSelectedId(id);
    setPanel('step');
  };
  // Saving, and anything the platform says about it, is shown in the Draft pane: bring it forward so it is not missed.
  useEffect(() => {
    if (draft.note !== undefined || draft.problem !== undefined) setPanel('draft');
  }, [draft.note, draft.problem]);
  const problemCount = (draft.analysis?.errors.length ?? 0) + (draft.analysis?.blockers.length ?? 0);
  // Approval is the one thing worth seeing at a glance: the platform refuses to run a step that is not approved.
  const badges = useMemo(() => {
    const m = new Map<string, NodeBadge>();
    for (const n of draft.nodes) {
      if (n.kind !== 'capability') continue;
      const cap = props.caps?.find((c) => c.capabilityId === n.config['capabilityId']);
      if (cap !== undefined && !cap.approved) m.set(n.id, { text: 'Not approved', tone: 'warning' });
    }
    return m;
  }, [draft.nodes, props.caps]);
  const xo = props.xos.find((x) => x.id === w.compilationId);

  const actions = (
    <>
      <Button
        variant="secondary"
        pending={draft.saving}
        disabled={!can(props.role, 'author') || draft.name.trim() === ''}
        onClick={() => void draft.save()}
      >
        Save
      </Button>
      <Button
        variant="primary"
        pending={busy}
        disabled={active !== undefined || !ready.canStart}
        onClick={start}
        aria-describedby="wf-run-why"
      >
        ▶ Run
      </Button>
    </>
  );

  return (
    <div className="wf">
      <WorkflowBar
        workflow={w}
        tab={props.tab}
        onTab={props.onTab}
        onBack={props.onBack}
        status={status}
        actions={props.tab === 'executions' ? undefined : actions}
      />
      <div className="wf-notes" id="wf-run-why" hidden={props.tab === 'executions'}>
        {active !== undefined ? (
          <p className="small">
            {describeRun(active).summary}{' '}
            <button
              type="button"
              className="chat-link"
              onClick={active.status === 'waiting_for_human' || active.status === 'interrupted' ? props.goToTasks : props.goToActivity}
            >
              {active.status === 'waiting_for_human' || active.status === 'interrupted' ? 'Continue in Inbox' : 'See progress'}
            </button>
          </p>
        ) : !ready.canStart && ready.reason !== undefined ? (
          <p className="muted small">{ready.reason}</p>
        ) : null}
        <ActionNoticeView notice={notice} />
      </div>
      {props.tab === 'executions' ? (
        <ExecutionsPane workflow={w} runs={props.runs} executions={props.executions} caps={props.caps} initialRunId={props.initialRunId} />
      ) : props.tab === 'settings' ? (
        <WorkflowSettings workflow={w} workflows={props.workflows} onSelectWorkflow={props.onSelectWorkflow} builder={mode === 'builder'} />
      ) : (
        <>
          <div
            className="wf-editor"
            onKeyDown={(e) => {
              if (e.key === 'Escape' && target !== undefined) setTarget(undefined);
            }}
          >
            <DraftPalette
              caps={props.caps}
              workflow={w}
              draft={draft}
              role={props.role}
              selectedId={selected?.id}
              onAdded={select}
              target={target}
              onClearTarget={() => setTarget(undefined)}
            />
            <section className="wf-canvas" aria-label="Workflow graph">
              {draft.nodes.length === 0 ? (
                <EmptyState title="This draft has no steps">Add a start and a capability from the palette.</EmptyState>
              ) : (
                <FlowCanvas
                  draft={draft}
                  selectedId={selected?.id}
                  onSelect={select}
                  canEdit={mayEdit}
                  badges={badges}
                  insertTarget={target}
                  onInsert={setTarget}
                />
              )}
            </section>
            <div className="wf-side">
              <div className="wf-side-tabs" role="tablist" aria-label="Side panel">
                <button type="button" role="tab" aria-selected={panel === 'step'} onClick={() => setPanel('step')}>
                  Step
                </button>
                <button type="button" role="tab" aria-selected={panel === 'draft'} onClick={() => setPanel('draft')}>
                  Draft
                  {problemCount > 0 ? (
                    <span className="wf-tab-count" aria-label={`${problemCount} ${problemCount === 1 ? 'problem' : 'problems'}`}>
                      {problemCount}
                    </span>
                  ) : null}
                </button>
              </div>
              <div className="wf-pane" data-active={panel === 'step'}>
                <DraftInspector
                  draft={draft}
                  role={props.role}
                  selectedId={selected?.id}
                  caps={props.caps}
                  executions={props.executions}
                  workflow={w}
                  xoLabel={xo?.label}
                  builder={mode === 'builder'}
                  onSelect={(id) => setSelectedId(id)}
                />
              </div>
              <div className="wf-pane" data-active={panel === 'draft'}>
                <WorkflowDraftPanel
                  draft={draft}
                  role={props.role}
                  workspaceId={props.workspaceId}
                  caps={props.caps}
                  onChanged={props.onChanged}
                  goToTasks={props.goToTasks}
                  goToActivity={props.goToActivity}
                />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function WorkflowSettings(props: {
  workflow: Workflow;
  workflows: readonly Workflow[];
  onSelectWorkflow: (id: string) => void;
  builder: boolean;
}) {
  const w = props.workflow;
  return (
    <div className="wf-settings">
      <p className="notice notice-info small">Workflow settings are not editable yet. This is what the platform holds for this process.</p>
      {props.workflows.length > 1 ? (
        <>
          <label htmlFor="wf-pick">Process</label>
          <select id="wf-pick" value={w.workflowId} onChange={(e) => props.onSelectWorkflow(e.target.value)}>
            {props.workflows.map((x) => (
              <option key={x.workflowId} value={x.workflowId}>
                {workflowTitle(x)}
              </option>
            ))}
          </select>
        </>
      ) : null}
      <dl className="wf-fields">
        <dt>Name</dt>
        <dd>{workflowTitle(w)}</dd>
        <dt>Steps</dt>
        <dd>{w.stepCount}</dd>
        <dt>Can run</dt>
        <dd>{w.executable ? 'Yes' : 'Not yet'}</dd>
        <dt>Needs a person</dt>
        <dd>{w.requiresHumanDecision ? 'Yes' : 'No'}</dd>
        <dt>Uncertainties about the order</dt>
        <dd>{w.gapCount}</dd>
        {props.builder ? (
          <>
            <dt>Workflow id</dt>
            <dd className="mono">{w.workflowId}</dd>
            <dt>Status</dt>
            <dd className="mono">{w.status}</dd>
          </>
        ) : null}
      </dl>
      {w.description !== '' ? <p className="muted small">{w.description}</p> : null}
    </div>
  );
}
