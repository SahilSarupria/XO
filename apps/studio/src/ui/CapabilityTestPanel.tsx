import { useState } from 'react';
import { can, whyNot } from '../domain/access';
import { buildInputFromContract } from '../domain/review';
import type { ApiProblem } from '../platform/client';
import type { Capability, Execution, WorkspaceRole } from '../platform/wire';
import type { CapabilityPreview } from '../platform/wire-studio';
import { ContractFields } from './ContractFields';
import { Badge, Button, ProblemNotice } from './primitives';
import { ExecutionOutcome } from './runs';
import { useSession } from './session';

function parseInput(text: string): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const v: unknown = JSON.parse(text.trim() === '' ? '{}' : text);
    if (v === null || typeof v !== 'object' || Array.isArray(v))
      return { ok: false, error: 'The input must be a JSON object, for example {"amount": 120}.' };
    return { ok: true, input: v as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'The input is not valid JSON.' };
  }
}

/**
 * Preview asks the platform what a run would do and executes nothing. Test Run is the ordinary approved-only execution:
 * it is enabled only after a preview that says it is allowed for exactly this input, and its result is a real,
 * recorded run. Roles only hint; the platform's refusals are shown as they come.
 */
export function CapabilityTestPanel(props: {
  workspaceId: string;
  compilationId: string;
  cap: Capability;
  role: WorkspaceRole | undefined;
  onChanged: () => void;
}) {
  const { client } = useSession();
  const { cap } = props;
  const contract = cap.inputContract;
  const [text, setText] = useState('{}');
  const [values, setValuesState] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ result: CapabilityPreview; forInput: string } | undefined>();
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [busy, setBusy] = useState<'preview' | 'approve' | 'run' | undefined>();
  const [ran, setRan] = useState<Execution | undefined>();
  // With a published contract the form is the input; the key identifies exactly what a preview was run for.
  const built = contract !== undefined ? buildInputFromContract(contract, values) : undefined;
  const parsed: ReturnType<typeof parseInput> =
    contract === undefined
      ? parseInput(text)
      : built !== undefined && built.ok
        ? { ok: true, input: built.input }
        : { ok: false, error: 'Fill in the required details.' };
  const inputKey = parsed.ok ? JSON.stringify(parsed.input) : undefined;
  const setValue = (name: string, v: string) => {
    setValuesState((cur) => ({ ...cur, [name]: v }));
    setFieldErrors((cur) => {
      const { [name]: _drop, ...rest } = cur;
      return rest;
    });
  };
  const canAuthor = can(props.role, 'author');
  const canReview = can(props.role, 'review');
  const fresh = preview !== undefined && inputKey !== undefined && preview.forInput === inputKey;
  const approved = cap.approved || preview?.result.approved === true;
  const runnable = fresh && preview.result.approved && preview.result.testRunAllowed && parsed.ok;

  async function doPreview() {
    if (!parsed.ok) {
      if (built !== undefined && !built.ok) setFieldErrors({ ...built.errors });
      return;
    }
    setBusy('preview');
    setProblem(undefined);
    setRan(undefined);
    const r = await client.previewCapability(props.workspaceId, props.compilationId, cap.capabilityId, parsed.input);
    setBusy(undefined);
    if (r.ok) setPreview({ result: r.value, forInput: JSON.stringify(parsed.input) });
    else setProblem(r.problem);
  }
  async function approve() {
    setBusy('approve');
    setProblem(undefined);
    const r = await client.approveCapability(props.workspaceId, props.compilationId, cap.capabilityId);
    setBusy(undefined);
    if (r.ok) {
      setPreview(undefined);
      props.onChanged();
    } else setProblem(r.problem);
  }
  async function testRun() {
    if (!parsed.ok) return;
    setBusy('run');
    setProblem(undefined);
    const r = await client.createExecution(props.workspaceId, props.compilationId, cap.capabilityId, parsed.input);
    setBusy(undefined);
    if (r.ok) {
      setRan(r.value);
      props.onChanged();
    } else setProblem(r.problem);
  }

  const id = `test-${cap.capabilityId}`;
  return (
    <div className="run-panel" aria-label={`Preview and Test Run for ${cap.name}`}>
      <h4>Preview and Test Run</h4>
      {contract !== undefined ? (
        <>
          <p className="muted small">Details this rule takes, from its published input contract. The platform still checks them.</p>
          <ContractFields contract={contract} idPrefix={id} values={values} errors={fieldErrors} onChange={setValue} />
        </>
      ) : (
        <>
          <p className="muted small">This rule has no published input contract, so the input is a JSON object the platform will check.</p>
          <label htmlFor={`${id}-input`}>Sample input (JSON object)</label>
          <textarea id={`${id}-input`} rows={3} value={text} onChange={(e) => setText(e.target.value)} aria-invalid={!parsed.ok} />
          {!parsed.ok ? (
            <p className="danger-text small" role="alert">
              {parsed.error}
            </p>
          ) : null}
        </>
      )}
      <div className="row">
        <Button
          variant="secondary"
          pending={busy === 'preview'}
          disabled={(contract === undefined && !parsed.ok) || !canAuthor || busy !== undefined}
          onClick={() => void doPreview()}
        >
          Preview
        </Button>
        {!approved ? (
          <Button
            variant="secondary"
            pending={busy === 'approve'}
            disabled={!canReview || busy !== undefined}
            onClick={() => void approve()}
          >
            Approve this rule
          </Button>
        ) : (
          <Badge tone="success">approved</Badge>
        )}
        <Button variant="primary" pending={busy === 'run'} disabled={!runnable || busy !== undefined} onClick={() => void testRun()}>
          Test Run
        </Button>
      </div>
      {!canAuthor ? <p className="muted small">{whyNot(props.role, 'author', 'previewing')}</p> : null}
      {!approved && !canReview ? <p className="muted small">{whyNot(props.role, 'review', 'approving rules')}</p> : null}
      {preview !== undefined && !fresh ? (
        <p className="muted small">The input changed since the last preview. Preview again to enable a Test Run.</p>
      ) : null}
      {preview === undefined && approved ? <p className="muted small">Test Run is enabled after a preview that allows it.</p> : null}

      {preview !== undefined ? (
        <div role="region" aria-label="Preview result">
          <p>
            <Badge tone="neutral">Preview only</Badge> {preview.result.note}
          </p>
          <dl className="wf-fields">
            <dt>Approved</dt>
            <dd>{preview.result.approved ? 'Yes' : 'No'}</dd>
            <dt>Test Run allowed</dt>
            <dd>{preview.result.testRunAllowed ? 'Yes' : 'No'}</dd>
            {preview.result.externalEffects !== undefined ? (
              <>
                <dt>External effects</dt>
                <dd>{preview.result.externalEffects === 'none' ? 'None' : 'Opens a human task'}</dd>
              </>
            ) : null}
          </dl>
          {preview.result.blockers.length > 0 ? (
            <>
              <h5 className="chat-label">Blockers</h5>
              <ul aria-label="Blockers">
                {preview.result.blockers.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </>
          ) : null}
          {preview.result.inputIssues.length > 0 ? (
            <>
              <h5 className="chat-label">Input issues</h5>
              <ul aria-label="Input issues">
                {preview.result.inputIssues.map((i, k) => (
                  <li key={k}>
                    <span className="mono">{i.path}</span>: {i.message}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {preview.result.plan.length > 0 ? (
            <>
              <h5 className="chat-label">What a run would do</h5>
              <ol aria-label="Plan">
                {preview.result.plan.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </>
          ) : null}
          {preview.result.unresolvedReason !== undefined ? <p className="small">{preview.result.unresolvedReason}</p> : null}
        </div>
      ) : null}

      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
      {ran !== undefined ? (
        <div role="region" aria-label="Test Run result">
          <p className="small">Test Run recorded. This was a real run through the same approval gate, not a preview.</p>
          <ExecutionOutcome
            workspaceId={props.workspaceId}
            execution={ran}
            onChanged={props.onChanged}
            {...(props.role !== undefined ? { role: props.role } : {})}
          />
        </div>
      ) : null}
    </div>
  );
}
