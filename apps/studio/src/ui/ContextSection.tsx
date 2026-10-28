import { SUPPORTED_UPLOAD_EXTENSIONS } from '../platform/client';
import type { Compilation, Source } from '../platform/wire';
import {
  Badge,
  Button,
  EmptyState,
  formatBytes,
  formatWhen,
  ProblemNotice,
  Section,
  Skeleton,
  Spinner,
  type LoadState,
} from './primitives';
import { useSession } from './session';
import { useDocuments } from './useDocuments';
import { AddByLinkOrText } from './AddByLinkOrText';
import type { WorkspaceRole } from '../platform/wire';

export function ContextSection(props: {
  workspaceId: string;
  role?: WorkspaceRole | undefined;
  sources: LoadState<Source[]>;
  compilations: Compilation[];
  onChanged: () => void;
  onAnalysed: (c: Compilation) => void;
}) {
  const { mode } = useSession();
  const { fileInput, uploading, uploadProblem, analysing, analysisFailure, onFiles, analyse, importLink, addText } = useDocuments(props);

  const sources = props.sources.phase === 'ready' ? props.sources.value : [];
  const latestBySource = new Map<string, Compilation>();
  for (const c of props.compilations) {
    const prev = latestBySource.get(c.sourceId);
    if (prev === undefined || c.createdAt > prev.createdAt) latestBySource.set(c.sourceId, c);
  }

  return (
    <Section
      id="context-h"
      title="Context"
      lede="Documents XO learns from. XO reads them, finds the rules inside, and keeps the evidence for each one."
      actions={
        <>
          <input
            ref={fileInput}
            id="file-upload"
            type="file"
            className="visually-hidden"
            accept={SUPPORTED_UPLOAD_EXTENSIONS.join(',')}
            onChange={(e) => void onFiles(e.target.files)}
          />
          <Button variant="primary" disabled={uploading} onClick={() => fileInput.current?.click()}>
            {uploading ? 'Uploading…' : 'Add a document'}
          </Button>
        </>
      }
    >
      <p className="muted small">Uploaded files are treated as untrusted data: they are stored, hashed and read — never run.</p>
      <AddByLinkOrText role={props.role} importLink={importLink} addText={addText} />
      {typeof uploadProblem === 'string' ? (
        <div className="notice notice-warning" role="alert">
          {uploadProblem}
        </div>
      ) : uploadProblem !== undefined ? (
        <ProblemNotice problem={uploadProblem} />
      ) : null}
      {props.sources.phase === 'loading' ? <Skeleton label="Loading documents" rows={2} /> : null}
      {props.sources.phase === 'ready' && sources.length === 0 ? (
        <EmptyState title="No documents yet">
          Add a policy, procedure or rulebook to get started. Supported: PDF, HTML, text, Markdown, CSV, JSON and images.
        </EmptyState>
      ) : null}
      <ul className="list">
        {sources.map((s) => {
          const c = latestBySource.get(s.sourceId);
          const failure = analysisFailure?.sourceId === s.sourceId ? analysisFailure : undefined;
          return (
            <li key={s.sourceId} className="card">
              <div className="card-main">
                <h3>{s.originalFilename}</h3>
                <p className="muted small">
                  {formatBytes(s.byteSize)} · added {formatWhen(s.createdAt)}
                  {mode === 'builder' ? (
                    <span className="mono">
                      {' '}
                      · {s.sourceId} · sha256 {s.digestSha256.slice(0, 12)}…
                    </span>
                  ) : null}
                </p>
                <p>
                  {c === undefined ? (
                    <Badge tone="neutral">Not analysed yet</Badge>
                  ) : c.status === 'succeeded' ? (
                    <Badge tone="success">Analysed {formatWhen(c.completedAt ?? c.createdAt)}</Badge>
                  ) : c.status === 'failed' ? (
                    <Badge tone="danger">Analysis did not finish</Badge>
                  ) : (
                    <Badge tone="neutral">Analysing</Badge>
                  )}
                </p>
                {failure !== undefined ? (
                  <div className="notice notice-danger" role="alert">
                    <strong>{failure.view.title}</strong>
                    <p>{failure.view.body}</p>
                    <p className="muted">{failure.view.next}</p>
                    {mode === 'builder' && failure.code !== undefined ? <p className="mono small">{failure.code}</p> : null}
                  </div>
                ) : null}
              </div>
              <div className="card-actions">
                {analysing === s.sourceId ? (
                  <Spinner label="Analysing" />
                ) : (
                  <Button
                    variant={c === undefined ? 'primary' : 'secondary'}
                    onClick={() => void analyse(s)}
                    disabled={analysing !== undefined}
                  >
                    {c === undefined ? 'Analyse' : 'Analyse again'}
                  </Button>
                )}
                {c?.status === 'succeeded' ? (
                  <Button variant="quiet" onClick={() => props.onAnalysed(c)}>
                    See what XO found
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
