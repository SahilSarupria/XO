import { useEffect, useRef, useState } from 'react';
import type { WorkflowSummary } from '../domain/workflowSummary';
import { Icon } from './icons';

/** One workflow, with everything the page knows about it on one card. The whole card opens the details panel. */
export function WorkflowCard(props: {
  s: WorkflowSummary;
  selected: boolean;
  /** Everything is paused: a live workflow is not running, so it must not look like it is. */
  halted?: boolean;
  onOpen: (id: string, opener: HTMLElement) => void;
  onGraph: (id: string) => void;
}) {
  const { s } = props;
  const n = s.workflow.stepCount;
  const week = s.week;
  const max = Math.max(1, ...week.perDay);
  const points = week.perDay.map((v, i) => `${2 + i * 11.6},${24 - (v / max) * 20}`).join(' ');
  const xoPct = s.split === undefined || n === 0 ? 0 : (s.split.xo / n) * 100;
  const personPct = s.split === undefined || n === 0 ? 0 : (s.split.person / n) * 100;

  return (
    <li
      className="wc"
      data-selected={props.selected}
      data-active={s.active !== undefined}
      data-live={s.status.mode === 'live' && props.halted !== true}
    >
      <div className="wc-head">
        <div className="wc-name">
          <h3>
            {/* The title is the one real control for the card; its ::after stretches over the whole card. */}
            <button
              type="button"
              className="wc-open"
              data-wf-open={s.id}
              aria-haspopup="dialog"
              onClick={(e) => props.onOpen(s.id, e.currentTarget)}
            >
              {s.title}
            </button>
          </h3>
          <p className="wc-sub">{s.sub}</p>
        </div>
        <span
          className="wc-status"
          data-tone={s.status.tone}
          data-mode={s.status.mode}
          title={
            s.status.mode === 'shadow'
              ? 'Shadow: it practises on real cases and stops before any step that needs a person. Nobody is asked.'
              : undefined
          }
        >
          {s.status.label}
        </span>
        <CardMenu title={s.title} onOpen={(el) => props.onOpen(s.id, el)} onGraph={() => props.onGraph(s.id)} />
      </div>

      <div className="wc-grid">
        <div className="wc-field">
          <span className="wc-label">Starts when</span>
          <ul className="wc-chips">
            {s.triggers.map((t) => (
              <li
                key={t.kind}
                data-active={t.active}
                title={
                  t.kind === 'manual'
                    ? 'Someone starts it from the Workflows page.'
                    : t.active
                      ? 'Switched on and firing.'
                      : 'Switched on, but waiting: it fires only while the workflow is practising or live and nothing is paused.'
                }
              >
                <Icon name={t.kind === 'manual' ? 'play' : t.kind === 'webhook' ? 'link' : 'bolt'} size={14} />
                {t.label}
                {t.kind !== 'manual' && !t.active ? <span className="wc-waiting"> (waiting)</span> : null}
              </li>
            ))}
          </ul>
        </div>
        <div className="wc-field">
          <span className="wc-label">Last 7 days</span>
          {week.total === 0 ? (
            <span className="wc-muted">{s.lastRun === undefined ? 'Not run yet' : 'No runs this week'}</span>
          ) : (
            <span className="wc-spark">
              <svg
                viewBox="0 0 74 26"
                width="84"
                height="30"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points={points} />
              </svg>
              {week.total} {week.total === 1 ? 'run' : 'runs'}
            </span>
          )}
        </div>
        <div className="wc-field wc-wide">
          <span className="wc-label">Who does the work</span>
          {s.split === undefined ? (
            <span className="wc-muted">Not available yet</span>
          ) : (
            <>
              <div
                className="wc-bar"
                role="img"
                aria-label={`${s.split.xo} of ${n} steps XO carries out, ${s.split.person} a person decides`}
              >
                <span data-who="xo" style={{ width: `${xoPct}%` }} />
                <span data-who="person" style={{ width: `${personPct}%` }} />
              </div>
              <p className="wc-barnote">
                <b>
                  {s.split.xo} of {n}
                </b>{' '}
                {n === 1 ? 'step' : 'steps'} XO carries out · {s.split.person} a person decides
              </p>
            </>
          )}
        </div>
      </div>

      <div className="wc-foot">
        <span className="wc-label">Needs you</span>
        <span className="wc-chip" data-tone={s.need.tone}>
          {s.need.text}
        </span>
        <span className="wc-go" aria-hidden="true">
          Open <Icon name="chevron" size={14} />
        </span>
      </div>
    </li>
  );
}

function CardMenu(props: { title: string; onOpen: (opener: HTMLElement) => void; onGraph: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (root.current !== null && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  return (
    <div
      className="wc-menu"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="wc-more"
        aria-label={`More actions for ${props.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="dots" size={20} />
      </button>
      {open ? (
        <div role="menu" className="wc-menu-list" aria-label={`Actions for ${props.title}`}>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              props.onOpen(trigger.current ?? document.body);
            }}
          >
            See details
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              props.onGraph();
            }}
          >
            Open the graph
          </button>
        </div>
      ) : null}
    </div>
  );
}
