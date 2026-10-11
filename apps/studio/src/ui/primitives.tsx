import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { ApiProblem, Result } from '../platform/client';
import { describeProblem, type OutcomeTone } from '../domain/review';
import { useModeIfAny } from './session';

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'quiet' | 'danger' }) {
  const { variant = 'secondary', className = '', ...rest } = props;
  return <button type="button" {...rest} className={`btn btn-${variant} ${className}`.trim()} />;
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
  | { readonly phase: 'error'; readonly problem: ApiProblem };

/** Loads on mount and whenever `deps` change; `reload` refetches without flashing back to loading. */
export function useLoad<T>(fn: () => Promise<Result<T>>, deps: readonly unknown[]): { state: LoadState<T>; reload: () => void } {
  const [state, setState] = useState<LoadState<T>>({ phase: 'loading' });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const first = useRef(true);

  useEffect(() => {
    let cancelled = false;
    if (first.current) first.current = false;
    else setState((s) => (s.phase === 'ready' ? s : { phase: 'loading' }));
    void fnRef.current().then((r) => {
      if (cancelled) return;
      setState(r.ok ? { phase: 'ready', value: r.value } : { phase: 'error', problem: r.problem });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { state, reload: () => setTick((t) => t + 1) };
}

export function Section(props: { title: string; lede?: string; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="section" aria-labelledby={props.id}>
      <header className="section-head">
        <div>
          <h2 id={props.id}>{props.title}</h2>
          {props.lede !== undefined ? <p className="lede">{props.lede}</p> : null}
        </div>
        {props.actions !== undefined ? <div className="section-actions">{props.actions}</div> : null}
      </header>
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
