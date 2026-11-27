import { useState } from 'react';
import { can, whyNot } from '../domain/access';
import { keptWords } from '../domain/evidence';
import type { ApiProblem } from '../platform/client';
import type { WorkspaceRole } from '../platform/wire';
import { useGuardedAction } from './actions';
import { EvidenceView } from './EvidenceView';
import { Button, loadedValue, ProblemNotice, Skeleton, useLoad } from './primitives';
import { useSession } from './session';

type P = { workspaceId: string; definitionId: string; runId: string; role: WorkspaceRole | undefined };

/**
 * UW-12b (ADR 0052): what a run produced and what can be learned from it. Outputs say who can open each thing and how long it is
 * kept (what the platform records; Studio claims nothing more). Observations are what XO noticed (a person changing a value, a
 * stop, an exclusion): a person can correct a value with a reason, and propose chosen observations as knowledge, which a different
 * reviewer approves in What XO knows. Nothing is learned without that approval.
 */
export function RunResults(props: P & { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(props.defaultOpen === true);
  return (
    <div className="rr">
      <Button variant="quiet" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? 'Hide results' : 'Show results'}
      </Button>
      {open ? (
        <>
          <Outputs {...props} />
          <EvidenceView workspaceId={props.workspaceId} definitionId={props.definitionId} runId={props.runId} />
          <Learning {...props} />
        </>
      ) : null}
    </div>
  );
}

function Outputs(props: P) {
  const { client } = useSession();
  const load = useLoad(
    () => client.runOutputs(props.workspaceId, props.definitionId, props.runId),
    [client, props.workspaceId, props.definitionId, props.runId],
  );
  const v = loadedValue(load.state);
  if (load.state.phase === 'error' && v === undefined) return <ProblemNotice problem={load.state.problem} onRetry={load.reload} />;
  if (v === undefined) return <Skeleton label="Loading outputs" />;
  return (
    <section className="ib-card" aria-label="What it produced">
      <h4>What it produced</h4>
      {v.artefacts.length === 0 ? (
        <p className="muted small">Nothing has been produced yet.</p>
      ) : (
        <ul className="cc-args">
          {v.artefacts.map((a, i) => (
            <li key={`${a.kind}-${a.name}-${i}`}>
              {a.name}
              {a.item !== undefined ? ` (item ${a.item + 1})` : ''}: {a.type}
              {a.state !== undefined ? `, ${a.state}` : ''}. Who can open it: {a.access}. {keptWords(a.kept)}.
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Learning(props: P) {
  const { client } = useSession();
  const load = useLoad(
    () => client.runObservations(props.workspaceId, props.definitionId, props.runId),
    [client, props.workspaceId, props.definitionId, props.runId],
  );
  const list = loadedValue(load.state);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [field, setField] = useState('');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [correcting, setCorrecting] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const { run, busy } = useGuardedAction();
  const author = can(props.role, 'author');
  const correct = () =>
    void run(async () => {
      setProblem(undefined);
      const r = await client.recordRunCorrection(props.workspaceId, props.definitionId, props.runId, {
        field: field.trim(),
        value: value.trim(),
        reason: reason.trim(),
      });
      if (!r.ok) {
        setProblem(r.problem);
        return;
      }
      setNote('Recorded. It is kept with this run; XO does not change its knowledge from it unless you propose it.');
      setCorrecting(false);
      setField('');
      setValue('');
      setReason('');
      load.reload();
    });
  const propose = () =>
    void run(async () => {
      setProblem(undefined);
      const r = await client.proposeRunLearning(props.workspaceId, props.definitionId, props.runId, picked);
      if (!r.ok) {
        setProblem(r.problem);
        return;
      }
      setPicked([]);
      setNote('Proposed. A reviewer approves it in What XO knows; until then XO knows nothing new.');
    });
  if (load.state.phase === 'error' && list === undefined) return <ProblemNotice problem={load.state.problem} onRetry={load.reload} />;
  if (list === undefined) return <Skeleton label="Loading what XO noticed" />;
  return (
    <section className="ib-card" aria-label="What XO noticed">
      <h4>What XO noticed</h4>
      {list.length === 0 ? (
        <p className="muted small">Nothing to learn from this run.</p>
      ) : (
        <ul className="cc-args">
          {list.map((o) => (
            <li key={o.observationId}>
              <label className="small">
                <input
                  type="checkbox"
                  checked={picked.includes(o.observationId)}
                  onChange={(e) => setPicked(e.target.checked ? [...picked, o.observationId] : picked.filter((x) => x !== o.observationId))}
                />{' '}
                {o.summary}
                {o.item !== undefined ? ` (item ${o.item + 1})` : ''}
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="cc-actions">
        <Button
          onClick={propose}
          disabled={picked.length === 0 || !author}
          pending={busy}
          title={author ? undefined : whyNot(props.role, 'author', 'proposing knowledge')}
        >
          Propose as knowledge
        </Button>
        {!correcting ? (
          <Button
            onClick={() => setCorrecting(true)}
            disabled={!author}
            title={author ? undefined : whyNot(props.role, 'author', 'correcting a value')}
          >
            Correct a value
          </Button>
        ) : null}
      </div>
      {correcting ? (
        <div className="cc-confirm" role="group" aria-label="Correct a value">
          <label className="small">
            Which field
            <input value={field} onChange={(e) => setField(e.target.value)} />
          </label>
          <label className="small">
            What it should have been
            <input value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
          <label className="small">
            Why
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <Button
            variant="primary"
            onClick={correct}
            disabled={field.trim() === '' || value.trim() === '' || reason.trim() === ''}
            pending={busy}
          >
            Record the correction
          </Button>
          <Button variant="quiet" onClick={() => setCorrecting(false)} disabled={busy}>
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
