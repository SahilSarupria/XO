import { useState } from 'react';
import { can, whyNot } from '../domain/access';
import type { ApiProblem } from '../platform/client';
import type { WorkspaceRole } from '../platform/wire';
import type { EmergencyStopView } from '../platform/wire-control';
import { useGuardedAction } from './actions';
import { Button, formatWhen, loadedValue, ProblemNotice, Skeleton } from './primitives';
import { useQuery, wsKey } from '../platform/query';
import { useSession } from './session';

const SCOPE_WORDS = { workflow: 'A workflow', connector: 'A connection', capability: 'One thing a connection does' } as const;
const TARGET_HINT = {
  workflow: 'Which workflow',
  connector: 'Which connection',
  capability: 'Which one',
} as const;

/** What a stop is on, in words: a workflow by its name, a connection or one of its actions as the platform names it. */
const labelOf = (s: { scope: EmergencyStopView['scope']; target: string }, names: ReadonlyMap<string, string>): string =>
  s.scope === 'workflow' ? (names.get(s.target) ?? 'A workflow') : s.target.replace('.', ': ').replace(/_/g, ' ');

const whatItStops = (s: EmergencyStopView, label: string): string =>
  s.scope === 'workflow'
    ? `${label} cannot start or continue any run.`
    : s.scope === 'connector'
      ? `Nothing in this workspace can use ${label}.`
      : `${label} cannot be used by any run.`;

/**
 * UW-12b (ADR 0052) — emergency stops, under Settings → Operations. A stop is immediate and holds until released; anyone who can
 * manage the workspace may engage or release one. The instance-wide stop belongs to whoever runs the deployment and is shown here
 * read-only. Engaging and releasing each ask for confirmation, say what they do, and need a recent sign-in (the platform checks).
 */
