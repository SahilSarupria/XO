import { useState } from 'react';
import { can, whyNot } from '../domain/access';
import { describeEvery } from '../domain/workflowSummary';
import { useQuery, wsKey } from '../platform/query';
import type { ApiProblem } from '../platform/client';
import type { WorkflowDetailView } from '../platform/wire-workflows';
import type { WorkspaceRole } from '../platform/wire';
import { loadedValue, ProblemNotice, formatWhen } from './primitives';
import { Button, Field, RadioGroup, Select, TextField } from './kit';
import { useSession } from './session';

/**
 * How often a workflow starts by itself. The platform's schedule is "once every N minutes while the server is running" (5 minutes to
 * one week); it has no calendar days or times of day, so none is offered. A schedule is saved under a ready check, which the
 * platform recomputes now; if it is not ready the schedule is not saved and the reasons are shown. Runs it starts wait for approval
 * in the Inbox like any other.
 */
const PRESETS = [
  { value: '1440', label: 'Every day' },
  { value: '10080', label: 'Every week' },
  { value: '60', label: 'Every hour' },
  { value: 'custom', label: 'Another interval' },
] as const;

export function SchedulePicker(props: {
  workspaceId: string;
  w: WorkflowDetailView;
  role: WorkspaceRole | undefined;
  onChanged: () => void;
}) {
  const { client } = useSession();
  const { w } = props;
  const candidateId = w.currentVersion.candidateWorkflowId;
  const compilationId = w.currentVersion.compilationId;
  const controls = useQuery(wsKey(props.workspaceId, 'controls'), () => client.getWorkflowControls(props.workspaceId));
  const mine = loadedValue(controls.state)?.deployments.find((d) => d.workflowId === candidateId && d.compilationId === compilationId);
  const current = mine?.triggers.schedule;
  const preset =
    current === undefined ? 'off' : PRESETS.some((p) => p.value === String(current.everyMinutes)) ? String(current.everyMinutes) : 'custom';
  const [choice, setChoice] = useState<string | undefined>();
  const picked = choice ?? preset;
  const [amount, setAmount] = useState(
    current !== undefined
      ? String(current.everyMinutes >= 1440 && current.everyMinutes % 1440 === 0 ? current.everyMinutes / 1440 : current.everyMinutes)
      : '2',
  );
  const [unit, setUnit] = useState<'days' | 'hours'>(current !== undefined && current.everyMinutes % 1440 === 0 ? 'days' : 'hours');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const author = can(props.role, 'author');
  if (candidateId === undefined || compilationId === undefined) return null;

  const minutes = (): number | undefined => {
    if (picked === 'off') return undefined;
    if (picked !== 'custom') return Number(picked);
    const n = Number(amount);
    return Number.isInteger(n) ? n * (unit === 'days' ? 1440 : 60) : Number.NaN;
  };

  async function save() {
    setProblem(undefined);
    setError(undefined);
    setDone(undefined);
    const m = minutes();
    if (m !== undefined && (!Number.isInteger(m) || m < 5 || m > 10080)) {
      setError('Choose a time between 5 minutes and 7 days.');
      return;
    }
    setBusy(true);
    try {
      if (m === undefined) {
        const r = await client.setWorkflowTriggers(props.workspaceId, candidateId!, compilationId!, { schedule: null });
        if (!r.ok) return setProblem(r.problem);
        setDone('Done. It will only start when someone starts it.');
      } else {
        const cert = await client.certifyWorkflowEntity(props.workspaceId, w.workflowId);
        if (!cert.ok) return setProblem(cert.problem);
        if (cert.value.status !== 'READY' && cert.value.status !== 'READY_WITH_CONDITIONS') {
          const why = [...cert.value.blockers, ...cert.value.reviewItems].slice(0, 3).join(' ');
          return setError(`It needs a check before it can run on a schedule. ${why}`.trim());
        }
        const r = await client.setWorkflowTriggers(props.workspaceId, candidateId!, compilationId!, {
          schedule: { everyMinutes: m, certificateId: cert.value.certificateId },
        });
        if (!r.ok) return setProblem(r.problem);
        setDone(`Done. ${describeEvery(m)}, while XO is running. Each run waits in the Inbox if it needs approval.`);
      }
      controls.reload();
      props.onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" aria-label="How often it starts">
      <p>
        {current === undefined
          ? 'It only starts when someone starts it.'
          : `${describeEvery(current.everyMinutes)}. ${current.lastFiredAt !== '' ? `Last started ${formatWhen(current.lastFiredAt)}.` : 'It has not started yet.'}${current.lastOutcome !== undefined ? ` Last result: ${current.lastOutcome}.` : ''}`}
      </p>
      <RadioGroup
        legend="How often should it start?"
        value={picked}
        onChange={(v) => setChoice(v)}
        options={[{ value: 'off', label: 'Only when someone starts it' }, ...PRESETS]}
      />
      {picked === 'custom' ? (
        <div className="wfp-inline">
          <Field label="Every">
            <TextField type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} disabled={!author || busy} />
          </Field>
          <Field label="Unit">
            <Select
              value={unit}
              onChange={(e) => setUnit(e.target.value === 'days' ? 'days' : 'hours')}
              options={[
                { value: 'hours', label: 'hours' },
                { value: 'days', label: 'days' },
              ]}
              disabled={!author || busy}
            />
          </Field>
        </div>
      ) : null}
      <p className="muted small">
        It starts that long after the last time, while XO is running, and does not catch up after a break. Times of day and calendar dates
        are not available.
      </p>
      <Button
        variant="primary"
        loading={busy}
        disabledReason={author ? undefined : whyNot(props.role, 'author', 'changing the schedule')}
        onClick={() => void save()}
      >
        Save
      </Button>
      {error !== undefined ? <p role="alert">{error}</p> : null}
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
      {done !== undefined ? <p role="status">{done}</p> : null}
    </div>
  );
}
