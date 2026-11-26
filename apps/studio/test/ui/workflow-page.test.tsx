import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { workflowRouteOf, workflowPath } from '../../src/ui/sectionRoute';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { openScreen, workspaceReady } from './nav';

const ID = `wfl_${'a'.repeat(32)}`;
const detail = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  workflowId: ID,
  name: 'Send each client their document',
  lifecycle: 'ready',
  revision: 3,
  paused: false,
  archived: false,
  workspacePaused: false,
  updatedAt: '2026-11-20T10:00:00.000Z',
  origin: { via: 'conversation', conversation: { store: 'cnv', linked: false }, createdBy: { id: 'p', kind: 'human' }, createdAt: '' },
  currentVersion: {
    version: 2,
    definition: { definitionId: 'wfd_1', candidateWorkflowId: 'wf_1' },
    goalText: 'Send each client their document',
  },
  versions: [{}, {}],
  pendingApprovals: [],
  runs: [{ runId: 'run_1', version: 2, state: 'completed', pendingApprovals: 0, startedAt: '2026-11-19T09:00:00.000Z' }],
  runsTotal: 1,
  history: [
    { revision: 1, kind: 'created', at: '2026-11-18T09:00:00.000Z' },
    { revision: 3, kind: 'renamed', at: '2026-11-20T10:00:00.000Z' },
  ],
  ...over,
});
const summary = (d: Record<string, unknown>): Record<string, unknown> => ({
  workflowId: d['workflowId'],
  name: d['name'],
  lifecycle: d['lifecycle'],
  revision: d['revision'],
  currentVersion: 2,
  pendingApprovals: (d['pendingApprovals'] as unknown[]).length,
  paused: d['paused'],
  archived: d['archived'],
  updatedAt: d['updatedAt'],
});

