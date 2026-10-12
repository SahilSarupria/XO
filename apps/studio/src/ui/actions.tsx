import { useCallback, useEffect, useRef, useState } from 'react';
import { type WorkProblemView } from '../domain/work';
import type { ApiProblem } from '../platform/client';
import { ProblemNotice } from './primitives';
import type { ReactNode } from 'react';

/**
 * What a guarded action reports back: `settle` holds the controls briefly after a CONFIRMED success, because
 * the same buttons often mean a different step a moment later and one physical double click must not decide two.
 */
export interface GuardOutcome {
  readonly settle?: boolean;
}

/**
 * One in-flight action per component, with the two protections every state-changing button here needs:
 * a ref (not state) so two clicks in the same tick cannot both pass, and a short settle period after success.
 * Timers are cleared on unmount, and nothing sets state after unmount.
 */
export function useGuardedAction(settleMs = 700): {
  run: (fn: () => Promise<GuardOutcome | void>) => Promise<void>;
  busy: boolean;
  settling: boolean;
} {
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [settling, setSettling] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== undefined) clearTimeout(timer.current);
    };
  }, []);

  const run = useCallback(
    async (fn: () => Promise<GuardOutcome | void>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      if (mounted.current) setBusy(true);
      try {
        const outcome = await fn();
        if (outcome?.settle === true && mounted.current) {
          setSettling(true);
          timer.current = setTimeout(() => {
            if (mounted.current) setSettling(false);
          }, settleMs);
        }
      } finally {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [settleMs],
  );

  return { run, busy, settling };
}

/** The three ways an action can end badly, in one shape so every card renders and reasons about them the same way. */
export type ActionNotice = { readonly view: WorkProblemView } | { readonly info: string } | { readonly problem: ApiProblem };

/** Renders an ActionNotice. `action` is an optional follow-up control shown with a `view` notice. */
export function ActionNoticeView(props: { notice: ActionNotice | undefined; action?: ReactNode }) {
  const n = props.notice;
  if (n === undefined) return null;
  if ('problem' in n) return <ProblemNotice problem={n.problem} />;
  if ('info' in n)
    return (
      <p className="notice notice-warning" role="alert">
        {n.info}
      </p>
    );
  return (
    <div className="notice notice-warning" role="alert">
      <strong>{n.view.title}</strong>
      <p>{n.view.body}</p>
      {n.view.items.length > 0 ? (
        <ul className="plain">
          {n.view.items.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      ) : null}
      {props.action}
    </div>
  );
}

/** Polite confirmation for a server-confirmed result. Rendered only after the platform said yes. */
export function Confirmation(props: { message: string | undefined }) {
  return (
    <p className="muted small" role="status">
      {props.message ?? ''}
    </p>
  );
}
