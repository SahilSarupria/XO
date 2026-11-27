import { useState } from 'react';
import { can, roleLabel, whyNot } from '../domain/access';
import type { WorkspaceRole } from '../platform/wire';
import type { ApiProblem } from '../platform/client';
import type { InvitationView } from '../platform/wire-invites';
import { useQuery, wsKey } from '../platform/query';
import { Button, Field, Select } from './kit';
import { formatWhen, loadedValue, ProblemNotice } from './primitives';
import { useSession } from './session';

const LINK_ROLES = ['viewer', 'reviewer', 'publisher'] as const;
const STATE_WORDS: Readonly<Record<InvitationView['state'], string>> = {
  pending: 'Waiting to be used',
  used: 'Used',
  revoked: 'Taken back',
  expired: 'Expired',
};

/**
 * Invitation links. Made here, handed over by the inviter (nothing is emailed), good for one person and for seven days, and never
 * for an administrator. The link is shown once, when it is made: the platform keeps only a fingerprint of it, so it cannot be shown
 * again. Taking a link back is one click. What a role may do is the platform's decision; this only shows it.
 */
export function InvitePanel(props: { workspaceId: string; role: WorkspaceRole | undefined }) {
  const { client } = useSession();
  const manage = can(props.role, 'manage');
  const list = useQuery(wsKey(props.workspaceId, 'invitations'), () => client.listInvitations(props.workspaceId));
  const invitations = loadedValue(list.state) ?? [];
  const [role, setRole] = useState<(typeof LINK_ROLES)[number]>('viewer');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [link, setLink] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);

  async function make() {
    setBusy(true);
    setProblem(undefined);
    setCopied(false);
    const r = await client.createInvitation(props.workspaceId, role);
    setBusy(false);
    if (!r.ok) return setProblem(r.problem);
    // The token goes after the # so it is not sent to a server in a page request or kept in its logs.
    setLink(`${window.location.origin}/join#${r.value.token}`);
    list.reload();
  }
  async function takeBack(id: string) {
    setBusy(true);
    setProblem(undefined);
    const r = await client.revokeInvitation(props.workspaceId, id);
    setBusy(false);
    if (!r.ok) return setProblem(r.problem);
    list.reload();
  }
  async function copy() {
    if (link === undefined) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section aria-labelledby="invite-h" className="stack">
      <h3 id="invite-h">Invite someone</h3>
      <p className="muted small">
        Make a link and send it to them yourself: nothing is emailed from here. It works once and for 7 days. They sign in, open it and join
        with the role you choose.
      </p>
      <div className="field-row">
        <Field label="What they can do">
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value as (typeof LINK_ROLES)[number])}
            options={LINK_ROLES.map((r) => ({ value: r, label: roleLabel(r) }))}
          />
        </Field>
        <Button
          variant="primary"
          loading={busy}
          disabledReason={manage ? undefined : whyNot(props.role, 'manage', 'inviting people')}
          onClick={() => void make()}
        >
          Make an invitation link
        </Button>
      </div>
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
      {link !== undefined ? (
        <div className="notice notice-success" role="status">
          <p>Here is the link. Copy it now: it cannot be shown again. If it is lost, take it back and make another.</p>
          <p className="mono small" data-testid="invite-link">
            {link}
          </p>
          <Button variant="secondary" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy the link'}
          </Button>
        </div>
      ) : null}
      {invitations.length > 0 ? (
        <ul className="bare-list" aria-label="Invitations">
          {invitations.map((i) => (
            <li key={i.invitationId} className="row between">
              <span>
                {roleLabel(i.role as WorkspaceRole)}: {STATE_WORDS[i.state]}
                <span className="muted small">
                  {' '}
                  {i.state === 'pending' ? `· until ${formatWhen(i.expiresAt)}` : i.usedAt !== undefined ? `· ${formatWhen(i.usedAt)}` : ''}
                </span>
              </span>
              {i.state === 'pending' ? (
                <Button
                  variant="quiet"
                  loading={busy}
                  disabledReason={manage ? undefined : whyNot(props.role, 'manage', 'taking back an invitation')}
                  aria-label={`Take back the ${roleLabel(i.role as WorkspaceRole)} link`}
                  onClick={() => void takeBack(i.invitationId)}
                >
                  Take back
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
