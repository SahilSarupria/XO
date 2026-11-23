import { useId, useMemo, useState, type ReactNode } from 'react';

/**
 * S1-1 kit data display. Status is always words plus a shape; colour only repeats it.
 */

/** One vocabulary for the states of runs, items and workflows. */
export type Status =
  | 'draft'
  | 'ready'
  | 'live'
  | 'paused'
  | 'waiting'
  | 'running'
  | 'attention'
  | 'done'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'left-out'
  | 'unknown';

type Shape = 'dot' | 'ring' | 'check' | 'cross' | 'bar' | 'half' | 'triangle' | 'dash' | 'question' | 'pause';
const STATUS: Readonly<Record<Status, { label: string; tone: 'neutral' | 'accent' | 'positive' | 'attention' | 'danger'; shape: Shape }>> =
  {
    draft: { label: 'Draft', tone: 'neutral', shape: 'dash' },
    ready: { label: 'Ready', tone: 'accent', shape: 'ring' },
    live: { label: 'Live', tone: 'positive', shape: 'dot' },
    paused: { label: 'Paused', tone: 'attention', shape: 'pause' },
    waiting: { label: 'Waiting for a person', tone: 'attention', shape: 'half' },
    running: { label: 'Running', tone: 'accent', shape: 'dot' },
    attention: { label: 'Needs attention', tone: 'attention', shape: 'triangle' },
    done: { label: 'Done', tone: 'positive', shape: 'check' },
    partial: { label: 'Partly done', tone: 'attention', shape: 'half' },
    failed: { label: 'Did not complete', tone: 'danger', shape: 'cross' },
    cancelled: { label: 'Cancelled', tone: 'neutral', shape: 'bar' },
    'left-out': { label: 'Left out', tone: 'neutral', shape: 'dash' },
    unknown: { label: 'Cannot tell', tone: 'attention', shape: 'question' },
  };

