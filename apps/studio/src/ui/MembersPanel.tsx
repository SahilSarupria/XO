import { useState } from 'react';
import { can, roleLabel, whyNot } from '../domain/access';
import { WORKSPACE_ROLES, type WorkspaceRole } from '../platform/wire';
import type { ApiProblem } from '../platform/client';
import { Badge, Button, EmptyState, formatWhen, loadedValue, ProblemNotice, Skeleton, useLoad } from './primitives';
import { useSession } from './session';

/**
 * Members and roles. People are added by IDENTITY ID, exactly as the platform provides it: there is no email invitation
 * (the platform has no mail service), so none is offered or implied. Whether the buttons are enabled is only a hint from
 * the caller's role; the platform decides, and a refusal is shown as a permission notice.
 */
export function MembersPanel(props: { workspaceId: string; role: WorkspaceRole | undefined; personal: boolean }) {
  const { client } = useSession();
  const members = useLoad(() => client.listMembers(props.workspaceId), [client, props.workspaceId]);
  const [identityId, setIdentityId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<WorkspaceRole>('viewer');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const canManage = can(props.role, 'manage');
  const disabledReason = !canManage
    ? whyNot(props.role, 'manage', 'managing members')
    : props.personal
      ? 'A personal workspace is for one person and cannot have members.'
      : undefined;

  async function run(action: () => Promise<{ ok: boolean; problem?: ApiProblem }>) {
    setBusy(true);
    setProblem(undefined);
    const r = await action();
    setBusy(false);
    if (!r.ok && r.problem !== undefined) setProblem(r.problem);
    else members.reload();
    return r.ok;
  }

  const list = loadedValue(members.state);
  return (
    <>
      <h3>Members and roles</h3>
      <p className="muted small">
        Roles decide what each person can do here. Studio shows or disables controls to match, but the platform makes the final decision on
        every request.
      </p>
      {members.state.phase === 'loading' ? <Skeleton label="Loading members" rows={3} /> : null}
      {members.state.phase === 'error' ? <ProblemNotice problem={members.state.problem} onRetry={members.reload} /> : null}
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
      {list !== undefined ? (
        <>
          <ul className="bare-list" aria-label="Role counts">
            {WORKSPACE_ROLES.map((r) => (
              <li key={r} className="row between">
                <span>{roleLabel(r)}</span>
                <span className="mono">{list.roleCounts[r]}</span>
              </li>
            ))}
          </ul>
          {list.members.length === 0 ? <EmptyState title="No members yet" /> : null}
          <div className="table" role="table" aria-label="Members">
            <div className="table-head" role="row">
              <span role="columnheader">Person</span>
              <span role="columnheader">Role</span>
              <span role="columnheader">Added</span>
              <span role="columnheader">
                <span className="visually-hidden">Actions</span>
              </span>
            </div>
            {list.members.map((m) => (
              <div key={m.identityId} className="table-row" role="row">
                <span role="cell">
                  {m.displayName ?? m.identityId}
                  {m.displayName !== undefined ? <span className="mono muted small"> · {m.identityId}</span> : null}
                  {m.isOwner ? <Badge tone="accent">Owner</Badge> : null}
                </span>
                <span role="cell">
                  {m.isOwner ? (
                    roleLabel(m.role)
                  ) : (
                    <select
                      aria-label={`Role for ${m.displayName ?? m.identityId}`}
                      value={m.role}
                      disabled={busy || !canManage}
                      title={disabledReason}
                      onChange={(e) =>
                        void run(() => client.changeMemberRole(props.workspaceId, m.identityId, e.target.value as WorkspaceRole))
                      }
                    >
                      {WORKSPACE_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {roleLabel(r)}
                        </option>
                      ))}
                    </select>
                  )}
                </span>
                <span role="cell" className="mono muted small">
                  {m.addedAt !== undefined ? formatWhen(m.addedAt) : '—'}
                </span>
                <span role="cell">
                  {m.isOwner ? null : (
                    <Button
                      variant="quiet"
                      disabled={busy || !canManage}
                      title={disabledReason}
                      aria-label={`Remove ${m.displayName ?? m.identityId}`}
                      onClick={() => void run(() => client.removeMember(props.workspaceId, m.identityId))}
                    >
                      Remove
                    </Button>
                  )}
                </span>
              </div>
            ))}
          </div>
          <h3>Add a person</h3>
          <p className="muted small">Enter the identity ID the platform gave them. There is no email invitation: nothing is sent.</p>
          <form
            className="field-row"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() =>
                client.addMember(props.workspaceId, {
                  identityId: identityId.trim(),
                  role,
                  ...(displayName.trim() !== '' ? { displayName: displayName.trim() } : {}),
                }),
              ).then((ok) => {
                if (ok) {
                  setIdentityId('');
                  setDisplayName('');
                }
              });
            }}
          >
            <label className="field">
              Identity ID
              <input
                value={identityId}
                onChange={(e) => setIdentityId(e.target.value)}
                disabled={busy || disabledReason !== undefined}
                autoComplete="off"
              />
            </label>
            <label className="field">
              Name (optional)
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={busy || disabledReason !== undefined}
                autoComplete="off"
              />
            </label>
            <label className="field">
              Role
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as WorkspaceRole)}
                disabled={busy || disabledReason !== undefined}
              >
                {WORKSPACE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {roleLabel(r)}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="primary"
              type="submit"
              disabled={busy || disabledReason !== undefined || identityId.trim() === ''}
              title={disabledReason}
            >
              Add person
            </Button>
          </form>
          {disabledReason !== undefined ? <p className="muted small">{disabledReason}</p> : null}
        </>
      ) : null}
    </>
  );
}
