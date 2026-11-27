/**
 * S1-9 — invitation links. An invitation cannot raise a role, works once, cannot be read from another workspace, fails the same
 * way however it fails, and the audit trail carries the invitation id and role but never the link, its secret or an address.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestServer } from './test-helpers.js';

async function withDirs<T>(fn: (d: { workspacesDir: string; workspaceDataDir: string }) => Promise<T>): Promise<T> {
  const workspacesDir = await mkdtemp(join(tmpdir(), 'xo-api-test-ws-'));
  const workspaceDataDir = await mkdtemp(join(tmpdir(), 'xo-api-test-wsdata-'));
  try {
    return await fn({ workspacesDir, workspaceDataDir });
  } finally {
    await rm(workspacesDir, { recursive: true, force: true });
    await rm(workspaceDataDir, { recursive: true, force: true });
  }
}
const as = (k: { apiKey: string }) => TestServer.authHeader(k.apiKey);

async function setup(dirs: { workspacesDir: string; workspaceDataDir: string }) {
  const server = await TestServer.start(dirs);
  const mk = async (name: string) =>
    (await server.request('POST', '/workspaces', { name, kind: 'team', region: 'in-mumbai' })).json<{ workspaceId: string }>().workspaceId;
  const ws = await mk('One');
  const other = await mk('Two');
  return { server, ws, other };
}

test('a link makes a member with the role it was made for, once', async () => {
  await withDirs(async (dirs) => {
    const { server, ws } = await setup(dirs);
    try {
      const guest = await server.issueAdditionalIdentity('guest-1');
      const second = await server.issueAdditionalIdentity('guest-2');
      const made = await server.request('POST', `/workspaces/${ws}/invitations`, { role: 'reviewer' });
      assert.equal(made.status, 201, made.bodyText);
      const { token, invitation } = made.json<{ token: string; invitation: { invitationId: string; role: string; state: string } }>();
      assert.equal(invitation.role, 'reviewer');
      assert.equal(invitation.state, 'pending');
      // The listing never carries the token or its secret.
      const listed = await server.request('GET', `/workspaces/${ws}/invitations`);
      assert.ok(!listed.bodyText.includes(token.split('.')[1]!), 'the secret is not listed');
      const joined = await server.request('POST', '/invitations/accept', { token }, as(guest));
      assert.equal(joined.status, 200, joined.bodyText);
      assert.deepEqual(joined.json(), { workspaceId: ws, role: 'reviewer' });
      const members = (await server.request('GET', `/workspaces/${ws}/members`)).json<{
        members: { identityId: string; role: string }[];
      }>();
      assert.equal(members.members.find((m) => m.identityId === 'guest-1')?.role, 'reviewer');
      // Used: nobody else gets in with it, and it fails like a link that never existed.
      const again = await server.request('POST', '/invitations/accept', { token }, as(second));
      assert.equal(again.status, 404);
      const never = await server.request('POST', '/invitations/accept', { token: `${ws}.${'x'.repeat(43)}` }, as(second));
      assert.equal(never.status, 404);
      assert.equal(again.bodyText, never.bodyText.replace(/x{43}/, ''), 'same refusal');
    } finally {
      await server.stop();
    }
  });
});

test('an invitation cannot raise a role: admin is refused, and accepting never changes an existing member', async () => {
  await withDirs(async (dirs) => {
    const { server, ws } = await setup(dirs);
    try {
      const admin = await server.request('POST', `/workspaces/${ws}/invitations`, { role: 'admin' });
      assert.equal(admin.status, 400);
      const viewer = await server.issueAdditionalIdentity('already-viewer');
      await server.request('POST', `/workspaces/${ws}/members`, { identityId: 'already-viewer', role: 'viewer' });
      const made = (await server.request('POST', `/workspaces/${ws}/invitations`, { role: 'publisher' })).json<{ token: string }>();
      const res = await server.request('POST', '/invitations/accept', { token: made.token }, as(viewer));
      assert.equal(res.status, 409);
      const members = (await server.request('GET', `/workspaces/${ws}/members`)).json<{
        members: { identityId: string; role: string }[];
      }>();
      assert.equal(members.members.find((m) => m.identityId === 'already-viewer')?.role, 'viewer', 'the role did not move');
      // A refused accept does not spend the link.
      const guest = await server.issueAdditionalIdentity('late-guest');
      assert.equal((await server.request('POST', '/invitations/accept', { token: made.token }, as(guest))).status, 200);
      // Only someone who may manage makes or lists links.
      const reviewer = await server.issueAdditionalIdentity('a-reviewer');
      await server.request('POST', `/workspaces/${ws}/members`, { identityId: 'a-reviewer', role: 'reviewer' });
      assert.equal((await server.request('POST', `/workspaces/${ws}/invitations`, { role: 'viewer' }, as(reviewer))).status, 403);
      assert.equal((await server.request('GET', `/workspaces/${ws}/invitations`, undefined, as(reviewer))).status, 403);
    } finally {
      await server.stop();
    }
  });
});

test('another workspace cannot read or take back an invitation, and a taken-back or expired link fails like any other', async () => {
  await withDirs(async (dirs) => {
    const { server, ws, other } = await setup(dirs);
    try {
      const made = (await server.request('POST', `/workspaces/${ws}/invitations`, { role: 'viewer' })).json<{
        token: string;
        invitation: { invitationId: string };
      }>();
      const peek = await server.request('GET', `/workspaces/${other}/invitations`);
      assert.equal(peek.status, 200);
      assert.equal(peek.json<{ invitations: unknown[] }>().invitations.length, 0, 'the other workspace lists none');
      const cross = await server.request('DELETE', `/workspaces/${other}/invitations/${made.invitation.invitationId}`);
      assert.equal(cross.status, 404);
      // The secret under another workspace's id opens nothing.
      const guest = await server.issueAdditionalIdentity('prober');
      const swapped = await server.request('POST', '/invitations/accept', { token: `${other}.${made.token.split('.')[1]}` }, as(guest));
      assert.equal(swapped.status, 404);
      const taken = await server.request('DELETE', `/workspaces/${ws}/invitations/${made.invitation.invitationId}`);
      assert.equal(taken.status, 200);
      assert.equal((await server.request('POST', '/invitations/accept', { token: made.token }, as(guest))).status, 404);
    } finally {
      await server.stop();
    }
  });
});

test('the audit trail names the invitation and the role, never the link or its secret', async () => {
  await withDirs(async (dirs) => {
    const { server, ws } = await setup(dirs);
    try {
      const guest = await server.issueAdditionalIdentity('audit-guest');
      const made = (await server.request('POST', `/workspaces/${ws}/invitations`, { role: 'viewer' })).json<{ token: string }>();
      await server.request('POST', '/invitations/accept', { token: made.token }, as(guest));
      const audit = await server.request('GET', `/workspaces/${ws}/audit/events?limit=100`);
      assert.equal(audit.status, 200, audit.bodyText);
      assert.ok(audit.bodyText.includes('invitation.created') && audit.bodyText.includes('invitation.accepted'));
      assert.ok(!audit.bodyText.includes(made.token.split('.')[1]!), 'the secret is not in the audit log');
      assert.ok(!audit.bodyText.includes(made.token), 'the token is not in the audit log');
    } finally {
      await server.stop();
    }
  });
});

test('a notification carries ids and kinds only: a canary in the event is never in what a person is sent', async () => {
  const { openWorkspaceAuditLog } = await import('../src/audit/workspace-audit-log.js');
  await withDirs(async (dirs) => {
    const { server, ws } = await setup(dirs);
    try {
      const CANARY = 'CANARY-7f3a-recipient@example.test-document-text';
      const log = openWorkspaceAuditLog(
        { workspaceId: ws } as Parameters<typeof openWorkspaceAuditLog>[0],
        { dataRootDir: dirs.workspaceDataDir } as Parameters<typeof openWorkspaceAuditLog>[1],
      );
      await log.append({
        event: 'workflow.started',
        result: 'escalated',
        actor: { identityId: 'someone', role: 'admin' },
        target: { kind: 'workflow', id: 'wf_1' },
        detail: { note: CANARY, recipients: [CANARY] },
      } as Parameters<typeof log.append>[0]);
      const res = await server.request('GET', `/workspaces/${ws}/notifications`);
      assert.equal(res.status, 200, res.bodyText);
      const body = res.json<{ notifications: Record<string, unknown>[] }>();
      assert.ok(body.notifications.length >= 1, 'the escalation is a notification');
      assert.ok(!res.bodyText.includes('CANARY'), "nothing from the event's detail reaches a notification");
      assert.deepEqual(Object.keys(body.notifications[0]!).sort(), ['actorIdentityId', 'at', 'event', 'kind', 'read', 'seq', 'target']);
    } finally {
      await server.stop();
    }
  });
});
