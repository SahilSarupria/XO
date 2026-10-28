import { useMemo, useState, type ReactNode } from 'react';
import { describeRun, tidyName, workflowTitle } from '../domain/work';
import { formatOutput, layoutGraph, NODE_H, NODE_W, workflowStatus, type GraphNode } from '../domain/graph';
import { latestExecutionByCapability } from '../domain/review';
import type { Capability, Execution, Workflow, WorkflowRun } from '../platform/wire';
import type { XoItem } from '../domain/xo';
import { ActionNoticeView } from './actions';
import { can } from '../domain/access';
import type { WorkspaceRole } from '../platform/wire';
import { Badge, Button, EmptyState } from './primitives';
import { useWorkflowDraft } from './useWorkflowDraft';
import { WorkflowDraftPanel } from './WorkflowDraftPanel';
import { useSession } from './session';
import { useStartWorkflow } from './useStartWorkflow';
import { ExecutionsPane } from './ExecutionsPane';
import '../styles/graph.css';

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

/** Read-only workflow graph with the node palette and an inspector, plus a saveable draft copy. Editing nodes and running drafts are not available. */
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
  const layout = useMemo(() => layoutGraph(w.steps, props.caps), [w.steps, props.caps]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [zoom, setZoom] = useState(1);
  const selected = layout.nodes.find((n) => n.id === selectedId) ?? layout.nodes[0];
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
          <div className="wf-editor">
            <Palette
              caps={props.caps}
              workflow={w}
              onPick={(capabilityId) => setSelectedId(layout.nodes.find((n) => n.capabilityId === capabilityId)?.id)}
            />
            <section className="wf-canvas" aria-label="Workflow graph">
              {layout.nodes.length === 0 ? (
                <EmptyState title="This process has no steps">XO did not compose any steps for it.</EmptyState>
              ) : (
                <div className="wf-scroll">
                  <div className="wf-stage" style={{ width: layout.width * zoom, height: layout.height * zoom }}>
                    <div
                      style={{
                        width: layout.width,
                        height: layout.height,
                        transform: `scale(${zoom})`,
                        transformOrigin: '0 0',
                        position: 'relative',
                      }}
                    >
                      <svg className="wf-edges" width={layout.width} height={layout.height} aria-hidden="true">
                        {layout.edges.map((e) => (
                          <path key={e.id} d={e.path} />
                        ))}
                      </svg>
                      <ol className="wf-nodes" aria-label="Steps in the order they run">
                        {layout.nodes.map((n) => (
                          <li key={n.id} style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H }}>
                            <button
                              type="button"
                              className="wf-node"
                              data-kind={n.kind}
                              aria-pressed={selected?.id === n.id}
                              onClick={() => setSelectedId(n.id)}
                            >
                              <span className="wf-dot" aria-hidden="true" />
                              <span className="wf-node-name" title={n.name}>
                                {tidyName(n.name, 40)}
                              </span>
                              <span className="wf-node-sub">{n.kind === 'human' ? 'person decides' : 'capability'}</span>
                            </button>
                          </li>
                        ))}
                      </ol>
                    </div>
                  </div>
                </div>
              )}
              <div className="wf-zoom">
                <button
                  type="button"
                  className="wf-zbtn"
                  aria-label="Zoom in"
                  onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.2).toFixed(1)))}
                >
                  +
                </button>
                <button
                  type="button"
                  className="wf-zbtn"
                  aria-label="Zoom out"
                  onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.2).toFixed(1)))}
                >
                  −
                </button>
                <button type="button" className="wf-zbtn wf-fit" onClick={() => setZoom(1)}>
                  Fit
                </button>
                <span className="wf-count">
                  {layout.nodes.length} {layout.nodes.length === 1 ? 'node' : 'nodes'}
                </span>
                <span className="wf-count" title="Nodes cannot be edited yet; Save stores a draft copy">
                  Read-only
                </span>
              </div>
            </section>
            <Inspector
              node={selected}
              caps={props.caps}
              executions={props.executions}
              workflow={w}
              xoLabel={xo?.label}
              builder={mode === 'builder'}
            />
          </div>
          <WorkflowDraftPanel draft={draft} role={props.role} />
        </>
      )}
    </div>
  );
}

