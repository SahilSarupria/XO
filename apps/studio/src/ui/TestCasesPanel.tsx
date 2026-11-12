import { useCallback, useEffect, useState } from 'react';
import { can, whyNot } from '../domain/access';
import { buildInputFromContract } from '../domain/review';
import type { ApiProblem } from '../platform/client';
import type { Capability, WorkspaceRole } from '../platform/wire';
import type { TestCase, TestCaseDraft, TestCaseRun, TestCaseStatus } from '../platform/wire-studio';
import { ContractFields } from './ContractFields';
import { Badge, Button, formatWhen, ProblemNotice } from './primitives';
import { useSession } from './session';

const STATUS_LABEL: Record<TestCaseStatus, string> = {
  succeeded: 'Succeeds',
  waiting_for_human: 'Waits for a person',
  failed: 'Fails',
};

function parseObject(text: string, what: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const v: unknown = JSON.parse(text.trim() === '' ? '{}' : text);
    if (v === null || typeof v !== 'object' || Array.isArray(v))
      return { ok: false, error: `${what} must be a JSON object, for example {"amount": 120}.` };
    return { ok: true, value: v as Record<string, unknown> };
  } catch {
    return { ok: false, error: `${what} is not valid JSON.` };
  }
}

/** True when an input can be shown in the contract form without losing anything. */
function fitsContract(cap: Capability, input: Readonly<Record<string, unknown>>): boolean {
  const props = cap.inputContract?.properties;
  if (props === undefined) return false;
  return Object.entries(input).every(([k, v]) => props[k] !== undefined && typeof v === props[k]!.type);
}

/**
 * Saved test cases for one rule. A case is only data (a name, an input, an expectation). Running it is a real,
 * approval-gated execution and the platform's verdict (pass/fail and why) is what is shown; nothing here compares
 * outputs. Roles only hint; every refusal is shown as the platform worded it.
 */
