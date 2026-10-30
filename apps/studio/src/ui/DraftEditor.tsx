import { useEffect, useState } from 'react';
import { can, whyNot } from '../domain/access';
import {
  branchSide,
  branchTargets,
  canMove,
  insertNode,
  KIND_LABEL,
  layoutDraft,
  moveNode,
  NODE_H,
  NODE_W,
  nextNodeId,
  removeNode,
  setBranchTarget,
  updateNode,
  whereAdd,
} from '../domain/draftEdit';
import { formatOutput } from '../domain/graph';
import { latestExecutionByCapability } from '../domain/review';
import { tidyName } from '../domain/work';
import type { Capability, Execution, Workflow, WorkspaceRole } from '../platform/wire';
import type { DraftNode, NodeKindSupport } from '../platform/wire-studio';
import { clip, MAX_NODE_LABEL } from '../domain/workflowDraft';
import { Badge, Button } from './primitives';
import type { DraftController } from './useWorkflowDraft';

const variantOf = (kinds: readonly NodeKindSupport[] | undefined, kind: string) => kinds?.find((k) => k.kind === kind);

/**
 * Everything the palette offers comes from what the platform reports it can run. A kind it cannot run stays visible,
 * disabled, with the platform's own reason. Role-based disabling is a hint; the platform's refusal is shown on Save.
 */