function ShapeIcon(props: { shape: Shape }) {
  const p = { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true as const, className: 'k-shape' };
  switch (props.shape) {
    case 'dot':
      return (
        <svg {...p}>
          <circle cx="6" cy="6" r="4" fill="currentColor" />
        </svg>
      );
    case 'ring':
      return (
        <svg {...p}>
          <circle cx="6" cy="6" r="3.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case 'check':
      return (
        <svg {...p}>
          <path
            d="M2 6.5l2.5 2.5L10 3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'cross':
      return (
        <svg {...p}>
          <path d="M3 3l6 6M9 3L3 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case 'half':
      return (
        <svg {...p}>
          <circle cx="6" cy="6" r="3.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 2.25a3.75 3.75 0 0 1 0 7.5z" fill="currentColor" />
        </svg>
      );
    case 'triangle':
      return (
        <svg {...p}>
          <path d="M6 1.75l4.5 8H1.5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
      );
    case 'pause':
      return (
        <svg {...p}>
          <path d="M4 3v6M8 3v6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case 'bar':
      return (
        <svg {...p}>
          <path d="M2.5 9.5l7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case 'question':
      return (
        <svg {...p}>
          <path
            d="M4.25 4.5a1.75 1.75 0 1 1 2.5 1.6c-.5.25-.75.6-.75 1.1M6 9.5v.01"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'dash':
      return (
        <svg {...p}>
          <path d="M3 6h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
  }
}

/** A state, in words with a shape. `label` overrides the standard words when a screen needs more precision. */
export function StatusPill(props: { status: Status; label?: string }) {
  const s = STATUS[props.status];
  return (
    <span className="k-pill" data-tone={s.tone} data-status={props.status}>
      <ShapeIcon shape={s.shape} />
      {props.label ?? s.label}
    </span>
  );
}

export const statusLabel = (s: Status): string => STATUS[s].label;

/**
 * Who does a step: XO (a filled ink disc) or a person (the reviewer's stamp, a square with a tick). The product's two marks,
 * used wherever steps are listed.
 */
export function WhoMark(props: { who: 'xo' | 'person'; showLabel?: boolean }) {
  const label = props.who === 'xo' ? 'XO carries this out' : 'A person decides';
  return (
    <span className="k-who" data-who={props.who}>
      {props.who === 'xo' ? (
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="5" fill="currentColor" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <rect x="1.75" y="1.75" width="10.5" height="10.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M4.5 7.25l1.75 1.75 3.25-3.75"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {props.showLabel === false ? <span className="k-visually-hidden">{label}</span> : <span>{label}</span>}
    </span>
  );
}

/** Label and value pairs (a record's facts). */
export function DescriptionList(props: { items: readonly { term: string; value: ReactNode }[]; columns?: 1 | 2 }) {
  return (
    <dl className="k-dl" data-columns={props.columns ?? 1}>
      {props.items.map((i) => (
        <div key={i.term} className="k-dl-row">
          <dt>{i.term}</dt>
          <dd>{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Where something came from: the source's own words, with the source's name and page. */
export function EvidenceQuote(props: { quote: string; source: string; page?: number; onOpen?: () => void }) {
  return (
    <figure className="k-evidence">
      <blockquote className="k-evidence-quote">{props.quote}</blockquote>
      <figcaption className="k-evidence-source">
        {props.onOpen !== undefined ? (
          <button type="button" className="k-link" onClick={props.onOpen}>
            {props.source}
          </button>
        ) : (
          props.source
        )}
        {props.page !== undefined ? <span>, page {props.page}</span> : null}
      </figcaption>
    </figure>
  );
}

/** What happened, in order, in plain words (a run's journal). The newest entry is last. */
export function Timeline(props: { items: readonly { id: string; when: string; text: ReactNode; status?: Status }[]; label: string }) {
  return (
    <ol className="k-timeline" aria-label={props.label}>
      {props.items.map((i) => (
        <li key={i.id} className="k-timeline-item" data-status={i.status}>
          <span className="k-timeline-dot" aria-hidden="true" />
          <div>
            <p className="k-timeline-text">{i.text}</p>
            <p className="k-timeline-when">{i.when}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** "3 sent · 1 left out": counts, with words, in the order given; zero counts are left out unless `keepZero`. */
export function CountSummary(props: { counts: readonly { n: number; one: string; many: string; status?: Status }[]; keepZero?: boolean }) {
  const shown = props.counts.filter((c) => c.n > 0 || props.keepZero === true);
  return (
    <p className="k-counts">
      {shown.map((c, i) => (
        <span key={c.many} className="k-count" data-status={c.status}>
          <strong>{c.n}</strong> {c.n === 1 ? c.one : c.many}
          {i < shown.length - 1 ? <span aria-hidden="true" className="k-count-sep" /> : null}
        </span>
      ))}
    </p>
  );
}

export interface Column<T> {
  readonly id: string;
  readonly header: string;
  readonly cell: (row: T) => ReactNode;
  /** Present when the column can be sorted; returns the value to sort by. */
  readonly sortValue?: (row: T) => string | number;
  /** Shown as the card's title on a phone. One column should set it. */
  readonly primary?: boolean;
}

/**
 * A table of records: sortable columns, pages, and an action per row. On a phone each row becomes a card (CSS only), with the
 * primary column as its title and every other column labelled. The caller passes one page of the platform's results; the
 * platform pages (Studio never pretends a page is the whole list).
 */
export function DataTable<T>(props: {
  caption: string;
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  rowAction?: (row: T) => ReactNode;
  /** Shown under the table when the platform has more. */
  onMore?: () => void;
  moreLabel?: string;
}) {
  const [sort, setSort] = useState<{ id: string; dir: 'ascending' | 'descending' } | undefined>();
  const captionId = useId();
  const rows = useMemo(() => {
    const col = props.columns.find((c) => c.id === sort?.id);
    if (sort === undefined || col?.sortValue === undefined) return props.rows;
    const v = col.sortValue;
    const sorted = [...props.rows].sort((a, b) => {
      const x = v(a);
      const y = v(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    return sort.dir === 'ascending' ? sorted : sorted.reverse();
  }, [props.rows, props.columns, sort]);
  return (
    <div className="k-table-wrap">
      <table className="k-table" aria-labelledby={captionId}>
        <caption id={captionId} className="k-table-caption">
          {props.caption}
        </caption>
        <thead>
          <tr>
            {props.columns.map((c) => (
              <th key={c.id} scope="col" aria-sort={sort?.id === c.id ? sort.dir : undefined}>
                {c.sortValue !== undefined ? (
                  <button
                    type="button"
                    className="k-sort"
                    onClick={() =>
                      setSort((s) => ({ id: c.id, dir: s?.id === c.id && s.dir === 'ascending' ? 'descending' : 'ascending' }))
                    }
                  >
                    {c.header}
                    <span className="k-sort-mark" aria-hidden="true">
                      {sort?.id === c.id ? (sort.dir === 'ascending' ? '↑' : '↓') : '↕'}
                    </span>
                  </button>
                ) : (
                  c.header
                )}
              </th>
            ))}
            {props.rowAction !== undefined ? (
              <th scope="col">
                <span className="k-visually-hidden">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={props.rowKey(r)}>
              {props.columns.map((c) =>
                c.primary === true ? (
                  <th key={c.id} scope="row" data-label={c.header} className="k-table-primary">
                    {c.cell(r)}
                  </th>
                ) : (
                  <td key={c.id} data-label={c.header}>
                    {c.cell(r)}
                  </td>
                ),
              )}
              {props.rowAction !== undefined ? <td className="k-table-action">{props.rowAction(r)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
      {props.onMore !== undefined ? (
        <div className="k-row">
          <button type="button" className="k-btn k-btn-secondary k-btn-md" onClick={props.onMore}>
            <span>{props.moreLabel ?? 'Show more'}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
