import { useState } from 'react';
import { SUPPORTED_UPLOAD_EXTENSIONS } from '../platform/client';
import type { ReviewSummary } from '../domain/review';
import type { StartTarget } from '../domain/start';
import type { Compilation, Source } from '../platform/wire';
import { Badge, Button, formatBytes, formatWhen, ProblemNotice, Spinner, type LoadState } from './primitives';
import { useDocuments } from './useDocuments';
import '../styles/xo.css';

const STEPS = ['Source', 'Analyse', 'Review rules', 'Publish'] as const;

/**
 * Creating an XO from your own documents. Steps 1 to 3 are the real flow (upload, analyse, review); the state of each is
 * derived from what the workspace holds. Publishing is shown as not available, because Studio cannot package or sign.
 */
export function CreateXo(props: {
  workspaceId: string;
  sources: LoadState<Source[]>;
  compilations: readonly Compilation[];
  summary: ReviewSummary | undefined;
  onChanged: () => void;
  onOpenXo: (compilationId: string) => void;
  goTo: (t: StartTarget) => void;
}) {
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<string | undefined>();
  const [analysed, setAnalysed] = useState<Compilation | undefined>();
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
  const analysedHere = analysed ?? props.compilations.find((c) => c.sourceId === picked && c.status === 'succeeded');
  const go = (n: number) => setStep(Math.max(0, Math.min(STEPS.length - 1, n)));
  return (
    <section className="xoi" aria-labelledby="create-h">
      <button type="button" className="crumb-link xoi-back" onClick={() => props.goTo('documents')}>
        ← My XOs
      </button>
      <h1 id="create-h">Create XO</h1>
      <ol className="wiz-steps bare-list" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li key={label} aria-current={i === step ? 'step' : undefined} data-done={i < step}>
            <span className="wiz-n" aria-hidden="true">
              {i < step ? '✓' : i + 1}
            </span>{' '}
            {label}
            {i < step ? <span className="visually-hidden"> (done)</span> : null}
          </li>
        ))}
      </ol>

      <div className="xoi-card" role="group" aria-label={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}>
        {step === 0 ? (
          <>
            <h2>Choose the document this XO is built from</h2>
            <input
              ref={docs.fileInput}
              id="wiz-upload"
              type="file"
              className="visually-hidden"
              aria-label="Choose a document to upload"
              accept={SUPPORTED_UPLOAD_EXTENSIONS.join(',')}
              onChange={(e) => void docs.onFiles(e.target.files)}
            />
            <Button variant="secondary" disabled={docs.uploading} onClick={() => docs.fileInput.current?.click()}>
              {docs.uploading ? 'Uploading…' : 'Upload a document'}
            </Button>
            {typeof docs.uploadProblem === 'string' ? (
              <div className="notice notice-warning" role="alert">
                {docs.uploadProblem}
              </div>
            ) : docs.uploadProblem !== undefined ? (
              <ProblemNotice problem={docs.uploadProblem} />
            ) : null}
            {sources.length === 0 ? (
              <p className="muted small">No documents yet. Supported: {SUPPORTED_UPLOAD_EXTENSIONS.join(', ')}.</p>
            ) : (
              <ul className="wiz-docs bare-list">
                {sources.map((s) => (
                  <li key={s.sourceId}>
                    <label>
                      <input type="radio" name="wiz-source" checked={picked === s.sourceId} onChange={() => setPicked(s.sourceId)} />{' '}
                      <strong>{s.originalFilename}</strong>{' '}
                      <span className="muted small">
                        {formatBytes(s.byteSize)} · added {formatWhen(s.createdAt)}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}

        {step === 1 ? (
          <>
            <h2>Analyse {source?.originalFilename ?? 'the document'}</h2>
            <p className="muted small">XO reads the document, finds the rules inside and keeps the evidence for each one.</p>
            {docs.analysing !== undefined ? <Spinner label="Analysing" /> : null}
            {docs.analysisFailure !== undefined ? (
              <div className="notice notice-danger" role="alert">
                <strong>{docs.analysisFailure.view.title}</strong>
                <p>{docs.analysisFailure.view.body}</p>
                <p className="muted">{docs.analysisFailure.view.next}</p>
              </div>
            ) : null}
            {analysedHere !== undefined ? (
              <p>
                <Badge tone="success">Analysed {formatWhen(analysedHere.completedAt ?? analysedHere.createdAt)}</Badge>
              </p>
            ) : null}
            {source !== undefined ? (
              <Button
                variant={analysedHere === undefined ? 'primary' : 'secondary'}
                disabled={docs.analysing !== undefined}
                onClick={() => void docs.analyse(source)}
              >
                {analysedHere === undefined ? 'Analyse' : 'Analyse again'}
              </Button>
            ) : null}
          </>
        ) : null}

        {step === 2 ? (
          <>
            <h2>Review the rules</h2>
            <p className="muted small">You approve every rule before a workflow may use it. Nothing is approved for you.</p>
            {props.summary !== undefined ? (
              <p>
                {props.summary.approved} approved · {props.summary.readyForReview} ready for review · {props.summary.needsAttention} need more information
              </p>
            ) : (
              <p className="muted small">The rules of this analysis have not loaded.</p>
            )}
            <Button variant="secondary" onClick={() => props.goTo('rules')}>
              Open the rules
            </Button>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <h2>Publish</h2>
            <p className="notice notice-info small">
              Not available yet. Publishing needs a signed .xo package, and Studio cannot package or sign. Your XO stays in this workspace.
            </p>
            {analysedHere !== undefined ? (
              <Button variant="primary" onClick={() => props.onOpenXo(analysedHere.compilationId)}>
                Open XO
              </Button>
            ) : (
              <p className="muted small">Analyse a document first; then the XO can be opened.</p>
            )}
          </>
        ) : null}
      </div>

      <div className="row between">
        <Button variant="quiet" disabled={step === 0} onClick={() => go(step - 1)}>
          Back
        </Button>
        {step < STEPS.length - 1 ? (
          <Button
            variant="primary"
            disabled={(step === 0 && picked === undefined) || (step === 1 && analysedHere === undefined)}
            onClick={() => go(step + 1)}
          >
            Next
          </Button>
        ) : null}
      </div>
    </section>
  );
}
