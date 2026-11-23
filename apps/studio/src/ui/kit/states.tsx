import type { ReactNode } from 'react';
import { describeProblem } from '../../domain/review';
import type { ApiProblem } from '../../platform/client';
import type { LoadState } from '../primitives';
import { useModeIfAny } from '../session';
import { Button } from './actions';

/**
 * S1-1 kit states. Every data view has five, and they are distinct: loading (shape only, no invented content), empty (what this
 * is, why it is empty, one next step), partial (what could not be loaded), error (what failed and what to do; input kept) and
 * ready. "Empty" is never shown while loading or after a failure.
 */

/** Shape only, while content is on its way; the label is for assistive technology. No fake numbers or rows of text. */
export function Skeleton(props: { label: string; rows?: number; variant?: 'lines' | 'cards' }) {
  return (
    <div className="k-skeleton" data-variant={props.variant ?? 'lines'} role="status" aria-busy="true">
      <span className="k-visually-hidden">{props.label}</span>
      {Array.from({ length: props.rows ?? 3 }, (_, i) => (
        <span key={i} className="k-skeleton-row" aria-hidden="true" />
      ))}
    </div>
  );
}

export function EmptyState(props: { title: string; children?: ReactNode; action?: ReactNode; headingLevel?: 2 | 3 }) {
  const H = props.headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div className="k-empty">
      <H className="k-empty-title">{props.title}</H>
      {props.children !== undefined ? <p className="k-empty-body">{props.children}</p> : null}
      {props.action !== undefined ? <div className="k-empty-action">{props.action}</div> : null}
    </div>
  );
}

/** What failed, what XO will and will not do next, and a retry. Builder mode adds the platform's own code. */
export function ErrorState(props: { problem: ApiProblem; onRetry?: () => void; retrying?: boolean }) {
  const mode = useModeIfAny();
  const v = describeProblem(props.problem);
  return (
    <div className="k-error-state" role="alert">
      <p className="k-error-state-title">{v.title}</p>
      <p>{v.body}</p>
      <p className="k-hint">{v.next}</p>
      {mode === 'builder' ? (
        <p className="k-tech">
          {[props.problem.kind, props.problem.status !== undefined ? `HTTP ${props.problem.status}` : undefined, props.problem.code]
            .filter(Boolean)
            .join(', ')}
        </p>
      ) : null}
      {props.onRetry !== undefined ? (
        <Button onClick={props.onRetry} loading={props.retrying === true}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** How far a run has got. Determinate only: XO always knows how many items there are. */
export function Progress(props: { label: string; done: number; total: number }) {
  const pct = props.total === 0 ? 0 : Math.round((Math.min(props.done, props.total) / props.total) * 100);
  return (
    <div className="k-progress">
      <div className="k-progress-text">
        <span>{props.label}</span>
        <span>
          {props.done} of {props.total}
        </span>
      </div>
      <div
        className="k-progress-track"
        role="progressbar"
        aria-label={props.label}
        aria-valuemin={0}
        aria-valuemax={props.total}
        aria-valuenow={Math.min(props.done, props.total)}
        aria-valuetext={`${props.done} of ${props.total}`}
      >
        <span className="k-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * The five states of one data view, from a load. `isEmpty` decides empty; `partial` names what could not be loaded alongside a
 * value that did. A failed refresh keeps showing the last good value, with the error above it.
 */
export function DataView<T>(props: {
  state: LoadState<T>;
  loadingLabel: string;
  isEmpty: (v: T) => boolean;
  empty: ReactNode;
  children: (v: T) => ReactNode;
  onRetry?: () => void;
  /** Sources that failed while the rest loaded, in words ("the list of members"). */
  partial?: readonly string[];
}) {
  const s = props.state;
  if (s.phase === 'loading') return <Skeleton label={props.loadingLabel} />;
  if (s.phase === 'error' && s.stale === undefined)
    return <ErrorState problem={s.problem} {...(props.onRetry ? { onRetry: props.onRetry } : {})} />;
  const value = s.phase === 'ready' ? s.value : s.stale!;
  return (
    <>
      {s.phase === 'error' ? <ErrorState problem={s.problem} {...(props.onRetry ? { onRetry: props.onRetry } : {})} /> : null}
      {props.partial !== undefined && props.partial.length > 0 ? (
        <p className="k-partial" role="status">
          Some of this could not be loaded: {props.partial.join(', ')}. What is shown may be incomplete.
        </p>
      ) : null}
      {props.isEmpty(value) && (props.partial === undefined || props.partial.length === 0) ? props.empty : props.children(value)}
    </>
  );
}
