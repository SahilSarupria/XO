import { useMemo, useState, type DragEvent } from 'react';
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
import { Icon, type IconName } from './icons';
import type { WorkspaceRole } from '../platform/wire';
import '../styles/sources.css';

type Stage = 'new' | 'running' | 'done' | 'failed';
const FILTERS: readonly { id: 'all' | Stage; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'new', label: 'Not analysed' },
  { id: 'done', label: 'Analysed' },
  { id: 'failed', label: 'Did not finish' },
];

/** A file-type tile from the extension alone. Decoration only: it says nothing about the file's content. */
export function iconFor(filename: string): { icon: IconName; label: string } {
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'tif', 'tiff', 'bmp'].includes(ext)) return { icon: 'image', label: ext.toUpperCase() };
  if (['csv', 'xlsx', 'xls', 'tsv'].includes(ext)) return { icon: 'table', label: ext.toUpperCase() };
  if (['json', 'html', 'htm', 'xml', 'yaml', 'yml'].includes(ext)) return { icon: 'code', label: ext.toUpperCase() };
  if (['txt', 'md', 'markdown'].includes(ext)) return { icon: 'text', label: ext.toUpperCase() };
  return { icon: 'file', label: ext === '' ? 'FILE' : ext.toUpperCase() };
}

/** The latest analysis for each document: the platform's records, newest wins. */
export function latestBySource(compilations: readonly Compilation[]): Map<string, Compilation> {
  const m = new Map<string, Compilation>();
  for (const c of compilations) {
    const prev = m.get(c.sourceId);
    if (prev === undefined || c.createdAt > prev.createdAt) m.set(c.sourceId, c);
  }
  return m;
}
export const stageOf = (c: Compilation | undefined): Stage =>
  c === undefined ? 'new' : c.status === 'succeeded' ? 'done' : c.status === 'failed' ? 'failed' : 'running';

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
  const [over, setOver] = useState(false);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | Stage>('all');

  const sources = useMemo(
    () => (props.sources.phase === 'ready' ? [...props.sources.value].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : []),
    [props.sources],
  );
  const latest = useMemo(() => latestBySource(props.compilations), [props.compilations]);
  const count = (s: Stage) => sources.filter((x) => stageOf(latest.get(x.sourceId)) === s).length;
  const shown = sources.filter(
    (s) =>
      (filter === 'all' || stageOf(latest.get(s.sourceId)) === filter) && s.originalFilename.toLowerCase().includes(q.trim().toLowerCase()),
  );
  const toolbar = sources.length >= 4;

  const drag = (e: DragEvent<HTMLDivElement>, entering: boolean) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    setOver(entering);
  };
  const drop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    void onFiles(e.dataTransfer.files);
  };

  return (
    <Section
      id="context-h"
      title="Context"
      lede="What you give XO to learn from. XO reads each one, finds the rules inside, and keeps the evidence for every rule."
    >
      <div className="src-add">
        <div
          className="src-drop"
          data-over={over}
          onDragEnter={(e) => drag(e, true)}
          onDragOver={(e) => drag(e, true)}
          onDragLeave={(e) => drag(e, false)}
          onDrop={drop}
        >
          <span className="src-drop-icon" aria-hidden="true">
            <Icon name="upload" size={22} />
          </span>
          <div className="src-drop-text">
            <strong>{over ? 'Drop to add' : 'Drop files here'}</strong>
            <span className="muted small">or choose from your computer. You can add several at once.</span>
          </div>
          <input
            ref={fileInput}
            id="file-upload"
            type="file"
            multiple
            className="visually-hidden"
            accept={SUPPORTED_UPLOAD_EXTENSIONS.join(',')}
            onChange={(e) => void onFiles(e.target.files)}
          />
          <Button variant="primary" disabled={uploading} onClick={() => fileInput.current?.click()}>
            {uploading ? 'Uploading…' : 'Add a document'}
          </Button>
          <ul className="src-types" aria-label="Supported file types">
            {SUPPORTED_UPLOAD_EXTENSIONS.map((x) => (
              <li key={x}>{x.replace('.', '')}</li>
            ))}
          </ul>
        </div>
        <AddByLinkOrText role={props.role} importLink={importLink} addText={addText} />
      </div>
      <p className="muted small src-trust">Uploaded files are treated as untrusted data: they are stored, hashed and read — never run.</p>

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

      {sources.length > 0 ? (
        <div className="src-bar">
          <p className="src-summary" role="status">
            {sources.length} {sources.length === 1 ? 'document' : 'documents'} · {count('done')} analysed
            {count('new') > 0 ? ` · ${count('new')} waiting` : ''}
            {count('failed') > 0 ? ` · ${count('failed')} did not finish` : ''}
          </p>
          {toolbar ? (
            <>
              <div className="src-search">
                <Icon name="search" size={16} />
                <label className="visually-hidden" htmlFor="src-q">
                  Search documents
                </label>
                <input id="src-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search documents…" />
              </div>
              <div className="src-filters" role="group" aria-label="Filter documents">
                {FILTERS.map((f) => (
                  <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                    {f.label}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      {toolbar && shown.length === 0 ? <p className="muted">No document matches. Clear the search or the filter to see them all.</p> : null}

      <ul className="src-list">
        {shown.map((s) => {
          const c = latest.get(s.sourceId);
          const stage = stageOf(c);
          const failure = analysisFailure?.sourceId === s.sourceId ? analysisFailure : undefined;
          const kind = iconFor(s.originalFilename);
          return (
            <li key={s.sourceId} className="src-row" data-stage={stage}>
              <span className="src-file" aria-hidden="true">
                <Icon name={kind.icon} size={20} />
                <span>{kind.label}</span>
              </span>
              <div className="src-main">
                <h3 title={s.originalFilename}>{s.originalFilename}</h3>
                <p className="muted small">
                  {formatBytes(s.byteSize)} · added {formatWhen(s.createdAt)}
                  {mode === 'builder' ? (
                    <span className="mono">
                      {' '}
                      · {s.sourceId} · sha256 {s.digestSha256.slice(0, 12)}…
                    </span>
                  ) : null}
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
              <div className="src-status">
                {c === undefined ? (
                  <Badge tone="neutral">Not analysed yet</Badge>
                ) : c.status === 'succeeded' ? (
                  <Badge tone="success">Analysed {formatWhen(c.completedAt ?? c.createdAt)}</Badge>
                ) : c.status === 'failed' ? (
                  <Badge tone="danger">Analysis did not finish</Badge>
                ) : (
                  <Badge tone="neutral">Analysing</Badge>
                )}
              </div>
              <div className="src-actions">
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
