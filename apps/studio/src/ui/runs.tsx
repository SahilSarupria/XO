import { useState } from 'react';
import { coerceFieldValue, describeExecution, suggestedFieldsFromFailure } from '../domain/review';
import type { ApiProblem } from '../platform/client';
import type { Execution } from '../platform/wire';
import { Badge, Button, formatWhen, ProblemNotice } from './primitives';
import { useSession } from './session';

/**
 * How one execution is shown. A failure is a failure, a paused human task is a prompt for a
 * person, and nothing here ever turns a non-success into a success.
 */
export function ExecutionOutcome(props: { workspaceId: string; execution: Execution; onChanged: () => void }) {
  const { client, mode } = useSession();
  const e = props.execution;
  const view = describeExecution(e);
  const [deciding, setDeciding] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();

  async function decide(decision: 'approve' | 'reject') {
    setDeciding(true);
    setProblem(undefined);
    const r = await client.resolveHumanTask(props.workspaceId, e.executionId, decision);
    setDeciding(false);
    if (r.ok) props.onChanged();
    else setProblem(r.problem);
  }

  const pending = e.status === 'waiting_for_human' && e.humanTask?.status === 'pending';
  return (
    <div className="outcome">
      <p>
        <Badge tone={view.tone}>{view.label}</Badge> <span className="muted small">{formatWhen(e.completedAt ?? e.requestedAt)}</span>
      </p>
      {view.detail !== undefined ? <p className={view.tone === 'danger' ? 'outcome-detail danger-text' : 'outcome-detail'}>{view.detail}</p> : null}
      {view.hint !== undefined ? <p className="outcome-detail muted">{view.hint}</p> : null}
      {pending ? (
        <div className="decision">
          <p>This step needs a person. Choose what should happen:</p>
          <div className="row">
            <Button variant="primary" disabled={deciding} onClick={() => void decide('approve')}>
              Approve this step
            </Button>
            <Button variant="danger" disabled={deciding} onClick={() => void decide('reject')}>
              Reject this step
            </Button>
          </div>
        </div>
      ) : null}
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
      {e.status === 'succeeded' && e.output !== undefined ? (
        <details>
          <summary>Result</summary>
          <pre className="code">{JSON.stringify(e.output, null, 2)}</pre>
        </details>
      ) : null}
      {mode === 'builder' ? (
        <details>
          <summary>Execution record</summary>
          <pre className="code">{JSON.stringify(e, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}

interface Row {
  readonly id: number;
  readonly name: string;
  readonly value: string;
  /** Where the field name came from. 'inferred' names are hints scraped from an earlier error message, never a schema. */
  readonly origin: 'inferred' | 'entered';
}

/**
 * Running is real: it asks the platform to execute an approved capability and the platform
 * records the attempt. The platform does not publish a capability's input contract (gap G1),
 * so inputs are free-form name/value pairs, pre-filled with any field names the platform
 * itself reported as missing on an earlier attempt.
 */
export function RunPanel(props: { workspaceId: string; compilationId: string; capabilityId: string; lastExecution: Execution | undefined; onRan: () => void }) {
  const { client } = useSession();
  const suggested = props.lastExecution !== undefined ? suggestedFieldsFromFailure(props.lastExecution) : [];
  const [rows, setRows] = useState<Row[]>(() => suggested.map((name, i) => ({ id: i, name, value: '', origin: 'inferred' as const })));
  const [nextId, setNextId] = useState(suggested.length);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();

  function update(id: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function run() {
    setBusy(true);
    setProblem(undefined);
    const input: Record<string, unknown> = {};
    for (const r of rows) if (r.name.trim().length > 0) input[r.name.trim()] = coerceFieldValue(r.value);
    const res = await client.createExecution(props.workspaceId, props.compilationId, props.capabilityId, input);
    setBusy(false);
    if (res.ok) props.onRan();
    else setProblem(res.problem);
  }

  return (
    <div className="run-panel">
      <h4>Run this rule</h4>
      <p className="muted small">This really runs the rule through XO and records the attempt.</p>
      <p className="notice notice-info small">
        XO does not publish the list of details this rule needs, so Studio cannot show you a verified form. {suggested.length > 0 ? 'The names below were taken from XO\u2019s last error message for this rule. They are hints, not a checked schema, and may be incomplete.' : 'Add the details you know it needs; XO will check them and say what is missing.'} Numbers and true/false are sent as numbers and booleans; put text in quotes (for example &quot;42&quot;) to send it as text.
      </p>
      {rows.map((r) => (
        <div className="row field-row" key={r.id}>
          <input aria-label="Detail name" value={r.name} onChange={(e) => update(r.id, { name: e.target.value })} placeholder="name" />
          {r.origin === 'inferred' ? <Badge tone="neutral">hint from XO&rsquo;s last error</Badge> : null}
          <input aria-label={`Value for ${r.name || 'detail'}`} value={r.value} onChange={(e) => update(r.id, { value: e.target.value })} placeholder="value" />
          <Button variant="quiet" aria-label={`Remove ${r.name || 'detail'}`} onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}>
            Remove
          </Button>
        </div>
      ))}
      <div className="row">
        <Button
          variant="quiet"
          onClick={() => {
            setRows((rs) => [...rs, { id: nextId, name: '', value: '', origin: 'entered' }]);
            setNextId(nextId + 1);
          }}
        >
          Add a detail
        </Button>
        <Button variant="primary" disabled={busy} onClick={() => void run()}>
          {busy ? 'Running…' : 'Run'}
        </Button>
      </div>
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
    </div>
  );
}