export function TestCasesPanel(props: {
  workspaceId: string;
  compilationId: string;
  cap: Capability;
  role: WorkspaceRole | undefined;
  onChanged: () => void;
}) {
  const { client } = useSession();
  const { workspaceId: ws, compilationId, cap } = props;
  const [cases, setCases] = useState<readonly TestCase[] | undefined>();
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [editing, setEditing] = useState<'new' | string | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [confirming, setConfirming] = useState<string | undefined>();
  const [history, setHistory] = useState<{ caseId: string; runs: readonly TestCaseRun[] } | undefined>();
  const [lastBatch, setLastBatch] = useState<{ passed: number; failed: number } | undefined>();
  const mayEdit = can(props.role, 'author');
  const mayRun = can(props.role, 'author') || can(props.role, 'review');

  const load = useCallback(
    async (keepProblem = false) => {
      const r = await client.listTestCases(ws, compilationId, cap.capabilityId);
      if (r.ok) {
        setCases(r.value);
        if (!keepProblem) setProblem(undefined);
      } else setProblem(r.problem);
    },
    [client, ws, compilationId, cap.capabilityId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const guard = async <T,>(
    label: string,
    work: () => Promise<{ ok: true; value: T } | { ok: false; problem: ApiProblem }>,
  ): Promise<T | undefined> => {
    setBusy(label);
    setProblem(undefined);
    const r = await work();
    setBusy(undefined);
    if (!r.ok) {
      setProblem(r.problem);
      return undefined;
    }
    return r.value;
  };

  const runOne = async (c: TestCase) => {
    const run = await guard(`run:${c.caseId}`, () => client.runTestCase(ws, compilationId, cap.capabilityId, c.caseId));
    if (run !== undefined) {
      setCases((cur) => cur?.map((x) => (x.caseId === c.caseId ? { ...x, lastRun: run } : x)));
      if (history?.caseId === c.caseId) setHistory({ caseId: c.caseId, runs: [run, ...history.runs] });
      props.onChanged();
    }
  };
  const runAll = async () => {
    const batch = await guard('all', () => client.runTestCases(ws, compilationId, cap.capabilityId));
    if (batch !== undefined) {
      setLastBatch({ passed: batch.passed, failed: batch.failed });
      await load();
      props.onChanged();
    }
  };
  const save = async (draft: TestCaseDraft, existing: TestCase | undefined): Promise<boolean> => {
    const saved = await guard('save', () =>
      existing === undefined
        ? client.createTestCase(ws, compilationId, cap.capabilityId, draft)
        : client.updateTestCase(ws, compilationId, cap.capabilityId, existing.caseId, { ...draft, expectedRevision: existing.revision }),
    );
    if (saved === undefined) {
      if (existing !== undefined) await load(true); // a stale revision: show what is actually saved now, and keep the platform's message
      return false;
    }
    setEditing(undefined);
    await load();
    return true;
  };
  const remove = async (c: TestCase) => {
    const r = await guard(`delete:${c.caseId}`, () => client.deleteTestCase(ws, compilationId, cap.capabilityId, c.caseId));
    if (r !== undefined) {
      setConfirming(undefined);
      if (history?.caseId === c.caseId) setHistory(undefined);
      await load();
    }
  };
  const showHistory = async (c: TestCase) => {
    if (history?.caseId === c.caseId) return setHistory(undefined);
    const runs = await guard(`history:${c.caseId}`, () => client.testCaseHistory(ws, compilationId, cap.capabilityId, c.caseId));
    if (runs !== undefined) setHistory({ caseId: c.caseId, runs });
  };

  const editingCase = editing !== undefined && editing !== 'new' ? cases?.find((c) => c.caseId === editing) : undefined;
  return (
    <section aria-label={`Test cases for ${cap.name}`}>
      <p className="muted small">
        Saved inputs with what you expect. Running one is a real run of this rule, so it must be approved; the platform decides whether it
        passed.
      </p>
      {!mayEdit ? <p className="muted small">{whyNot(props.role, 'author', 'saving test cases')}</p> : null}
      {mayEdit && !mayRun ? null : !mayRun ? <p className="muted small">{whyNot(props.role, 'review', 'running test cases')}</p> : null}
      {problem !== undefined ? (
        <>
          <ProblemNotice problem={problem} onRetry={() => void load()} />
          <p className="small" aria-label="What the platform said">
            The platform said: “{problem.message}”
          </p>
        </>
      ) : null}
      {cases === undefined && problem === undefined ? <p className="muted small">Loading test cases…</p> : null}
      {cases !== undefined && cases.length === 0 && editing !== 'new' ? <p className="muted small">No test cases yet.</p> : null}
      {cases !== undefined && cases.length > 0 ? (
        <>
          <ul className="bare-list" aria-label="Test cases">
            {cases.map((c) => (
              <li key={c.caseId} className="tc-case">
                {editing === c.caseId ? null : (
                  <>
                    <strong>{c.name}</strong>{' '}
                    {c.lastRun === undefined ? (
                      <Badge tone="neutral">Not run</Badge>
                    ) : c.lastRun.pass ? (
                      <Badge tone="success">Passed</Badge>
                    ) : (
                      <Badge tone="danger">Failed</Badge>
                    )}
                    <p className="muted small">
                      Expects: {STATUS_LABEL[c.expected.status]}
                      {c.expected.output !== undefined ? ` with ${JSON.stringify(c.expected.output)} in the output` : ''}
                      {c.lastRun !== undefined ? ` · last run ${formatWhen(c.lastRun.at)}` : ''}
                    </p>
                    {c.lastRun !== undefined && !c.lastRun.pass ? (
                      <ul aria-label={`Why ${c.name} failed`}>
                        {c.lastRun.mismatches.map((m, i) => (
                          <li key={i}>{m}</li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="row">
                      <Button
                        variant="secondary"
                        disabled={!mayRun || busy !== undefined}
                        pending={busy === `run:${c.caseId}`}
                        onClick={() => void runOne(c)}
                        aria-label={`Run ${c.name}`}
                      >
                        Run
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={!mayEdit || busy !== undefined}
                        onClick={() => setEditing(c.caseId)}
                        aria-label={`Edit ${c.name}`}
                      >
                        Edit
                      </Button>
                      <Button variant="secondary" onClick={() => void showHistory(c)} aria-label={`History of ${c.name}`}>
                        {history?.caseId === c.caseId ? 'Hide history' : 'History'}
                      </Button>
                      {confirming === c.caseId ? (
                        <>
                          <Button variant="secondary" onClick={() => void remove(c)} aria-label={`Confirm delete ${c.name}`}>
                            Confirm delete
                          </Button>
                          <Button variant="quiet" onClick={() => setConfirming(undefined)}>
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="quiet"
                          disabled={!mayEdit || busy !== undefined}
                          onClick={() => setConfirming(c.caseId)}
                          aria-label={`Delete ${c.name}`}
                        >
                          Delete
                        </Button>
                      )}
                    </div>
                    {history?.caseId === c.caseId ? (
                      history.runs.length === 0 ? (
                        <p className="muted small">This case has not been run.</p>
                      ) : (
                        <ol className="bare-list" aria-label={`Run history of ${c.name}`}>
                          {history.runs.map((r) => (
                            <li key={r.runId} className="small">
                              {r.pass ? 'Passed' : 'Failed'} · {formatWhen(r.at)} · case revision {r.caseRevision} · got{' '}
                              {r.actual.status.replace(/_/g, ' ')}
                              {r.mismatches.length > 0 ? ` — ${r.mismatches.join('; ')}` : ''}
                            </li>
                          ))}
                        </ol>
                      )
                    ) : null}
                  </>
                )}
                {editing === c.caseId && editingCase !== undefined ? (
                  <CaseForm
                    cap={cap}
                    existing={editingCase}
                    busy={busy === 'save'}
                    onCancel={() => setEditing(undefined)}
                    onSave={(d) => save(d, editingCase)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
          <Button variant="secondary" disabled={!mayRun || busy !== undefined} pending={busy === 'all'} onClick={() => void runAll()}>
            Run all test cases
          </Button>
          {lastBatch !== undefined ? (
            <p className="small" role="status">
              {lastBatch.passed} passed, {lastBatch.failed} failed.
            </p>
          ) : null}
        </>
      ) : null}
      {editing === 'new' ? (
        <CaseForm
          cap={cap}
          existing={undefined}
          busy={busy === 'save'}
          onCancel={() => setEditing(undefined)}
          onSave={(d) => save(d, undefined)}
        />
      ) : (
        <Button variant="secondary" disabled={!mayEdit || busy !== undefined} onClick={() => setEditing('new')}>
          Add a test case
        </Button>
      )}
    </section>
  );
}

function CaseForm(props: {
  cap: Capability;
  existing: TestCase | undefined;
  busy: boolean;
  onCancel: () => void;
  onSave: (d: TestCaseDraft) => Promise<boolean>;
}) {
  const { cap, existing } = props;
  const contract = cap.inputContract;
  const startJson = existing !== undefined && !fitsContract(cap, existing.input);
  const [json, setJson] = useState(startJson || contract === undefined);
  const [name, setName] = useState(existing?.name ?? '');
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(existing?.input ?? {}).map(([k, v]) => [k, String(v)])),
  );
  const [inputText, setInputText] = useState(JSON.stringify(existing?.input ?? {}, null, 2));
  const [status, setStatus] = useState<TestCaseStatus>(existing?.expected.status ?? 'succeeded');
  const [outputText, setOutputText] = useState(
    existing?.expected.output !== undefined ? JSON.stringify(existing.expected.output, null, 2) : '',
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | undefined>();
  const id = `tc-${existing?.caseId ?? 'new'}`;

  const submit = () => {
    setFormError(undefined);
    if (name.trim() === '') return setFormError('Give the test case a name.');
    let input: Record<string, unknown>;
    if (!json && contract !== undefined) {
      const built = buildInputFromContract(contract, values);
      if (!built.ok) return setErrors({ ...built.errors });
      setErrors({});
      input = { ...built.input };
    } else {
      const p = parseObject(inputText, 'The input');
      if (!p.ok) return setFormError(p.error);
      input = p.value;
    }
    let output: Record<string, unknown> | undefined;
    if (outputText.trim() !== '') {
      const p = parseObject(outputText, 'The expected output');
      if (!p.ok) return setFormError(p.error);
      output = p.value;
    }
    void props.onSave({ name: name.trim(), input, expected: { status, ...(output !== undefined ? { output } : {}) } });
  };

  return (
    <div className="tc-form" role="group" aria-label={existing === undefined ? 'New test case' : `Edit ${existing.name}`}>
      <label htmlFor={`${id}-name`}>Name</label>
      <input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
      {contract !== undefined ? (
        <label className="small">
          <input type="checkbox" checked={json} onChange={(e) => setJson(e.target.checked)} /> Edit the input as JSON (to try input the form
          would not allow)
        </label>
      ) : (
        <p className="muted small">This rule has no published input contract, so the input is a JSON object.</p>
      )}
      {!json && contract !== undefined ? (
        <ContractFields
          contract={contract}
          idPrefix={id}
          values={values}
          errors={errors}
          onChange={(n, v) => setValues((cur) => ({ ...cur, [n]: v }))}
        />
      ) : (
        <>
          <label htmlFor={`${id}-input`}>Input (JSON object)</label>
          <textarea id={`${id}-input`} rows={4} value={inputText} onChange={(e) => setInputText(e.target.value)} />
        </>
      )}
      <label htmlFor={`${id}-status`}>Expected result</label>
      <select id={`${id}-status`} value={status} onChange={(e) => setStatus(e.target.value as TestCaseStatus)}>
        {(Object.keys(STATUS_LABEL) as TestCaseStatus[]).map((s) => (
          <option key={s} value={s}>
            {STATUS_LABEL[s]}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-output`}>Expected output contains (optional JSON object)</label>
      <textarea
        id={`${id}-output`}
        rows={3}
        value={outputText}
        onChange={(e) => setOutputText(e.target.value)}
        placeholder='{"outcome": "covered"}'
      />
      {formError !== undefined ? (
        <p className="danger-text small" role="alert">
          {formError}
        </p>
      ) : null}
      <div className="row">
        <Button variant="primary" pending={props.busy} onClick={submit}>
          {existing === undefined ? 'Save test case' : 'Save changes'}
        </Button>
        <Button variant="quiet" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
