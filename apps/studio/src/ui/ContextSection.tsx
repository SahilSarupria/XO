import { useRef, useState } from 'react';
import { describeProblem, type ProblemView } from '../domain/review';
import { SUPPORTED_UPLOAD_EXTENSIONS, type ApiProblem } from '../platform/client';
import type { Compilation, Source } from '../platform/wire';
import { Badge, Button, EmptyState, formatBytes, formatWhen, ProblemNotice, Section, Spinner, type LoadState } from './primitives';
import { useSession } from './session';

export function ContextSection(props: {
  workspaceId: string;
  sources: LoadState<Source[]>;
  compilations: Compilation[];
  onChanged: () => void;
  onAnalysed: (c: Compilation) => void;
}) {
  const { client, mode } = useSession();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProblem, setUploadProblem] = useState<ApiProblem | string | undefined>();
  const [analysing, setAnalysing] = useState<string | undefined>();
  const [analysisFailure, setAnalysisFailure] = useState<{ sourceId: string; view: ProblemView; code?: string } | undefined>();

  async function onFiles(files: FileList | null) {
    const file = files?.[0];
    if (file === undefined) return;
    setUploadProblem(undefined);
    const ext = file.name.includes('.') ? `.${file.name.split('.').pop()!.toLowerCase()}` : '';
    // A convenience check only; the API enforces the same allowlist authoritatively.
    if (!SUPPORTED_UPLOAD_EXTENSIONS.includes(ext)) {
      setUploadProblem(`XO can read: ${SUPPORTED_UPLOAD_EXTENSIONS.join(', ')}. “${file.name}” is not one of those. Word documents are not supported yet.`);
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    setUploading(true);
    const r = await client.uploadSource(props.workspaceId, file);
    setUploading(false);
    if (fileInput.current) fileInput.current.value = '';
    if (r.ok) props.onChanged();
    else setUploadProblem(r.problem);
  }

  async function analyse(source: Source) {
    setAnalysing(source.sourceId);
    setAnalysisFailure(undefined);
    const r = await client.compileSource(props.workspaceId, source.sourceId);
    setAnalysing(undefined);
    if (!r.ok) {
      setAnalysisFailure({ sourceId: source.sourceId, view: describeProblem(r.problem), ...(r.problem.code !== undefined ? { code: r.problem.code } : {}) });
      return;
    }
    if (r.value.status === 'succeeded') props.onAnalysed(r.value);
    else {
      // The platform recorded a failed analysis. Say so; do not move the person forward.
      setAnalysisFailure({
        sourceId: source.sourceId,
        view: { title: 'XO could not analyse this document', body: r.value.errorMessage ?? 'The analysis did not finish.', next: 'Check that the file is readable and try again, or upload a different version.' },
        ...(r.value.errorCode !== undefined ? { code: r.value.errorCode } : {}),
      });
      props.onChanged();
    }
  }

  const sources = props.sources.phase === 'ready' ? props.sources.value : [];
  const latestBySource = new Map<string, Compilation>();
  for (const c of props.compilations) {
    const prev = latestBySource.get(c.sourceId);
    if (prev === undefined || c.createdAt > prev.createdAt) latestBySource.set(c.sourceId, c);
  }

  return (
    <Section id="context-h" title="Context" lede="Documents XO learns from. XO reads them, finds the rules inside, and keeps the evidence for each one." actions={
      <>
        <input ref={fileInput} id="file-upload" type="file" className="visually-hidden" accept={SUPPORTED_UPLOAD_EXTENSIONS.join(',')} onChange={(e) => void onFiles(e.target.files)} />
        <Button variant="primary" disabled={uploading} onClick={() => fileInput.current?.click()}>
          {uploading ? 'Uploading…' : 'Add a document'}
        </Button>
      </>
    }>
      <p className="muted small">Uploaded files are treated as untrusted data: they are stored, hashed and read — never run.</p>
      {typeof uploadProblem === 'string' ? <div className="notice notice-warning" role="alert">{uploadProblem}</div> : uploadProblem !== undefined ? <ProblemNotice problem={uploadProblem} /> : null}
      {props.sources.phase === 'loading' ? <Spinner label="Loading documents" /> : null}
      {props.sources.phase === 'ready' && sources.length === 0 ? <EmptyState title="No documents yet">Add a policy, procedure or rulebook to get started. Supported: PDF, HTML, text, Markdown, CSV, JSON and images.</EmptyState> : null}
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
                  {mode === 'builder' ? <span className="mono"> · {s.sourceId} · sha256 {s.digestSha256.slice(0, 12)}…</span> : null}
                </p>
                <p>
                  {c === undefined ? <Badge tone="neutral">Not analysed yet</Badge> : c.status === 'succeeded' ? <Badge tone="success">Analysed {formatWhen(c.completedAt ?? c.createdAt)}</Badge> : c.status === 'failed' ? <Badge tone="danger">Analysis did not finish</Badge> : <Badge tone="neutral">Analysing</Badge>}
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
                  <Button variant={c === undefined ? 'primary' : 'secondary'} onClick={() => void analyse(s)} disabled={analysing !== undefined}>
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
