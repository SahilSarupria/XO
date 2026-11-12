import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { chooseFromMenu } from './nav';

async function open(api: FakeXo) {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Ops', level: 1 });
  return user;
}
async function openSettingsTab(user: ReturnType<typeof userEvent.setup>, tab: string) {
  await chooseFromMenu(user, 'Settings');
  await user.click(within(screen.getByRole('tablist', { name: 'Settings sections' })).getByRole('tab', { name: tab }));
}
const bodyOf = (api: FakeXo, method: string, path: RegExp) =>
  api.calls.filter((c) => c.method === method && path.test(c.path)).at(-1)?.body as Record<string, unknown> | undefined;
beforeEach(() => window.localStorage.clear());

describe('members and roles', () => {
  it('lists the roster, adds a person by identity ID, changes a role and removes — and never offers an email invitation', async () => {
    const api = new FakeXo();
    const user = await open(api);
    await openSettingsTab(user, 'Members');
    const table = await screen.findByRole('table', { name: 'Members' });
    expect(within(table).getByText('Owner')).toBeInTheDocument();
    expect(within(table).getByText('Meera')).toBeInTheDocument();
    expect(screen.queryByText(/send (an )?invit|invitation email/i)).not.toBeInTheDocument();
    expect(screen.getByText(/There is no email invitation: nothing is sent/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Identity ID'), 'rahul-identity');
    await user.type(screen.getByLabelText('Name (optional)'), 'Rahul');
    await user.selectOptions(screen.getByLabelText('Role'), 'publisher');
    await user.click(screen.getByRole('button', { name: 'Add person' }));
    await within(await screen.findByRole('table', { name: 'Members' })).findByText('Rahul');
    expect(bodyOf(api, 'POST', /\/members$/)).toEqual({ identityId: 'rahul-identity', role: 'publisher', displayName: 'Rahul' });

    await user.selectOptions(screen.getByLabelText('Role for Rahul'), 'viewer');
    await waitFor(() => expect(bodyOf(api, 'PATCH', /\/members\/rahul-identity$/)).toEqual({ role: 'viewer' }));
    await user.click(screen.getByRole('button', { name: 'Remove Rahul' }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Members' })).queryByText('Rahul')).not.toBeInTheDocument());
  });

  it('a Viewer sees the roster but every control is disabled with the reason, and the platform is not asked', async () => {
    const api = new FakeXo();
    api.studio.role = 'viewer';
    const user = await open(api);
    await openSettingsTab(user, 'Members');
    await screen.findByRole('table', { name: 'Members' });
    expect(screen.getByRole('button', { name: 'Add person' })).toBeDisabled();
    expect(screen.getByLabelText('Role for Meera')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove Meera' })).toBeDisabled();
    expect(screen.getAllByText(/Viewer access does not include managing members/).length).toBeGreaterThan(0);
    expect(api.calls.some((c) => ['POST', 'PATCH', 'DELETE'].includes(c.method) && /\/members/.test(c.path))).toBe(false);
  });

  it('hiding a button is not authorization: if the UI offers it but the platform refuses, the refusal is shown', async () => {
    const api = new FakeXo();
    api.studio.role = 'viewer';
    api.studio.reportedRole = 'admin'; // Studio is told Admin (stale); the platform enforces Viewer
    const user = await open(api);
    await openSettingsTab(user, 'Members');
    await screen.findByRole('table', { name: 'Members' });
    await user.type(screen.getByLabelText('Identity ID'), 'sneaky');
    await user.click(screen.getByRole('button', { name: 'Add person' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Your role does not allow this/);
    expect(api.studio.members.some((m) => m.identityId === 'sneaky')).toBe(false);
  });

  it('a personal workspace cannot have members and says so', async () => {
    const api = new FakeXo();
    api.studio.kind = 'personal';
    const user = await open(api);
    await openSettingsTab(user, 'Members');
    await screen.findByRole('table', { name: 'Members' });
    expect(screen.getByRole('button', { name: 'Add person' })).toBeDisabled();
    expect(screen.getByText(/personal workspace is for one person/)).toBeInTheDocument();
  });
});

describe('settings', () => {
  it('saves model and runtime choices guarded by the loaded revision; a provider with no server credentials is labelled and no key is ever requested', async () => {
    const api = new FakeXo();
    const user = await open(api);
    await openSettingsTab(user, 'Models and runtime');
    expect(await screen.findByText('Online')).toBeInTheDocument();
    expect(screen.getByText(/does not say a model is reachable/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Cloud/ })).toBeDisabled();
    expect(screen.queryByLabelText(/api key|secret|password/i)).not.toBeInTheDocument();
    const providerOptions = within(screen.getByLabelText('Primary provider'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(providerOptions.join('|')).toMatch(/openai — no credentials on the server/);

    await user.selectOptions(screen.getByLabelText('Primary provider'), 'anthropic');
    await user.type(screen.getByLabelText('Primary model'), 'claude-test');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(bodyOf(api, 'PUT', /\/settings$/)).toMatchObject({
      expectedRevision: 0,
      model: { primary: { provider: 'anthropic', model: 'claude-test' }, fallback: null },
      airGapped: false,
    });
    expect(api.studio.settings.revision).toBe(1);
  });

  it('a conflicting save is refused by the platform: nothing is overwritten and the latest values are shown', async () => {
    const api = new FakeXo();
    const user = await open(api);
    await openSettingsTab(user, 'Notifications');
    const box = await screen.findByLabelText('When a process finishes');
    api.studio.staleNextSettingsWrite = true;
    await user.click(box);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/changed by someone else, so nothing was saved/)).toBeInTheDocument();
    expect(api.studio.settings.notifications.onWorkflowComplete).toBe(false);
  });

  it('the platform’s own refusals are shown, not softened: air-gapped with an off-box model', async () => {
    const api = new FakeXo();
    api.studio.settings.model.primary = { provider: 'anthropic', model: 'm' };
    const user = await open(api);
    await openSettingsTab(user, 'Models and runtime');
    await user.click(await screen.findByLabelText('Air-gapped mode'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/air-gapped mode forbids the off-box provider "anthropic"/);
  });

  it('residency is presented as a declaration, using the platform’s own wording, and saves a region', async () => {
    const api = new FakeXo();
    const user = await open(api);
    await openSettingsTab(user, 'Data and residency');
    expect(await screen.findByText(/the server does not prove or control where bytes are physically stored/)).toBeInTheDocument();
    await user.selectOptions(await screen.findByLabelText('Required region'), 'in-mumbai');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Saved.');
    expect(bodyOf(api, 'PUT', /\/settings$/)).toMatchObject({ region: 'in-mumbai' });
  });

  it('trust: signature requirement is a presence check, and Studio never presents anything as verified', async () => {
    const api = new FakeXo();
    const user = await open(api);
    await openSettingsTab(user, 'Trust and signing');
    expect(await screen.findByText(/This is a presence check only/)).toBeInTheDocument();
    expect(screen.getByText('Verifying who signed a package')).toBeInTheDocument();
    expect(screen.getAllByText('Not available').length).toBeGreaterThanOrEqual(2);
    // Nothing may SAY a package or signature is verified. Every sentence on the page that mentions verification must be a negation.
    expect(screen.queryByText(/^verified$/i)).not.toBeInTheDocument();
    const sentences = (document.body.textContent ?? '').split(/(?<=[.!?])\s+/).filter((t) => /verif|valid|authentic/i.test(t));
    expect(sentences.length).toBeGreaterThan(0);
    for (const t of sentences) expect(t, `"${t}" must be a negation`).toMatch(/\b(not|no|never|nor|cannot|can't|does not|do not)\b/i);
    await user.click(screen.getByLabelText('Require packages to carry a signature'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Saved.');
    expect(bodyOf(api, 'PUT', /\/settings$/)).toMatchObject({ trust: { requireSignedPackages: true } });
  });

  it('a Viewer can read settings but not change them', async () => {
    const api = new FakeXo();
    api.studio.role = 'viewer';
    const user = await open(api);
    await openSettingsTab(user, 'Notifications');
    expect(await screen.findByLabelText('When a run fails')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(screen.getByText(/Viewer access does not include changing settings/)).toBeInTheDocument();
  });
});

describe('audit log', () => {
  async function openAudit(api: FakeXo) {
    const user = await open(api);
    await user.click(screen.getByRole('button', { name: 'Audit log' }));
    return user;
  }

  it('shows events newest first with readable names and results, and filters through the platform', async () => {
    const api = new FakeXo();
    const user = await openAudit(api);
    const table = await screen.findByRole('table', { name: 'Audit events' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Was refused');
    expect(rows[0]).toHaveTextContent('Denied');
    expect(within(table).getByText('Uploaded a document')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Access denied' }));
    await waitFor(() => expect(api.calls.some((c) => c.path.endsWith('/audit/events') && c.method === 'GET')).toBe(true));
    await waitFor(() =>
      expect(within(screen.getByRole('table', { name: 'Audit events' })).queryByText('Uploaded a document')).not.toBeInTheDocument(),
    );
  });

  it('pages older events instead of loading everything', async () => {
    const api = new FakeXo();
    for (let i = 4; i <= 60; i++)
      api.studio.audit.push({
        seq: i,
        at: `2026-10-22T10:${String(i % 60).padStart(2, '0')}:00.000Z`,
        event: 'source.uploaded',
        result: 'succeeded',
        actor: { identityId: 'owner', kind: 'user' },
      });
    const user = await openAudit(api);
    await screen.findByRole('table', { name: 'Audit events' });
    expect(within(screen.getByRole('table', { name: 'Audit events' })).getAllByRole('row').length - 1).toBe(50);
    await user.click(screen.getByRole('button', { name: 'Load older events' }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Audit events' })).getAllByRole('row').length - 1).toBe(60));
    expect(screen.queryByRole('button', { name: 'Load older events' })).not.toBeInTheDocument();
  });

  it('integrity: a broken chain is stated plainly; a declared retention is shown and an undeclared one is not invented', async () => {
    const api = new FakeXo();
    api.studio.chainOk = false;
    api.studio.retentionDays = 2555;
    await openAudit(api);
    const side = screen.getByRole('complementary', { name: 'Roles and integrity' });
    expect(await within(side).findByText('Chain broken')).toBeInTheDocument();
    expect(within(side).getByText(/breaks at entry 2 \(bad hash\)/)).toBeInTheDocument();
    expect(within(side).getByText(/operator declares at least 2555 days/)).toBeInTheDocument();
  });

  it('a Reviewer can read the log but not export; a Viewer is told why and the platform is never asked', async () => {
    const reviewer = new FakeXo();
    reviewer.studio.role = 'reviewer';
    await openAudit(reviewer);
    await screen.findByRole('table', { name: 'Audit events' });
    expect(screen.getByRole('button', { name: 'Export evidence (JSON)' })).toBeDisabled();
  });
  it('a Viewer gets an explanation, and no audit request is made', async () => {
    const viewer = new FakeXo();
    viewer.studio.role = 'viewer';
    await openAudit(viewer);
    expect(await screen.findByText('The audit log is not available to your role')).toBeInTheDocument();
    expect(viewer.calls.some((c) => c.path.includes('/audit/events'))).toBe(false);
  });
  it('if Studio’s role hint is stale, the platform’s refusal is shown as a permission notice', async () => {
    const api = new FakeXo();
    api.studio.role = 'viewer';
    api.studio.reportedRole = 'admin';
    await openAudit(api);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((a) => /Your role does not allow this/.test(a.textContent ?? ''))).toBe(true);
    expect(screen.queryByRole('table', { name: 'Audit events' })).not.toBeInTheDocument();
  });

  describe('export', () => {
    const created: string[] = [];
    let blobText: string | undefined;
    beforeEach(() => {
      blobText = undefined;
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
      vi.stubGlobal('URL', {
        ...URL,
        createObjectURL: (b: Blob) => {
          const reader = new FileReader();
          reader.onload = () => (blobText = String(reader.result));
          reader.readAsText(b);
          created.push('x');
          return 'blob:test';
        },
        revokeObjectURL: () => undefined,
      });
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('downloads the platform’s bytes exactly, and records that it was exported; the button says evidence, not certification', async () => {
      const api = new FakeXo();
      const user = await openAudit(api);
      await screen.findByRole('table', { name: 'Audit events' });
      expect(screen.getByRole('button', { name: 'Export evidence (JSON)' })).toHaveAttribute(
        'title',
        expect.stringMatching(/Not a compliance certificate/),
      );
      await user.click(screen.getByRole('button', { name: 'Export evidence (JSON)' }));
      await waitFor(() => expect(blobText).toBeDefined());
      expect(JSON.parse(blobText!).format).toBe('xo-audit-evidence/1');
      expect(api.studio.audit.some((e) => e.event === 'audit.exported')).toBe(true);
    });
  });
});