function Palette(props: { caps: readonly Capability[] | undefined; workflow: Workflow; onPick: (capabilityId: string) => void }) {
  const [q, setQ] = useState('');
  const match = (s: string) => s.toLowerCase().includes(q.toLowerCase());
  const caps = (props.caps ?? []).filter((c) => c.capabilityId !== '' && match(c.name));
  const inFlow = new Set(props.workflow.steps.map((s) => s.capabilityId));
  const preview: readonly [string, readonly string[]][] = [
    ['Triggers', ['Document dropped', 'Schedule']],
    ['Logic', ['Branch', 'Human review']],
    ['Actions', ['Webhook / Email']],
  ];
  return (
    <aside className="wf-palette" aria-label="Node palette">
      <label className="visually-hidden" htmlFor="wf-search">
        Search nodes
      </label>
      <input id="wf-search" className="searchbox" placeholder="Search nodes…" value={q} onChange={(e) => setQ(e.target.value)} />
      <h2 className="wf-group">XO capabilities</h2>
      <ul className="bare-list">
        {caps.length === 0 ? <li className="muted small">{q === '' ? 'No capabilities loaded.' : 'Nothing matches.'}</li> : null}
        {caps.map((c) => (
          <li key={c.capabilityId}>
            <button type="button" className="wf-item" data-in={inFlow.has(c.capabilityId)} onClick={() => props.onPick(c.capabilityId)}>
              <span className="wf-dot" aria-hidden="true" />
              {tidyName(c.name, 34)}
            </button>
          </li>
        ))}
      </ul>
      {preview.map(([group, items]) => {
        const shown = items.filter(match);
        return shown.length === 0 ? null : (
          <div key={group}>
            <h2 className="wf-group">
              {group} <Badge tone="neutral">Preview</Badge>
            </h2>
            <ul className="bare-list">
              {shown.map((i) => (
                <li key={i}>
                  <button type="button" className="wf-item wf-item-off" aria-disabled="true" title="Adding nodes is not available yet">
                    <span className="wf-dot" aria-hidden="true" />
                    {i}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </aside>
  );
}

function Inspector(props: {
  node: GraphNode | undefined;
  caps: readonly Capability[] | undefined;
  executions: readonly Execution[];
  workflow: Workflow;
  xoLabel: string | undefined;
  builder: boolean;
}) {
  const n = props.node;
  if (n === undefined) return <aside className="wf-inspector" aria-label="Inspector" />;
  const cap = props.caps?.find((c) => c.capabilityId === n.capabilityId);
  const last = latestExecutionByCapability(props.executions, props.workflow.compilationId).get(n.capabilityId);
  const required = cap?.inputContract?.required ?? [];
  return (
    <aside className="wf-inspector" aria-label="Inspector">
      <h2 className="wf-ititle">{tidyName(n.name, 60)}</h2>
      <p className="mono">{n.kind === 'human' ? 'Person decides' : 'XO capability'}</p>
      <dl className="wf-fields">
        <dt>XO</dt>
        <dd>{props.xoLabel ?? 'Analysed document'}</dd>
        <dt>Capability</dt>
        <dd>{cap === undefined ? tidyName(n.name, 60) : tidyName(cap.name, 60)}</dd>
        <dt>Required input</dt>
        <dd>{cap === undefined ? 'Not loaded' : required.length === 0 ? 'None' : required.join(', ')}</dd>
        <dt>Approval</dt>
        <dd>{cap === undefined ? 'Not loaded' : cap.approved ? 'Approved' : 'Not approved yet'}</dd>
        <dt>Confidence</dt>
        <dd>{cap === undefined ? 'Not loaded' : cap.confidence.toFixed(2)}</dd>
        <dt>Memory scope</dt>
        <dd className="muted">Not available yet</dd>
      </dl>
      {n.description !== '' ? <p className="muted small">{n.description}</p> : null}
      <h3 className="chat-label">Last output</h3>
      {last === undefined ? (
        <p className="muted small">No output recorded for this step yet.</p>
      ) : last.output === undefined ? (
        <p className="muted small">The last run of this step recorded no output ({last.status.replace(/_/g, ' ')}).</p>
      ) : (
        <pre className="wf-output">{formatOutput(last.output)}</pre>
      )}
      {props.builder ? <p className="mono small">{n.capabilityId}</p> : null}
    </aside>
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
