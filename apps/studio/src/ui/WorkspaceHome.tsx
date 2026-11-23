import { useState, type FormEvent, type ReactNode } from 'react';
import type { ApiProblem } from '../platform/client';
import { Button, EmptyState, ProblemNotice, Skeleton, useLoad } from './primitives';
import { useSession } from './session';
import { AppChrome } from './AppChrome';
import { WorkspaceView } from './WorkspaceView';
import { ChooseWorkspace } from './ChooseWorkspace';
import { workspaceInPath } from './sectionRoute';

export function WorkspaceHome(props: { account: ReactNode }) {
  const { client, signOut } = useSession();
  const { state, reload } = useLoad(() => client.listWorkspaces(), [client]);
  // S1-3: a link to a workspace (`/w/<id>/…`) opens that workspace, when the person is a member of it; otherwise the chooser.
  const [selected, setSelected] = useState<string | undefined>(() => workspaceInPath(window.location.pathname));
  const [creating, setCreating] = useState(false);
  /** With several workspaces, the person chooses one on arrival; a single workspace opens directly. */
  const [chosen, setChosen] = useState(false);

  if (state.phase === 'loading')
    return (
      <AppChrome account={props.account}>
        <main className="page">
          <Skeleton label="Loading your workspaces" />
        </main>
      </AppChrome>
    );
  if (state.phase === 'error')
    return (
      <AppChrome account={props.account}>
        <main className="page">
          <ProblemNotice problem={state.problem} onRetry={reload} />
        </main>
      </AppChrome>
    );

  const workspaces = state.value;
  // A link to a workspace this person cannot open is treated as no link: nothing about it is shown.
  const linked = selected !== undefined && workspaces.some((w) => w.workspaceId === selected);
  if (!chosen && !creating && !linked && workspaces.length > 1)
    return (
      <ChooseWorkspace
        workspaces={workspaces}
        onOpen={(id) => {
          setSelected(id);
          setChosen(true);
        }}
        onCreate={() => setCreating(true)}
        onSwitchAccount={signOut}
      />
    );

  // Creating takes over the screen even when a workspace is already selected; Cancel returns to it.
  const active = creating ? undefined : (workspaces.find((w) => linked && w.workspaceId === selected) ?? workspaces[0]);

  if (active === undefined) {
    return (
      <AppChrome account={props.account}>
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
      </AppChrome>
    );
  }

  return (
    <WorkspaceView
      key={active.workspaceId}
      workspace={active}
      workspaces={workspaces}
      onSelectWorkspace={setSelected}
      onNewWorkspace={() => setCreating(true)}
      frame={(parts) => (
        <AppChrome
          nav={parts.nav}
          layout={parts.layout}
          rail={parts.rail}
          {...(parts.bottomBar !== undefined ? { bottomBar: parts.bottomBar } : {})}
        >
          {parts.content}
        </AppChrome>
      )}
    />
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
          A workspace holds the documents, workflows and people for one team or one area of work.
        </EmptyState>
      ) : (
        <h2>New workspace</h2>
      )}
      <form onSubmit={(e) => void submit(e)} className="stack">
        <label htmlFor="ws-name">Workspace name</label>
        <input id="ws-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Operations" maxLength={120} />
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