export function EmergencyStops(props: { workspaceId: string; role?: WorkspaceRole }) {
  const { client } = useSession();
  const ws = props.workspaceId;
  // The same cache entry as the banner on every screen, so engaging or releasing a stop changes both at once.
  const load = useQuery(wsKey(ws, 'emergency-stops'), () => client.listEmergencyStops(ws));
  const v = loadedValue(load.state);
  const { mode } = useSession();
  // What can be stopped is picked from lists the platform gives, never typed: workflows by name, connections and what they do.
  const entities = useQuery(wsKey(ws, 'workflow-entities'), () => client.listWorkflowEntities(ws, { limit: 50 }));
  const bindings = useQuery(wsKey(ws, 'connector-bindings'), () => client.getBindings(ws));
  const workflowList = (loadedValue(entities.state)?.workflows ?? []).filter((w) => !w.archived);
  const names = new Map(workflowList.map((w) => [w.workflowId, w.name]));
  const bound = loadedValue(bindings.state)?.bindings ?? [];
  const options: Record<EmergencyStopView['scope'], readonly { value: string; label: string }[]> = {
    workflow: workflowList.map((w) => ({ value: w.workflowId, label: w.name })),
    connector: [...new Set(bound.map((b) => b.connector))].map((c) => ({ value: c, label: c })),
    capability: [...new Set(bound.map((b) => `${b.connector}.${b.operation}`))].map((c) => ({
      value: c,
      label: labelOf({ scope: 'capability', target: c }, names),
    })),
  };
  const manage = can(props.role, 'manage');
  const [scope, setScope] = useState<EmergencyStopView['scope']>('workflow');
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState<
    { action: 'engage' | 'release'; scope: string; target: string; label: string } | undefined
  >();
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const { run, busy } = useGuardedAction();
  const confirm = () =>
    void run(async () => {
      if (confirming === undefined) return;
      setProblem(undefined);
      const r =
        confirming.action === 'engage'
          ? await client.engageEmergencyStop(ws, confirming.scope, confirming.target, reason)
          : await client.releaseEmergencyStop(ws, confirming.scope, confirming.target);
      if (!r.ok) {
        setProblem(r.problem);
        setConfirming(undefined);
        return;
      }
      setNote(confirming.action === 'engage' ? `Stopped: ${confirming.label}.` : `Released: ${confirming.label}.`);
      setConfirming(undefined);
      setTarget('');
      setReason('');
      load.reload();
    });
  if (load.state.phase === 'error' && v === undefined) return <ProblemNotice problem={load.state.problem} onRetry={load.reload} />;
  if (v === undefined) return <Skeleton label="Loading emergency stops" />;
  return (
    <section className="es" aria-label="Emergency stops">
      <h3>Emergency stops</h3>
      <p className="muted small">A stop works at once and holds until someone releases it. Runs that are already waiting stay waiting.</p>
      {v.instance !== undefined ? (
        <p className="notice notice-danger" role="status">
          Everything on this XO is stopped by whoever runs it{v.instance.reason !== undefined ? `: ${v.instance.reason}` : ''}. You cannot
          change this here.
        </p>
      ) : null}
      {v.workspacePaused ? <p className="notice notice-warning small">This workspace is also paused from Workflows.</p> : null}
      {v.stops.length === 0 ? (
        <p className="muted small">Nothing is stopped.</p>
      ) : (
        <ul className="ib-rows" aria-label="Stops in place">
          {v.stops.map((s) => (
            <li key={`${s.scope}:${s.target}`} className="cc-item">
              <p className="small">
                <strong>
                  {SCOPE_WORDS[s.scope]}: {labelOf(s, names)}
                </strong>{' '}
                {whatItStops(s, labelOf(s, names))}
              </p>
              <p className="muted small">
                Stopped by {mode === 'builder' ? s.by : 'a colleague'} {s.at !== '' ? formatWhen(s.at) : ''}
                {s.reason !== undefined ? `: ${s.reason}` : ''}.
              </p>
              <Button
                onClick={() => setConfirming({ action: 'release', scope: s.scope, target: s.target, label: labelOf(s, names) })}
                disabled={!manage}
                title={manage ? undefined : whyNot(props.role, 'manage', 'releasing a stop')}
              >
                Release
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="cc-confirm" role="group" aria-label="Stop something">
        <label className="small">
          What to stop
          <select
            value={scope}
            onChange={(e) => {
              setScope(e.target.value as EmergencyStopView['scope']);
              setTarget('');
            }}
          >
            {(Object.keys(SCOPE_WORDS) as (keyof typeof SCOPE_WORDS)[]).map((k) => (
              <option key={k} value={k}>
                {SCOPE_WORDS[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="small">
          {TARGET_HINT[scope]}
          <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={options[scope].length === 0}>
            <option value="">{options[scope].length === 0 ? 'Nothing to pick yet' : 'Choose one'}</option>
            {options[scope].map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="small">
          Why (optional)
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <Button
          variant="primary"
          onClick={() =>
            setConfirming({
              action: 'engage',
              scope,
              target: target.trim(),
              label: options[scope].find((o) => o.value === target)?.label ?? target.trim(),
            })
          }
          disabled={!manage || target.trim() === ''}
          title={manage ? undefined : whyNot(props.role, 'manage', 'stopping work')}
        >
          Stop it
        </Button>
      </div>
      {confirming !== undefined ? (
        <div className="cc-confirm" role="group" aria-label="Confirm">
          <p className="small">
            {confirming.action === 'engage'
              ? `This stops ${confirming.label} now. Nothing that depends on it will start or continue until you release it.`
              : `This lets ${confirming.label} work again. Runs that were refused are not restarted.`}
          </p>
          <Button variant="primary" onClick={confirm} pending={busy}>
            {confirming.action === 'engage' ? 'Yes, stop it' : 'Yes, release it'}
          </Button>
          <Button variant="quiet" onClick={() => setConfirming(undefined)} disabled={busy}>
            Not now
          </Button>
        </div>
      ) : null}
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
      {note !== undefined ? (
        <p className="notice notice-success" role="status">
          {note}
        </p>
      ) : null}
    </section>
  );
}
