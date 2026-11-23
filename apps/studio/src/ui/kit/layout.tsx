import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

/**
 * S1-1 kit layout parts. Presentation only: none of them decides what a person may do.
 */

/** The top of a page: its one level-1 heading, an optional status beside it, one line of explanation and the primary action. */
export function PageHeader(props: {
  title: string;
  status?: ReactNode;
  lede?: string;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
  headingId?: string;
}) {
  return (
    <header className="k-page-head">
      {props.breadcrumb}
      <div className="k-page-head-row">
        <div className="k-page-head-text">
          <div className="k-page-title-row">
            <h1 id={props.headingId} className="k-page-title" tabIndex={-1}>
              {props.title}
            </h1>
            {props.status}
          </div>
          {props.lede !== undefined ? <p className="k-lede">{props.lede}</p> : null}
        </div>
        {props.actions !== undefined ? <div className="k-page-actions">{props.actions}</div> : null}
      </div>
    </header>
  );
}

export interface TabItem {
  readonly id: string;
  readonly label: string;
  /** A count shown after the label, with words for screen readers. */
  readonly count?: number;
  readonly countLabel?: string;
}

/**
 * Tabs that switch between views of one thing (WAI-ARIA tabs: arrow keys move and select, Home and End jump). The panel is the
 * caller's: render it with `tabPanelProps(id)` so it is labelled by its tab.
 */
export function Tabs(props: {
  label: string;
  items: readonly TabItem[];
  current: string;
  onSelect: (id: string) => void;
  idBase?: string;
}) {
  const auto = useId();
  const base = props.idBase ?? `t${auto}`;
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const move = (e: KeyboardEvent, index: number) => {
    const n = props.items.length;
    const to =
      e.key === 'ArrowRight'
        ? (index + 1) % n
        : e.key === 'ArrowLeft'
          ? (index - 1 + n) % n
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? n - 1
              : -1;
    if (to < 0) return;
    e.preventDefault();
    const id = props.items[to]!.id;
    props.onSelect(id);
    refs.current.get(id)?.focus();
  };
  return (
    <div className="k-tabs" role="tablist" aria-label={props.label}>
      {props.items.map((t, i) => {
        const selected = t.id === props.current;
        return (
          <button
            key={t.id}
            ref={(el) => {
              if (el !== null) refs.current.set(t.id, el);
              else refs.current.delete(t.id);
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-selected={selected}
            aria-controls={`${base}-panel-${t.id}`}
            tabIndex={selected ? 0 : -1}
            className="k-tab"
            onClick={() => props.onSelect(t.id)}
            onKeyDown={(e) => move(e, i)}
          >
            {t.label}
            {t.count !== undefined ? (
              <span className="k-tab-count" aria-label={`, ${t.count} ${t.countLabel ?? ''}`.trimEnd()}>
                {t.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function tabPanelProps(idBase: string, id: string) {
  return { role: 'tabpanel' as const, id: `${idBase}-panel-${id}`, 'aria-labelledby': `${idBase}-tab-${id}`, tabIndex: 0 };
}

/** A surface that groups one thing. `as="section"` with a title makes it a labelled region. */
export function Card(props: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
  as?: 'div' | 'section' | 'article';
  tone?: 'plain' | 'quiet';
}) {
  const id = useId();
  const Tag = props.as ?? 'div';
  return (
    <Tag className="k-card" data-tone={props.tone ?? 'plain'} aria-labelledby={props.title !== undefined && Tag !== 'div' ? id : undefined}>
      {props.title !== undefined || props.actions !== undefined ? (
        <div className="k-card-head">
          {props.title !== undefined ? (
            <h2 id={id} className="k-card-title">
              {props.title}
            </h2>
          ) : null}
          {props.actions}
        </div>
      ) : null}
      {props.children}
    </Tag>
  );
}

/** Details on demand (native <details>, so it works without script and with every assistive technology). */
export function Disclosure(props: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="k-disclosure" open={props.defaultOpen}>
      <summary className="k-disclosure-summary">{props.summary}</summary>
      <div className="k-disclosure-body">{props.children}</div>
    </details>
  );
}

export type BannerTone = 'info' | 'attention' | 'danger' | 'positive';

/**
 * A message about the whole screen or workspace (a stop, a degraded service, a version mismatch). `danger` is announced
 * assertively; the others politely. It says what happened, then what to do.
 */
export function Banner(props: { tone: BannerTone; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="k-banner" data-tone={props.tone} role={props.tone === 'danger' ? 'alert' : 'status'}>
      <span className="k-banner-mark" aria-hidden="true" data-tone={props.tone} />
      <div className="k-banner-text">
        <p className="k-banner-title">{props.title}</p>
        {props.children !== undefined ? <div className="k-banner-body">{props.children}</div> : null}
      </div>
      {props.action !== undefined ? <div className="k-banner-action">{props.action}</div> : null}
    </div>
  );
}

/** Where the person is. The last item is the current page and is not a link. */
export function Breadcrumb(props: { items: readonly { label: string; href?: string; onSelect?: () => void }[] }) {
  return (
    <nav className="k-crumbs" aria-label="Breadcrumb">
      <ol>
        {props.items.map((item, i) => {
          const last = i === props.items.length - 1;
          return (
            <li key={`${i}-${item.label}`} aria-current={last ? 'page' : undefined}>
              {last ? (
                <span>{item.label}</span>
              ) : item.href !== undefined ? (
                <a href={item.href} onClick={item.onSelect !== undefined ? (e) => (e.preventDefault(), item.onSelect!()) : undefined}>
                  {item.label}
                </a>
              ) : (
                <button type="button" className="k-link" onClick={item.onSelect}>
                  {item.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
