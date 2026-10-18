import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { ApiProblem, Result } from '../platform/client';
import { describeProblem, type OutcomeTone } from '../domain/review';
import { useModeIfAny } from './session';

/**
 * `pending` is for an action that is in flight or just landed: the button is announced as unavailable
 * (`aria-disabled`) and ignores clicks, but stays focusable so keyboard and screen-reader users do not lose
 * their place. Use `disabled` only for something that genuinely cannot be done.
 */
export function Button(
  props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'quiet' | 'danger'; pending?: boolean },
) {
  const { variant = 'secondary', className = '', pending = false, onClick, ...rest } = props;
  return (
    <button
      type="button"
      {...rest}
      {...(pending ? { 'aria-disabled': true } : {})}
      onClick={pending ? undefined : onClick}
      className={`btn btn-${variant} ${className}`.trim()}
    />
  );
}

export function Badge(props: { tone: OutcomeTone | 'accent'; children: ReactNode }) {
  return <span className={`badge badge-${props.tone}`}>{props.children}</span>;
}

export function Spinner(props: { label: string }) {
  return (
    <span className="spinner" role="status">
      <span className="spinner-dot" aria-hidden="true" />
      {props.label}
    </span>
  );
}

/**
 * Placeholder for content that is on its way. It claims nothing about the content (no numbers, no fake rows of data):
 * only shape, plus a text label for assistive technology. Use Spinner for an action in flight.
 */
export function Skeleton(props: { label: string; rows?: number }) {
  return (
    <div className="skeleton" role="status" aria-busy="true">
      <span className="visually-hidden">{props.label}</span>
      {Array.from({ length: props.rows ?? 3 }, (_, i) => (
        <span key={i} className="skeleton-row" aria-hidden="true" />
      ))}
    </div>
  );
}

export function EmptyState(props: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{props.title}</h3>
      {props.children !== undefined ? <p>{props.children}</p> : null}
    </div>
  );
}

/** Every failure is shown with what happened and what to do next. Builder Mode adds the raw platform detail. */
export function ProblemNotice(props: { problem: ApiProblem; onRetry?: () => void }) {
  const mode = useModeIfAny();
  const v = describeProblem(props.problem);
  return (
    <div className="notice notice-danger" role="alert">
      <strong>{v.title}</strong>
      <p>{v.body}</p>
      <p className="muted">{v.next}</p>
      {mode === 'builder' ? (
        <p className="mono small">
          {props.problem.kind}
          {props.problem.status !== undefined ? ` · HTTP ${props.problem.status}` : ''}
          {props.problem.code !== undefined ? ` · ${props.problem.code}` : ''}
        </p>
      ) : null}
      {props.onRetry !== undefined ? (
        <Button variant="secondary" onClick={props.onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export type LoadState<T> =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly value: T }
  /** `stale` is the last good value, kept when a REFRESH fails so the screen does not go blank. */
  | { readonly phase: 'error'; readonly problem: ApiProblem; readonly stale?: T };

/** The value to render: fresh, or the last good one after a failed refresh. Undefined only if nothing ever loaded. */
export function loadedValue<T>(state: LoadState<T>): T | undefined {
  return state.phase === 'ready' ? state.value : state.phase === 'error' ? state.stale : undefined;
}

/**
 * Loads on mount and whenever `deps` change. `reload` refetches the SAME inputs without flashing back to loading and,
 * if that refresh fails, keeps the last good value as `stale`. A change of `deps` means different inputs, so nothing
 * from the previous inputs is kept: a value loaded for another analysis must never stand in for this one.
 */
export function useLoad<T>(fn: () => Promise<Result<T>>, deps: readonly unknown[]): { state: LoadState<T>; reload: () => void } {
  const [state, setState] = useState<LoadState<T>>({ phase: 'loading' });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const prevDeps = useRef<readonly unknown[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const previous = prevDeps.current;
    prevDeps.current = deps;
    const inputsChanged = previous !== undefined && (previous.length !== deps.length || previous.some((d, i) => !Object.is(d, deps[i])));
    if (inputsChanged) setState({ phase: 'loading' });
    void fnRef.current().then((r) => {
      if (cancelled) return;
      setState((prev) => {
        if (r.ok) return { phase: 'ready', value: r.value };
        const stale = loadedValue(prev);
        return { phase: 'error', problem: r.problem, ...(stale !== undefined ? { stale } : {}) };
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { state, reload: () => setTick((t) => t + 1) };
}

/** Page title, optional one-line explanation and page-level actions. Layout only. */
export function PageHeader(props: { title: string; lede?: string; actions?: ReactNode; id?: string }) {
  return (
    <header className="section-head">
      <div>
        <h2 id={props.id}>{props.title}</h2>
        {props.lede !== undefined ? <p className="lede">{props.lede}</p> : null}
      </div>
      {props.actions !== undefined ? <div className="section-actions">{props.actions}</div> : null}
    </header>
  );
}

/** Where the person is. The last item is the current page and is not a link. Presentation only. */
export function Breadcrumbs(props: {
  /** `low`: dropped on narrow screens, where the same name is already the page title directly below. */
  items: readonly { label: string; onSelect?: () => void; low?: boolean }[];
}) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <ol>
        {props.items.map((item, i) => {
          const last = i === props.items.length - 1;
          return (
            <li
              key={`${i}-${item.label}`}
              className={item.low === true ? 'crumb-low' : undefined}
              {...(last ? { 'aria-current': 'page' as const } : {})}
            >
              {!last && item.onSelect !== undefined ? (
                <button type="button" className="crumb-link" onClick={item.onSelect}>
                  {item.label}
                </button>
              ) : (
                <span>{item.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Switches between closely related views of one page. Each choice selects a screen; it grants nothing. */
export function SubNav(props: {
  label: string;
  /** `tabs` switches between views of a page; `chips` filters the list on the page (same look as the Review filter). */
  variant?: 'tabs' | 'chips';
  current: string;
  items: readonly { id: string; label: string; count?: number | undefined; countLabel?: string; onSelect: () => void }[];
}) {
  const chips = props.variant === 'chips';
  return (
    <div className={chips ? 'summary' : 'segmented'} role="group" aria-label={props.label}>
      {props.items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={chips ? 'chip' : 'tab'}
          aria-pressed={props.current === item.id}
          onClick={item.onSelect}
        >
          {item.label}
          {item.count !== undefined && (chips || item.count > 0) ? (
            <span className={chips ? 'chip-n' : 'tab-count'} aria-label={`${item.count} ${item.countLabel ?? 'need attention'}`}>
              {item.count}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export function Section(props: { title: string; lede?: string; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="section" aria-labelledby={props.id}>
      <PageHeader
        title={props.title}
        {...(props.lede !== undefined ? { lede: props.lede } : {})}
        {...(props.actions !== undefined ? { actions: props.actions } : {})}
        {...(props.id !== undefined ? { id: props.id } : {})}
      />
      {props.children}
    </section>
  );
}

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function useToggle(initial = false): [boolean, () => void] {
  const [v, setV] = useState(initial);
  return [v, () => setV((x) => !x)];
}
