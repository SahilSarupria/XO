import { useState } from 'react';
import { can, whyNot } from '../domain/access';
import type { ApiProblem } from '../platform/client';
import type { WorkspaceRole } from '../platform/wire';
import type { AddResult } from './useDocuments';
import { Button, ProblemNotice } from './primitives';
import { Icon } from './icons';

/**
 * Add a document by link or pasted text. The role check only hides/disables the controls as a hint: the platform still
 * decides, and its refusal (for example air-gapped mode, HTTP 412) is shown as it came.
 */
export function AddByLinkOrText(props: {
  role: WorkspaceRole | undefined;
  importLink: (url: string) => Promise<AddResult>;
  addText: (name: string, text: string) => Promise<AddResult>;
}) {
  const [mode, setMode] = useState<'link' | 'text'>('link');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | string | undefined>();
  const allowed = can(props.role, 'author');

  async function submit() {
    setBusy(true);
    setProblem(undefined);
    const r = mode === 'link' ? await props.importLink(url) : await props.addText(name, text);
    setBusy(false);
    if (r.ok) {
      setUrl('');
      setName('');
      setText('');
    } else setProblem(r.problem);
  }

  return (
    <div className="add-link-text">
      <div className="alt-tabs" role="group" aria-label="Add by">
        <button type="button" aria-pressed={mode === 'link'} onClick={() => setMode('link')}>
          <Icon name="link" size={15} />
          From a link
        </button>
        <button type="button" aria-pressed={mode === 'text'} onClick={() => setMode('text')}>
          <Icon name="text" size={15} />
          Paste text
        </button>
      </div>
      {mode === 'link' ? (
        <label>
          Link to a document
          <input type="url" value={url} placeholder="https://…" disabled={!allowed || busy} onChange={(e) => setUrl(e.target.value)} />
        </label>
      ) : (
        <>
          <label>
            Name
            <input
              type="text"
              value={name}
              placeholder="Pasted text"
              disabled={!allowed || busy}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Text
            <textarea rows={4} value={text} disabled={!allowed || busy} onChange={(e) => setText(e.target.value)} />
          </label>
        </>
      )}
      <Button
        variant="secondary"
        disabled={!allowed || busy || (mode === 'link' ? url.trim() === '' : text.trim() === '')}
        onClick={() => void submit()}
      >
        {busy ? 'Adding…' : mode === 'link' ? 'Import link' : 'Add text'}
      </Button>
      {!allowed ? <p className="muted small">{whyNot(props.role, 'author', 'adding documents')}</p> : null}
      {typeof problem === 'string' ? (
        <div className="notice notice-warning" role="alert">
          {problem}
        </div>
      ) : problem !== undefined ? (
        <ProblemNotice problem={problem} />
      ) : null}
    </div>
  );
}
