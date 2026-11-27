import { useEffect, useState, type ReactNode } from 'react';
import { roleLabel } from '../domain/access';
import type { WorkspaceRole } from '../platform/wire';
import { Button } from './kit';
import { AppChrome } from './AppChrome';
import { useSession } from './session';

/** The address an invitation link opens: `/join#<token>`. The token is after the # so it is never part of a page request. */
export const JOIN_PATH = '/join';

const usePath = (): string => {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
};

/** Shows the join page at `/join`, and the rest of the app everywhere else. */
export function JoinGate(props: { account: ReactNode; children: ReactNode }) {
  return usePath() === JOIN_PATH ? <JoinPage account={props.account} /> : <>{props.children}</>;
}

type Phase =
  { kind: 'ready' } | { kind: 'busy' } | { kind: 'joined'; workspaceId: string; role: string } | { kind: 'failed'; already: boolean };

/**
 * Joining from an invitation link. The person has signed in first (this page is inside the signed-in app). The token is read from
 * the address once and then taken out of it, so it is not left in the address bar or the history. Every reason a link fails reads
 * the same here, because the platform answers the same: it may have been used, taken back or have expired.
 */
function JoinPage(props: { account: ReactNode }) {
  const { client } = useSession();
  const [token] = useState(() => window.location.hash.replace(/^#/, ''));
  const [phase, setPhase] = useState<Phase>({ kind: 'ready' });
  useEffect(() => {
    if (window.location.hash !== '') window.history.replaceState(null, '', JOIN_PATH);
  }, []);

  async function join() {
    setPhase({ kind: 'busy' });
    const r = await client.acceptInvitation(token);
    if (r.ok) setPhase({ kind: 'joined', workspaceId: r.value.workspaceId, role: r.value.role });
    else setPhase({ kind: 'failed', already: r.problem.status === 409 });
  }
  function open(workspaceId: string) {
    window.history.pushState(null, '', `/w/${encodeURIComponent(workspaceId)}/home`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  return (
    <AppChrome account={props.account}>
      <main className="page narrow">
        <h1>Join a workspace</h1>
        {token === '' || (phase.kind === 'failed' && !phase.already) ? (
          <div className="notice notice-danger" role="alert">
            <p>This link does not work. It may have been used, taken back or have expired. Ask the person who sent it for a new one.</p>
          </div>
        ) : null}
        {phase.kind === 'failed' && phase.already ? (
          <div className="notice notice-info" role="status">
            <p>You already have access to this workspace. Nothing was changed.</p>
          </div>
        ) : null}
        {phase.kind === 'joined' ? (
          <div className="notice notice-success" role="status">
            <p>You have joined. You can {roleCan(phase.role)}.</p>
            <Button variant="primary" onClick={() => open(phase.workspaceId)}>
              Open the workspace
            </Button>
          </div>
        ) : null}
        {token !== '' && (phase.kind === 'ready' || phase.kind === 'busy') ? (
          <>
            <p>
              You have been invited to join a workspace. Joining gives you the access the person who made this link chose. It works once.
            </p>
            <Button variant="primary" loading={phase.kind === 'busy'} onClick={() => void join()}>
              Join this workspace
            </Button>
          </>
        ) : null}
      </main>
    </AppChrome>
  );
}

const roleCan = (role: string): string =>
  role === 'viewer'
    ? 'look at everything in it'
    : role === 'reviewer'
      ? 'look at everything and approve what needs a person'
      : role === 'publisher'
        ? `work in it and share what you make (${roleLabel(role as WorkspaceRole).toLowerCase()})`
        : 'work in it';