async function open(api: FakeXo, path: string) {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await workspaceReady('Ops');
  if (path !== '') {
    const ws = window.location.pathname.split('/')[2]!;
    window.history.pushState(null, '', `/w/${ws}${path}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  return user;
}

describe('S1-5 a workflow has its own page', () => {
  it('reads the address of a workflow and its tab', () => {
    expect(workflowRouteOf(`/w/ws_1/work/${ID}`)).toEqual({ workflowId: ID, tab: 'overview' });
    expect(workflowRouteOf(`/w/ws_1/work/${ID}/setup`)).toEqual({ workflowId: ID, tab: 'setup' });
    expect(workflowRouteOf('/w/ws_1/work/library')).toBeUndefined();
    expect(workflowPath('ws_1', ID, 'runs')).toBe(`/w/ws_1/work/${ID}/runs`);
  });

  it('lists named workflows in Work and opens the page with its status and next step', async () => {
    const api = new FakeXo();
    const d = detail();
    api.studio.entities = [d];
    const user = await open(api, '');
    await openScreen(user, /^work$/i);
    await user.click(await screen.findByRole('link', { name: 'Send each client their document' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Send each client their document' })).toBeInTheDocument();
    expect(window.location.pathname).toMatch(new RegExp(`/work/${ID}$`));
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('It is ready. Start it when you want it to run.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start this workflow' })).toBeEnabled();
  });

  it('shows the tabs, each in plain words, and keeps the tab in the address', async () => {
    const api = new FakeXo();
    api.studio.entities = [detail({ pendingApprovals: [{ runId: 'run_2', approvalId: 'apr_1', step: 's', summary: 'Approve 3 emails' }] })];
    const user = await open(api, `/work/${ID}`);
    const tabs = await screen.findByRole('tablist', { name: 'Workflow' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Overview', 'Runs', 'Schedule and approvals', 'Setup', 'History']);
    expect(screen.getByRole('button', { name: 'Decide in the Inbox' })).toBeInTheDocument();
    await user.click(within(tabs).getByRole('tab', { name: 'Runs' }));
    expect(await screen.findByText('Done')).toBeInTheDocument();
    expect(window.location.pathname).toMatch(/\/runs$/);
    await user.click(within(tabs).getByRole('tab', { name: 'History' }));
    expect(await screen.findByText('renamed')).toBeInTheDocument();
  });

  it('renames a workflow; a stale name is refused, not overwritten', async () => {
    const api = new FakeXo();
    api.studio.entities = [detail()];
    const user = await open(api, `/work/${ID}`);
    await user.click(await screen.findByRole('button', { name: 'Rename' }));
    const field = screen.getByLabelText('Name');
    await user.clear(field);
    await user.type(field, 'Send client letters');
    await user.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(api.studio.entityRenames).toEqual(['Send client letters']));
    expect(await screen.findByRole('heading', { level: 1, name: 'Send client letters' })).toBeInTheDocument();
  });

  it('says why starting is unavailable while a person must decide', async () => {
    const api = new FakeXo();
    api.studio.entities = [
      detail({
        lifecycle: 'awaiting_approval',
        pendingApprovals: [{ runId: 'r', approvalId: 'a', step: 's', summary: 'Approve 3 emails' }],
      }),
    ];
    await open(api, `/work/${ID}`);
    expect(await screen.findByText('One decision waits for a person in the Inbox.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start this workflow' })).toBeNull();
  });
});

describe('S1-5 the send set-up', () => {
  const gmail = {
    credentialId: 'crd_1',
    provider: 'google',
    state: 'active',
    capabilities: ['message.send'],
    accountLabel: 'office@example.test',
  };

  async function setup(configure: (api: FakeXo) => void = () => undefined) {
    const api = new FakeXo();
    api.studio.entities = [detail()];
    api.compilations.push({ compilationId: 'cmp_1', sourceId: 'src_1', status: 'succeeded', createdAt: '2026-11-20T10:00:00.000Z' });
    api.studio.emailCredentials = [gmail];
    api.studio.bindingsOn = true;
    api.studio.itemFields = ['client_email', 'client_name'];
    configure(api);
    const user = await open(api, `/work/${ID}/setup`);
    await screen.findByRole('heading', { name: 'Sending email' });
    await user.selectOptions(screen.getByLabelText('Which step sends the message?'), 'Record before payment');
    return { api, user };
  }

  it('saves the sending account and where each part comes from, in the binding the platform expects', async () => {
    const { api, user } = await setup();
    await user.selectOptions(screen.getByLabelText('Who it goes to'), 'c:client_email');
    await user.selectOptions(screen.getByLabelText('Subject'), 'Text I write');
    await user.type(screen.getByLabelText('Subject: your text'), 'Your document');
    await user.selectOptions(screen.getByLabelText('Message'), 'Text I write');
    await user.type(screen.getByLabelText('Message: your text'), 'Please find it attached.');
    await user.click(screen.getByRole('checkbox', { name: /attach each person/i }));
    await user.click(screen.getByRole('button', { name: 'Save send set-up' }));
    await screen.findByText('Send set-up saved');
    expect(api.studio.bindingsPuts).toHaveLength(1);
    expect(api.studio.bindingsPuts[0]).toEqual([
      {
        capability: expect.any(String),
        connector: 'mail',
        kind: 'smtp',
        operation: 'send',
        sideEffect: 'irreversible',
        adapter: 'email',
        credentialId: 'crd_1',
        arguments: {
          to: { field: 'client_email' },
          subject: { const: 'Your document' },
          body: { const: 'Please find it attached.' },
          attachmentSha256: { field: 'document_sha256' },
          attachmentFilename: { field: 'document_name' },
          attachmentContentType: { field: 'document_type' },
        },
      },
    ]);
  });

  it('says what is missing and saves nothing', async () => {
    const { api, user } = await setup();
    await user.click(screen.getByRole('button', { name: 'Save send set-up' }));
    expect(await screen.findByText('Choose the column that holds each person’s email address.')).toBeInTheDocument();
    expect(api.studio.bindingsPuts).toHaveLength(0);
  });

  it('asks for a recent sign-in in plain words and keeps what was chosen', async () => {
    const { api, user } = await setup((a) => (a.studio.stepUpRequired = true));
    await user.selectOptions(screen.getByLabelText('Who it goes to'), 'c:client_email');
    await user.selectOptions(screen.getByLabelText('Subject'), 'c:client_name');
    await user.selectOptions(screen.getByLabelText('Message'), 'Text I write');
    await user.type(screen.getByLabelText('Message: your text'), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Save send set-up' }));
    expect(await screen.findByText('Sign in again to do this')).toBeInTheDocument();
    expect(screen.getByLabelText('Message: your text')).toHaveValue('Hello');
    expect(api.studio.bindingsPuts).toHaveLength(0);
  });

  it('keeps other steps’ bindings when one is saved, and shows what is already saved', async () => {
    const other = { capability: 'file report', connector: 'files', kind: 'file', operation: 'write', sideEffect: 'write', adapter: 'file' };
    const { api, user } = await setup((a) => {
      a.studio.bindings = [other];
      a.studio.bindingsRevision = 4;
    });
    await user.selectOptions(screen.getByLabelText('Who it goes to'), 'c:client_email');
    await user.selectOptions(screen.getByLabelText('Subject'), 'Text I write');
    await user.type(screen.getByLabelText('Subject: your text'), 'Hi');
    await user.selectOptions(screen.getByLabelText('Message'), 'Text I write');
    await user.type(screen.getByLabelText('Message: your text'), 'Body');
    await user.click(screen.getByRole('button', { name: 'Save send set-up' }));
    await screen.findByText('Send set-up saved');
    const saved = api.studio.bindingsPuts[0]!;
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject(other);
  });

  it('lets a person who cannot manage see why saving is unavailable', async () => {
    const api = new FakeXo();
    api.studio.entities = [detail()];
    api.compilations.push({ compilationId: 'cmp_1', sourceId: 'src_1', status: 'succeeded', createdAt: '2026-11-20T10:00:00.000Z' });
    api.studio.emailCredentials = [gmail];
    api.studio.bindingsOn = true;
    api.studio.role = 'viewer';
    await open(api, `/work/${ID}/setup`);
    await screen.findByRole('heading', { name: 'Sending email' });
    expect(screen.getByRole('button', { name: 'Save send set-up' })).toHaveAccessibleDescription(/does not include changing how XO sends/i);
  });
});
