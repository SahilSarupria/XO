import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { countFilters, matchesQuery, needItems, summarizeWorkflow, type FilterKey } from '../domain/workflowSummary';
import type { Capability, Compilation, Workflow, WorkflowControls, WorkflowRun, WorkspaceRole } from '../platform/wire';
import { Icon } from './icons';
import { Button, EmptyState, Section } from './primitives';
import { WorkflowCard } from './WorkflowCards';
import { WorkflowPanel } from './WorkflowPanel';
import { WorkspacePause } from './WorkspacePause';
import '../styles/workflows.css';

/**
 * Processes that can be started, and the ones already underway.
 *
 * Starting is guarded in the browser only: the panel checks the platform for an existing active run
 * immediately before it sends a start, locks the button while the request is in flight, and after an
 * unclear failure re-reads the platform's state. That reduces accidental duplicates. It does NOT
 * guarantee exactly-once: the platform has no idempotency key, so two tabs, two people or a retry
 * outside Studio can still create two runs.
 *
 * What is shown for each workflow comes only from what the platform reports (see `workflowSummary`). The open
 * workflow is kept in the URL fragment (`#/work/<id>`) so a refresh or a copied link returns to it; that is
 * presentation only and grants nothing.
 */
const OPEN = /^#\/work\/([^/?#]+)/;
const readOpen = (): string | undefined => {
  const m = OPEN.exec(window.location.hash);
  if (m?.[1] === undefined) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return undefined;
  }
};

const FILTERS: readonly { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'needs', label: 'Needs you' },
  { key: 'inprogress', label: 'In progress' },
  { key: 'ready', label: 'Ready to start' },
  { key: 'blocked', label: 'Can’t run yet' },
  { key: 'live', label: 'Live' },
  { key: 'shadow', label: 'Shadow' },
  { key: 'paused', label: 'Paused' },
];

