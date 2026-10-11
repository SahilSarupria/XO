import { useState, type FormEvent } from 'react';
import type { ApiProblem } from '../platform/client';
import { Button, EmptyState, ProblemNotice, Spinner, useLoad } from './primitives';
import { useSession } from './session';
import { WorkspaceView } from './WorkspaceView';

export function WorkspaceHome() {
  const { client } = useSession();
  const { state, reload } = useLoad(() => client.listWorkspaces(), [client]);
  const [selected, setSelected] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);

  if (state.phase === 'loading')
    return (
      <main className="page">
        <Spinner label="Loading your workspaces" />
      </main>
    );
  if (state.phase === 'error')
    return (
      <main className="page">
        <ProblemNotice problem={state.problem} onRetry={reload} />
      </main>
    );

  const workspaces = state.value;
  const active = workspaces.find((w) => w.workspaceId === selected) ?? (creating ? undefined : workspaces[0]);

  if (active === undefined) {
    return (
      <main className="page narrow">
        <CreateWorkspace
          first={workspaces.length === 0}
          onCreated={(id) => {
            setCreating(false);
            setSelected(id);
            reload();
          }}
          onCancel={workspaces.length > 0 ? () => setCreating(false) : undefined}
        />
      </main>
    );
  }

  return (
    <>
      <nav className="workspace-bar" aria-label="Workspace">
        <label htmlFor="workspace-select" className="visually-hidden">
          Workspace
        </label>
        <select id="workspace-select" value={active.workspaceId} onChange={(e) => setSelected(e.target.value)}>
          {workspaces.map((w) => (
            <option key={w.workspaceId} value={w.workspaceId}>
              {w.name ?? 'Untitled workspace'}
            </option>
          ))}
        </select>
        <Button variant="quiet" onClick={() => setCreating(true)}>
          New workspace
        </Button>
      </nav>
      <WorkspaceView key={active.workspaceId} workspace={active} />
    </>
  );
}

function CreateWorkspace(props: { first: boolean; onCreated: (workspaceId: string) => void; onCancel: (() => void) | undefined }) {
  const { client } = useSession();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || name.trim().length === 0) return;
    setBusy(true);
    setProblem(undefined);
    const r = await client.createWorkspace(name.trim());
    setBusy(false);
    if (r.ok) props.onCreated(r.value.workspaceId);
    else setProblem(r.problem);
  }

  return (
    <div className="stack">
      {props.first ? (
        <EmptyState title="Start with a workspace">
          A workspace holds one body of organisational context — for example, a team&rsquo;s claims rules or a department&rsquo;s
          procedures.
        </EmptyState>
      ) : (
        <h2>New workspace</h2>
      )}
      <form onSubmit={(e) => void submit(e)} className="stack">
        <label htmlFor="ws-name">Workspace name</label>
        <input
          id="ws-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Commercial property claims"
          maxLength={120}
        />
        {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
        <div className="row">
          <Button type="submit" variant="primary" disabled={busy || name.trim().length === 0}>
            {busy ? 'Creating…' : 'Create workspace'}
          </Button>
          {props.onCancel !== undefined ? (
            <Button variant="quiet" onClick={props.onCancel}>
              Cancel
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