export function DraftPalette(props: {
  caps: readonly Capability[] | undefined;
  workflow: Workflow;
  draft: DraftController;
  role: WorkspaceRole | undefined;
  selectedId: string | undefined;
  onAdded: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const d = props.draft;
  const match = (s: string) => s.toLowerCase().includes(q.toLowerCase());
  const mayEdit = can(props.role, 'author');
  const where = whereAdd({ nodes: d.nodes, edges: d.edges }, props.selectedId);
  const blocked = !mayEdit ? whyNot(props.role, 'author', 'editing workflows') : !where.ok ? where.reason : undefined;
  const inFlow = new Set(d.nodes.map((n) => String(n.config['capabilityId'] ?? '')));
  const add = (node: Omit<DraftNode, 'id'>) => {
    const id = nextNodeId(d.nodes);
    d.edit((g) => insertNode(g, { id, ...node } as DraftNode, props.selectedId));
    props.onAdded(id);
  };
  const hasStart = d.nodes.some((n) => n.kind === 'trigger');
  const trigger = variantOf(d.kinds, 'trigger');
  const capKind = variantOf(d.kinds, 'capability');
  const branch = variantOf(d.kinds, 'branch');
  const review = variantOf(d.kinds, 'human_review');
  const unsupported = (d.kinds ?? []).filter((k) => !k.supported);
  const item = (key: string, label: string, onClick: (() => void) | undefined, why: string | undefined, inUse = false) => (
    <li key={key}>
      <button
        type="button"
        className={`wf-item${why !== undefined ? ' wf-item-off' : ''}`}
        data-in={inUse}
        aria-disabled={why !== undefined}
        onClick={() => (why === undefined ? onClick?.() : undefined)}
      >
        <span className="wf-dot" aria-hidden="true" />
        {label}
      </button>
      {why !== undefined && why !== blocked ? <span className="wf-reason">{why}</span> : null}
    </li>
  );
  return (
    <aside className="wf-palette" aria-label="Node palette">
      <label className="visually-hidden" htmlFor="wf-search">
        Search nodes
      </label>
      <input id="wf-search" className="searchbox" placeholder="Search nodes…" value={q} onChange={(e) => setQ(e.target.value)} />
      {d.kinds === undefined ? <p className="muted small">Asking the platform what it can run…</p> : null}
      {blocked !== undefined ? <p className="muted small">{blocked}</p> : null}

      <h2 className="wf-group">XO capabilities</h2>
      <ul className="bare-list">
        {(props.caps ?? []).filter((c) => c.capabilityId !== '' && match(c.name)).length === 0 ? (
          <li className="muted small">{q === '' ? 'No capabilities loaded.' : 'Nothing matches.'}</li>
        ) : null}
        {(props.caps ?? [])
          .filter((c) => c.capabilityId !== '' && match(c.name))
          .map((c) =>
            item(
              c.capabilityId,
              tidyName(c.name, 34),
              () =>
                add({
                  kind: 'capability',
                  label: clip(c.name, MAX_NODE_LABEL),
                  config: {
                    packageName: clip(props.workflow.name, 200),
                    capabilityId: c.capabilityId,
                    memoryScope: 'none',
                    compilationId: props.workflow.compilationId,
                  },
                }),
              blocked ?? (capKind?.supported === false ? capKind.reason : d.kinds === undefined ? 'Waiting for the platform.' : undefined),
              inFlow.has(c.capabilityId),
            ),
          )}
      </ul>

      <h2 className="wf-group">Start</h2>
      <ul className="bare-list">
        {(trigger?.variants ?? [{ value: 'manual', supported: true }])
          .filter((v) => match(`start ${v.value}`))
          .map((v) =>
            item(
              `t-${v.value}`,
              v.value === 'manual' ? 'Manual start' : v.value === 'schedule' ? 'Schedule' : 'Document dropped',
              () => add({ kind: 'trigger', label: 'Start', config: { type: v.value } }),
              !v.supported
                ? v.reason
                : hasStart
                  ? 'This draft already has a start.'
                  : !mayEdit
                    ? blocked
                    : d.kinds === undefined
                      ? 'Waiting for the platform.'
                      : undefined,
            ),
          )}
      </ul>

      <h2 className="wf-group">Logic</h2>
      <ul className="bare-list">
        {match('branch')
          ? item(
              'branch',
              'Branch on confidence',
              () => add({ kind: 'branch', label: 'Branch', config: { metric: 'confidence', threshold: 0.8 } }),
              blocked ?? (branch?.supported === false ? branch.reason : undefined),
            )
          : null}
        {match('person review human')
          ? item(
              'review',
              'Person reviews',
              () => add({ kind: 'human_review', label: 'A person reviews', config: {} }),
              blocked ?? (review?.supported === false ? review.reason : undefined),
            )
          : null}
      </ul>

      {unsupported.length > 0 ? (
        <>
          <h2 className="wf-group">
            Not available <Badge tone="neutral">Platform</Badge>
          </h2>
          <ul className="bare-list">
            {unsupported
              .filter((k) => k.kind !== 'trigger')
              .map((k) => item(`x-${k.kind}`, KIND_LABEL[k.kind], undefined, k.reason ?? 'The platform cannot run this.'))}
          </ul>
        </>
      ) : null}
    </aside>
  );
}

/** The draft drawn as the platform will read it, with each node's own problems marked. */
export function DraftCanvas(props: {
  draft: DraftController;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  zoom: number;
}) {
  const d = props.draft;
  const layout = layoutDraft({ nodes: d.nodes, edges: d.edges });
  return (
    <div className="wf-scroll">
      <div className="wf-stage" style={{ width: layout.width * props.zoom, height: layout.height * props.zoom }}>
        <div
          style={{
            width: layout.width,
            height: layout.height,
            transform: `scale(${props.zoom})`,
            transformOrigin: '0 0',
            position: 'relative',
          }}
        >
          <svg className="wf-edges" width={layout.width} height={layout.height} aria-hidden="true">
            {layout.edges.map((e) => (
              <g key={e.id}>
                <path d={e.path} />
                {e.when !== undefined ? (
                  <text className="wf-edge-label" x={e.labelX} y={e.labelY}>
                    {e.when === 'gte' ? 'at or above' : 'below'}
                  </text>
                ) : null}
              </g>
            ))}
          </svg>
          <ol className="wf-nodes" aria-label="Steps in the draft">
            {layout.nodes.map(({ node, x, y }) => {
              const issues = d.issuesByNode.get(node.id) ?? [];
              return (
                <li key={node.id} style={{ left: x, top: y, width: NODE_W, height: NODE_H }}>
                  <button
                    type="button"
                    className="wf-node"
                    data-kind={node.kind === 'human_review' ? 'human' : node.kind}
                    data-issues={issues.length > 0}
                    aria-pressed={props.selectedId === node.id}
                    aria-label={`${node.label ?? KIND_LABEL[node.kind]} (${KIND_LABEL[node.kind]})${issues.length > 0 ? `, ${issues.length} ${issues.length === 1 ? 'problem' : 'problems'}` : ''}`}
                    onClick={() => props.onSelect(node.id)}
                  >
                    <span className="wf-dot" aria-hidden="true" />
                    <span className="wf-node-name" title={node.label}>
                      {tidyName(node.label ?? KIND_LABEL[node.kind], 40)}
                    </span>
                    <span className="wf-node-sub">{KIND_LABEL[node.kind]}</span>
                    {issues.length > 0 ? (
                      <span className="wf-node-issue" aria-hidden="true">
                        ● {issues.length}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}

/** Settings of the selected node, every change sent to the platform for validation; its errors for this node are listed here. */
export function DraftInspector(props: {
  draft: DraftController;
  role: WorkspaceRole | undefined;
  selectedId: string | undefined;
  caps: readonly Capability[] | undefined;
  executions: readonly Execution[];
  workflow: Workflow;
  xoLabel: string | undefined;
  builder: boolean;
  onSelect: (id: string | undefined) => void;
}) {
  const d = props.draft;
  const node = d.nodes.find((n) => n.id === props.selectedId);
  const mayEdit = can(props.role, 'author');
  const [threshold, setThreshold] = useState('');
  useEffect(() => {
    if (node?.kind === 'branch') setThreshold(String(node.config['threshold'] ?? ''));
  }, [node?.id, node?.kind]); // eslint-disable-line react-hooks/exhaustive-deps
  if (node === undefined)
    return (
      <aside className="wf-inspector" aria-label="Inspector">
        <p className="muted small">Select a step to see and change its settings.</p>
      </aside>
    );
  const g = { nodes: d.nodes, edges: d.edges };
  const issues = d.issuesByNode.get(node.id) ?? [];
  const cap = node.kind === 'capability' ? props.caps?.find((c) => c.capabilityId === node.config['capabilityId']) : undefined;
  const last =
    cap !== undefined ? latestExecutionByCapability(props.executions, props.workflow.compilationId).get(cap.capabilityId) : undefined;
  const why = !mayEdit ? whyNot(props.role, 'author', 'editing workflows') : undefined;
  const earlier = canMove(g, node.id, 'earlier');
  const later = canMove(g, node.id, 'later');
  const memory = variantOf(d.kinds, 'capability')?.variants;
  const triggerVariants = variantOf(d.kinds, 'trigger')?.variants;
  const labelId = `wf-label-${node.id}`;
  return (
    <aside className="wf-inspector" aria-label="Inspector">
      <h2 className="wf-ititle">{tidyName(node.label ?? KIND_LABEL[node.kind], 60)}</h2>
      <p className="mono">{KIND_LABEL[node.kind]}</p>
      {issues.length > 0 ? (
        <ul className="wf-issues" aria-label="Problems with this step">
          {issues.map((i, k) => (
            <li key={k}>{i.message}</li>
          ))}
        </ul>
      ) : null}
      <label htmlFor={labelId}>Label</label>
      <input
        id={labelId}
        value={node.label ?? ''}
        disabled={!mayEdit}
        onChange={(e) => d.edit((x) => updateNode(x, node.id, { label: e.target.value }))}
      />

      {node.kind === 'trigger' ? (
        <>
          <label htmlFor="wf-trigger-type">Starts when</label>
          <select
            id="wf-trigger-type"
            value={String(node.config['type'] ?? '')}
            disabled={!mayEdit}
            onChange={(e) => d.edit((x) => updateNode(x, node.id, { config: { type: e.target.value } }))}
          >
            {(triggerVariants ?? [{ value: String(node.config['type'] ?? 'manual'), supported: true }]).map((v) => (
              <option key={v.value} value={v.value} disabled={!v.supported && v.value !== node.config['type']}>
                {v.value === 'manual' ? 'Someone starts it' : v.value === 'schedule' ? 'On a schedule' : 'A document is dropped'}
                {!v.supported ? ' — not available' : ''}
              </option>
            ))}
          </select>
          {triggerVariants
            ?.filter((v) => !v.supported)
            .map((v) => (
              <p key={v.value} className="muted small">
                {v.reason}
              </p>
            ))}
        </>
      ) : null}

      {node.kind === 'capability' ? (
        <>
          <dl className="wf-fields">
            <dt>XO</dt>
            <dd>{props.xoLabel ?? 'Analysed document'}</dd>
            <dt>Capability</dt>
            <dd>{cap === undefined ? 'Not loaded' : tidyName(cap.name, 60)}</dd>
            <dt>Required input</dt>
            <dd>
              {cap === undefined
                ? 'Not loaded'
                : (cap.inputContract?.required ?? []).length === 0
                  ? 'None'
                  : (cap.inputContract?.required ?? []).join(', ')}
            </dd>
            <dt>Approval</dt>
            <dd>{cap === undefined ? 'Not loaded' : cap.approved ? 'Approved' : 'Not approved yet'}</dd>
            <dt>Confidence</dt>
            <dd>{cap === undefined ? 'Not loaded' : cap.confidence.toFixed(2)}</dd>
          </dl>
          <label htmlFor="wf-memory">Memory scope</label>
          <select
            id="wf-memory"
            value={String(node.config['memoryScope'] ?? 'none')}
            disabled={!mayEdit}
            onChange={(e) => d.edit((x) => updateNode(x, node.id, { config: { memoryScope: e.target.value } }))}
          >
            {(memory ?? [{ value: 'none', supported: true }]).map((v) => (
              <option key={v.value} value={v.value} disabled={!v.supported && v.value !== node.config['memoryScope']}>
                {v.value === 'none' ? 'None' : v.value === 'workflow' ? 'This workflow' : 'This workspace'}
                {!v.supported ? ' — not available' : ''}
              </option>
            ))}
          </select>
          {memory?.filter((v) => !v.supported)[0]?.reason !== undefined ? (
            <p className="muted small">{memory?.filter((v) => !v.supported)[0]?.reason}</p>
          ) : null}
          <h3 className="chat-label">Last output</h3>
          {last === undefined ? (
            <p className="muted small">No output recorded for this step yet.</p>
          ) : last.output === undefined ? (
            <p className="muted small">The last run of this step recorded no output ({last.status.replace(/_/g, ' ')}).</p>
          ) : (
            <pre className="wf-output">{formatOutput(last.output)}</pre>
          )}
        </>
      ) : null}

      {node.kind === 'branch' ? (
        <BranchSettings {...props} node={node} threshold={threshold} setThreshold={setThreshold} mayEdit={mayEdit} />
      ) : null}

      {node.kind === 'human_review' ? (
        <p className="muted small">{variantOf(d.kinds, 'human_review')?.note ?? 'A person reviews the step before this.'}</p>
      ) : null}

      <div className="wf-node-actions">
        <Button
          variant="secondary"
          disabled={!mayEdit || !earlier.ok}
          aria-describedby={`wf-move-why-${node.id}`}
          onClick={() => d.edit((x) => moveNode(x, node.id, 'earlier'))}
        >
          Move earlier
        </Button>
        <Button
          variant="secondary"
          disabled={!mayEdit || !later.ok}
          aria-describedby={`wf-move-why-${node.id}`}
          onClick={() => d.edit((x) => moveNode(x, node.id, 'later'))}
        >
          Move later
        </Button>
        <Button
          variant="secondary"
          disabled={!mayEdit}
          onClick={() => {
            const next = d.edges.find((e) => e.from === node.id)?.to ?? d.edges.find((e) => e.to === node.id)?.from;
            d.edit((x) => removeNode(x, node.id));
            props.onSelect(next);
          }}
        >
          Remove step
        </Button>
      </div>
      <p id={`wf-move-why-${node.id}`} className="muted small">
        {why ??
          (!earlier.ok && !later.ok
            ? (earlier as { reason: string }).reason
            : !earlier.ok
              ? (earlier as { reason: string }).reason
              : !later.ok
                ? (later as { reason: string }).reason
                : '')}
      </p>
      {props.builder ? (
        <p className="mono small">
          {node.id}
          {node.kind === 'capability' ? ` · ${String(node.config['capabilityId'])}` : ''}
        </p>
      ) : null}
    </aside>
  );
}

function BranchSettings(props: {
  draft: DraftController;
  node: DraftNode;
  threshold: string;
  setThreshold: (v: string) => void;
  mayEdit: boolean;
}) {
  const { draft: d, node } = props;
  const g = { nodes: d.nodes, edges: d.edges };
  const parsed = props.threshold.trim() === '' ? undefined : Number(props.threshold);
  const label = (id: string) => tidyName(d.nodes.find((n) => n.id === id)?.label ?? id, 40);
  const note = variantOf(d.kinds, 'branch')?.note;
  const decision = d.analysis?.plan?.branches.find((b) => b.nodeId === node.id);
  const side = (s: 'gte' | 'lt', text: string) => {
    const options = branchTargets(g, node.id, s);
    const current = branchSide(g, node.id, s) ?? '';
    return (
      <>
        <label htmlFor={`wf-side-${s}`}>{text}</label>
        <select
          id={`wf-side-${s}`}
          value={current}
          disabled={!props.mayEdit}
          onChange={(e) => d.edit((x) => setBranchTarget(x, node.id, s, e.target.value === '' ? undefined : e.target.value))}
        >
          <option value="">Nothing yet</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {label(o.id)}
            </option>
          ))}
        </select>
      </>
    );
  };
  return (
    <>
      <label htmlFor="wf-threshold">Confidence threshold</label>
      <input
        id="wf-threshold"
        inputMode="decimal"
        value={props.threshold}
        disabled={!props.mayEdit}
        aria-invalid={parsed !== undefined && !Number.isFinite(parsed)}
        onChange={(e) => {
          props.setThreshold(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isFinite(v)) d.edit((x) => updateNode(x, node.id, { config: { threshold: v } }));
        }}
      />
      {parsed !== undefined && !Number.isFinite(parsed) ? (
        <p className="danger-text small" role="alert">
          Enter a number, for example 0.8.
        </p>
      ) : null}
      {note !== undefined ? <p className="muted small">{note}</p> : null}
      {decision !== undefined ? (
        <p className="small" role="status">
          The platform resolves this branch to <strong>{decision.taken === 'gte' ? 'at or above' : 'below'}</strong>: the rule’s declared
          confidence is {decision.value.toFixed(2)} against a threshold of {decision.threshold}. That confidence is fixed per rule, so it
          does not change from run to run.
        </p>
      ) : null}
      {side('gte', 'At or above the threshold, go to')}
      {side('lt', 'Below the threshold, go to')}
    </>
  );
}