export function WorkSection(props: {
  workspaceId: string;
  compilation: Compilation | undefined;
  workflows: readonly Workflow[];
  caps: readonly Capability[] | undefined;
  /** The capability list failed to load, so approvals cannot be checked. Distinct from "still loading". */
  capsFailed: boolean;
  runs: readonly WorkflowRun[];
  /** Mode, triggers, limit, sign-off and the workspace pause, when the platform reports them. */
  controls?: WorkflowControls | undefined;
  role?: WorkspaceRole | undefined;
  onChanged: () => void;
  goToSetup: () => void;
  goToTasks: () => void;
  goToActivity: () => void;
  onOpenGraph: (workflowId: string) => void;
}) {
  const here = useMemo(
    () => props.workflows.filter((w) => props.compilation !== undefined && w.compilationId === props.compilation.compilationId),
    [props.workflows, props.compilation],
  );
  const summaries = useMemo(
    () =>
      here.map((w) =>
        summarizeWorkflow(
          w,
          props.caps,
          props.capsFailed,
          props.runs,
          Date.now(),
          props.controls?.deployments.find((d) => d.workflowId === w.workflowId && d.compilationId === w.compilationId),
          props.controls?.paused === true,
        ),
      ),
    [here, props.caps, props.capsFailed, props.runs, props.controls],
  );
  const counts = useMemo(() => countFilters(summaries), [summaries]);
  const needs = useMemo(() => needItems(summaries), [summaries]);

  const [filter, setFilter] = useState<FilterKey>('all');
  const [q, setQ] = useState('');
  const active: FilterKey = counts[filter] === 0 ? 'all' : filter;
  const shown = summaries.filter((s) => s.filters.has(active) && matchesQuery(s, q));

  const [openId, setOpenId] = useState<string | undefined>(readOpen);
  const opener = useRef<HTMLElement | undefined>(undefined);
  useEffect(() => {
    const sync = () => setOpenId(readOpen());
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);
  const open = useCallback((id: string, from: HTMLElement) => {
    opener.current = from;
    window.history.replaceState(null, '', `#/work/${encodeURIComponent(id)}`);
    setOpenId(id);
  }, []);
  const close = useCallback(() => {
    const id = openId;
    window.history.replaceState(null, '', '#/work');
    setOpenId(undefined);
    // Put the keyboard back where it was. The opener may have gone (a menu), so fall back to the card's own title.
    window.setTimeout(() => {
      const el =
        opener.current?.isConnected === true ? opener.current : document.querySelector<HTMLElement>(`[data-wf-open="${id ?? ''}"]`);
      el?.focus();
    }, 0);
  }, [openId]);
  const openSummary = summaries.find((s) => s.id === openId);

  const header = (
    <Button variant="primary" onClick={props.goToSetup}>
      <Icon name="plus" size={16} /> New workflow
    </Button>
  );

  return (
    <Section
      id="work-h"
      title="Workflows"
      lede="These are the jobs XO found in your documents. Nothing starts until you start it, and a person decides wherever XO is not sure."
      actions={props.compilation !== undefined && here.length > 0 ? header : undefined}
    >
      {props.compilation === undefined ? (
        <FirstTime goToSetup={props.goToSetup} />
      ) : here.length === 0 ? (
        <EmptyState title="XO did not find a process in this document">
          It found rules, but could not put them in a sequence. You can still review the individual rules in Sources.
        </EmptyState>
      ) : (
        <>
          {props.controls !== undefined ? (
            <WorkspacePause workspaceId={props.workspaceId} controls={props.controls} role={props.role} onChanged={props.onChanged} />
          ) : null}
          {needs.length > 0 ? (
            <section className="wn" aria-labelledby="wn-h">
              <h3 id="wn-h">{needs.length === 1 ? '1 thing needs you' : `${needs.length} things need you`}</h3>
              <p className="wn-sub">Nothing is stuck. These are waiting for your decision.</p>
              <ul>
                {needs.slice(0, 3).map((n) => (
                  <li key={`${n.workflowId}-${n.kind}`}>
                    <span className="wn-ic" data-kind={n.kind} aria-hidden="true">
                      <Icon name={n.kind === 'failed' ? 'warn' : n.kind === 'rules' ? 'key' : 'user'} size={20} />
                    </span>
                    <div className="wn-text">
                      {n.sentence}
                      <small>{n.title}</small>
                    </div>
                    <Button
                      variant={n === needs[0] ? 'primary' : 'secondary'}
                      onClick={
                        n.kind === 'decision'
                          ? props.goToTasks
                          : n.kind === 'failed'
                            ? props.goToActivity
                            : n.kind === 'practice'
                              ? () => {
                                  const el = document.querySelector<HTMLElement>(`[data-wf-open="${n.workflowId}"]`);
                                  if (el !== null) open(n.workflowId, el);
                                }
                              : props.goToSetup
                      }
                    >
                      {n.action}
                    </Button>
                  </li>
                ))}
              </ul>
              {needs.length > 3 ? <p className="wn-more">And {needs.length - 3} more. Choose “Needs you” below to see them all.</p> : null}
            </section>
          ) : null}

          <div className="wf-filters">
            <div className="wf-pills" role="group" aria-label="Filter workflows">
              {FILTERS.filter((f) => f.key === 'all' || counts[f.key] > 0).map((f) => (
                <button key={f.key} type="button" aria-pressed={active === f.key} onClick={() => setFilter(f.key)}>
                  {f.label} <small>{counts[f.key]}</small>
                </button>
              ))}
            </div>
            {summaries.length >= 5 ? (
              <div className="wf-search">
                <Icon name="search" size={18} />
                <label className="visually-hidden" htmlFor="wf-q">
                  Search workflows
                </label>
                <input id="wf-q" value={q} placeholder="Search" onChange={(e) => setQ(e.target.value)} />
              </div>
            ) : null}
          </div>

          {shown.length === 0 ? (
            <p className="muted">No workflow matches. Clear the search or choose “All”.</p>
          ) : (
            <ul className="wc-grid-list" aria-label="Workflows">
              {shown.map((s) => (
                <WorkflowCard
                  key={s.id}
                  s={s}
                  selected={s.id === openId}
                  halted={props.controls?.paused === true}
                  onOpen={open}
                  onGraph={props.onOpenGraph}
                />
              ))}
            </ul>
          )}

          <p className="wf-legend">
            <span>
              <i data-who="xo" /> XO carries it out
            </span>
            <span>
              <i data-who="person" /> A person decides
            </span>
          </p>
          <p className="wf-note">
            The bar shows who carries out each step, not how accurate it is. XO’s accuracy on your documents has not been measured yet.
          </p>
        </>
      )}

      {openSummary !== undefined ? (
        <WorkflowPanel
          key={openSummary.id}
          workspaceId={props.workspaceId}
          s={openSummary}
          caps={props.caps}
          capsFailed={props.capsFailed}
          runs={props.runs}
          role={props.role}
          allPaused={props.controls?.paused === true}
          onClose={close}
          onChanged={props.onChanged}
          goToSetup={props.goToSetup}
          goToTasks={props.goToTasks}
          goToActivity={props.goToActivity}
          onOpenGraph={props.onOpenGraph}
        />
      ) : null}
    </Section>
  );
}

/** Nothing analysed yet: say what happens next in four plain steps, and offer the one thing to do. */
function FirstTime(props: { goToSetup: () => void }) {
  const steps = [
    { n: 1, t: 'Add a document', d: 'A policy, a checklist or a how-to guide' },
    { n: 2, t: 'Check the rules', d: 'Confirm what XO understood' },
    { n: 3, t: 'Start the process', d: 'XO does the steps it can; a person decides the rest' },
    { n: 4, t: 'See what happened', d: 'Every run is recorded for you to review' },
  ];
  return (
    <div className="wf-first">
      <h3>Let’s set up your first workflow</h3>
      <p>
        XO reads your documents, finds the steps in them, and can do those steps for you. A person always stays in charge of anything XO is
        not sure about.
      </p>
      <ol>
        {steps.map((s) => (
          <li key={s.n} data-now={s.n === 1}>
            <span aria-hidden="true">{s.n}</span>
            <b>{s.t}</b>
            <small>{s.d}</small>
          </li>
        ))}
      </ol>
      <Button variant="primary" className="btn-lg" onClick={props.goToSetup}>
        <Icon name="plus" size={16} /> Add your first document
      </Button>
    </div>
  );
}
