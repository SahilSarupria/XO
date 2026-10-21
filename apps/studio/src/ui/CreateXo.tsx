import { useState } from 'react';
import { SUPPORTED_UPLOAD_EXTENSIONS } from '../platform/client';
import { barPercent, documentLabel, needsInput } from '../domain/xo';
import { summarize } from '../domain/review';
import type { StartTarget } from '../domain/start';
import type { Compilation, Source } from '../platform/wire';
import { Badge, Button, formatBytes, ProblemNotice, Skeleton, Spinner, useLoad, type LoadState } from './primitives';
import { useSession } from './session';
import { useDocuments } from './useDocuments';
import '../styles/xo.css';

const STEPS = ['Add sources', 'Build', 'Test', 'Publish'] as const;

/**
 * Creating an XO from your own documents, as designed: Sources on the left, what XO found on the right.
 * Add sources, Build (analysis) and the rules it finds are real. Test hands over to the chat, whose replies are fixed
 * previews. Publish is not available, because Studio cannot package or sign. Nothing here is estimated.
 */
export function CreateXo(props: {
  workspaceId: string;
  sources: LoadState<Source[]>;
  compilations: readonly Compilation[];
  onChanged: () => void;
  onOpenXo: (compilationId: string) => void;
  onTestInChat: () => void;
  goTo: (t: StartTarget) => void;
}) {
  const { client } = useSession();
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<string | undefined>();
  const [analysed, setAnalysed] = useState<Compilation | undefined>();
  const [dragging, setDragging] = useState(false);
  const docs = useDocuments({
    workspaceId: props.workspaceId,
    onChanged: props.onChanged,
    onAnalysed: (c) => {
      setAnalysed(c);
      props.onChanged();
    },
  });
  const sources = props.sources.phase === 'ready' ? props.sources.value : [];
  const source = sources.find((s) => s.sourceId === picked);
  const built =
    analysed !== undefined && analysed.sourceId === picked
      ? analysed
      : props.compilations.find((c) => c.sourceId === picked && c.status === 'succeeded');
  const caps = useLoad(
    async () => (built === undefined ? { ok: true as const, value: [] } : client.getCapabilities(props.workspaceId, built.compilationId)),
    [client, props.workspaceId, built?.compilationId],
  );
  const rules = caps.state.phase === 'ready' ? caps.state.value : caps.state.phase === 'error' ? (caps.state.stale ?? []) : [];
  const counts = summarize(rules);
  const open = needsInput(rules);
  const go = (n: number) => setStep(Math.max(0, Math.min(STEPS.length - 1, n)));
  const canContinue = (step === 0 && picked !== undefined) || (step === 1 && built !== undefined) || step === 2;

  return (
    <section className="cx" aria-labelledby="create-h">
      <header className="cx-head">
        <h1 id="create-h">Create XO</h1>
        <span className="mono cx-draft">{source === undefined ? 'new · draft' : `${documentLabel(source.originalFilename)} · draft`}</span>
      </header>
      <ol className="cx-steps bare-list" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li key={label} aria-current={i === step ? 'step' : undefined} data-state={i < step ? 'done' : i === step ? 'current' : 'todo'}>
            {i + 1} {label}
            {i < step ? <span aria-hidden="true"> ✓</span> : null}
            {i < step ? <span className="visually-hidden"> (done)</span> : null}
          </li>
        ))}
      </ol>

      <div className="cx-panes">
        <section className="xoi-card cx-sources" aria-labelledby="cx-src-h">
          <h2 id="cx-src-h">Sources</h2>
          <input
            ref={docs.fileInput}
            id="wiz-upload"
            type="file"
            className="visually-hidden"
            aria-label="Choose a document to upload"
            accept={SUPPORTED_UPLOAD_EXTENSIONS.join(',')}
            onChange={(e) => void docs.onFiles(e.target.files)}
          />
          {sources.length === 0 ? <p className="muted small">No documents yet.</p> : null}
          <ul className="cx-docs bare-list">
            {sources.map((s) => (
              <li key={s.sourceId}>
                <label data-picked={picked === s.sourceId}>
                  <input type="radio" name="wiz-source" checked={picked === s.sourceId} onChange={() => setPicked(s.sourceId)} />
                  <span>{s.originalFilename}</span>
                  <span className="mono">{formatBytes(s.byteSize)}</span>
                </label>
              </li>
            ))}
          </ul>
          <div
            className="cx-drop"
            data-over={dragging}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void docs.onFiles(e.dataTransfer.files);
            }}
          >
            <Button variant="quiet" disabled={docs.uploading} onClick={() => docs.fileInput.current?.click()}>
              {docs.uploading ? 'Uploading…' : 'Drop files, or choose a file'}
            </Button>
            <p className="muted small">Pasting a link is not available yet.</p>
          </div>
          {typeof docs.uploadProblem === 'string' ? (
            <div className="notice notice-warning" role="alert">
              {docs.uploadProblem}
            </div>
          ) : docs.uploadProblem !== undefined ? (
            <ProblemNotice problem={docs.uploadProblem} />
          ) : null}
        </section>

        <div className="cx-right">
          {step === 0 ? (
            <section className="xoi-card">
              <h2>What this XO can do</h2>
              <p className="muted small">Choose a document on the left, then continue. XO reads it in the next step.</p>
            </section>
          ) : null}

          {step === 1 ? (
            <section className="xoi-card" aria-labelledby="cx-do-h">
              <div className="row between">
                <h2 id="cx-do-h">What this XO can do</h2>
                {built !== undefined ? <span className="mono muted small">{rules.length} {rules.length === 1 ? 'rule' : 'rules'} found</span> : null}
              </div>
              {docs.analysing !== undefined ? <Spinner label="Analysing" /> : null}
              {docs.analysisFailure !== undefined ? (
                <div className="notice notice-danger" role="alert">
                  <strong>{docs.analysisFailure.view.title}</strong>
                  <p>{docs.analysisFailure.view.body}</p>
                  <p className="muted">{docs.analysisFailure.view.next}</p>
                </div>
              ) : null}
              {source !== undefined ? (
                <Button
                  variant={built === undefined ? 'primary' : 'secondary'}
                  disabled={docs.analysing !== undefined}
                  onClick={() => void docs.analyse(source)}
                >
                  {built === undefined ? 'Analyse' : 'Analyse again'}
                </Button>
              ) : null}
              {built !== undefined && caps.state.phase === 'loading' ? <Skeleton label="Loading rules" rows={2} /> : null}
              {caps.state.phase === 'error' ? <ProblemNotice problem={caps.state.problem} onRetry={caps.reload} /> : null}
              {built !== undefined ? (
                <ul className="cx-rules bare-list">
                  {rules.map((r) => {
                    const pct = barPercent(r.confidence);
                    return (
                      <li key={r.capabilityId}>
                        <span>{r.name}</span>
                        <span className="xoi-bar" aria-hidden="true">
                          {pct !== undefined ? <span style={{ width: `${pct}%` }} data-low={pct < 80} /> : null}
                        </span>
                        <span className="mono">{r.confidence.toFixed(2)}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </section>
          ) : null}

          {step === 1 && open.length > 0 ? (
            <section className="notice notice-warning cx-input" role="status" aria-labelledby="cx-in-h">
              <h2 id="cx-in-h">
                {open.length} {open.length === 1 ? 'thing needs' : 'things need'} your input
              </h2>
              <ul className="bare-list">
                {open.slice(0, 4).map((n) => (
                  <li key={n.name}>
                    <strong>{n.name}.</strong> {n.reason}
                  </li>
                ))}
              </ul>
              {open.length > 4 ? <p className="small">And {open.length - 4} more. They are listed under Review rules.</p> : null}
            </section>
          ) : null}

          {step === 2 ? (
            <section className="xoi-card">
              <h2>Test</h2>
              <p>
                {counts.approved} approved · {counts.readyForReview} ready for review · {counts.needsAttention} need more information
              </p>
              <p className="muted small">
                You approve every rule before a workflow may use it. Nothing is approved for you. Running test cases against this XO is not available yet; the chat
                gives fixed preview replies.
              </p>
              <div className="row">
                <Button variant="secondary" onClick={() => props.goTo('rules')}>
                  Review rules
                </Button>
                <Button variant="secondary" onClick={props.onTestInChat}>
                  Test in chat
                </Button>
              </div>
            </section>
          ) : null}

          {step === 3 ? (
            <section className="xoi-card">
              <h2>Publish</h2>
              <p className="notice notice-info small">
                Not available yet. Publishing needs a signed .xo package, and Studio cannot package or sign. Your XO stays in this workspace.
              </p>
              {built !== undefined ? (
                <Button variant="primary" onClick={() => props.onOpenXo(built.compilationId)}>
                  Open XO
                </Button>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>

      <div className="cx-foot">
        <Button variant="secondary" disabled={step === 0} onClick={() => go(step - 1)}>
          Back
        </Button>
        <span className="cx-foot-right">
          {step === 1 ? (
            <>
              <Badge tone="neutral">Preview</Badge>
              <Button variant="secondary" onClick={props.onTestInChat}>
                Test in chat
              </Button>
            </>
          ) : null}
          {step < STEPS.length - 1 ? (
            <Button variant="primary" disabled={!canContinue} onClick={() => go(step + 1)}>
              {step === 0 ? 'Continue to Build' : step === 1 ? 'Continue to Test' : 'Continue to Publish'}
            </Button>
          ) : null}
        </span>
      </div>
    </section>
  );
}
