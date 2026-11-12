import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { openScreen } from './nav';

type U = ReturnType<typeof userEvent.setup>;

async function analysed(api: FakeXo): Promise<U> {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Ops' });
  await user.click(screen.getByRole('button', { name: /^my xos/i }));
  await user.upload(
    document.getElementById('file-upload') as HTMLInputElement,
    new File(['%PDF'], 'procedure.pdf', { type: 'application/pdf' }),
  );
  await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
  await screen.findByText(/settlement amount must be recorded/i);
  return user;
}

async function openGraph(user: U) {
  await openScreen(user, 'Work');
  await user.click(await screen.findByRole('button', { name: /view graph of/i }));
  return screen.findByRole('region', { name: 'Workflow graph' });
}

const puts = (api: FakeXo) => api.calls.filter((c) => c.method === 'PUT' && /workflow-definitions\//.test(c.path));
const runCalls = (api: FakeXo) => api.calls.filter((c) => /workflow-definitions\/[^/]+\/run/.test(c.path));

describe('Workflow drafts', () => {
  it('validates live with the platform; Run draft waits for a save at the current revision and never calls run before that', async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    await openGraph(user);
    const draft = screen.getByRole('region', { name: 'Draft' });
    expect(await within(draft).findByText(/found no structural problems/i)).toBeInTheDocument();
    expect(await within(draft).findByText(/the platform says this draft can run/i)).toBeInTheDocument();
    const run = within(draft).getByRole('button', { name: 'Run draft' });
    expect(run).toBeDisabled();
    expect(within(draft).getByText(/Save the draft first/)).toBeInTheDocument();
    await user.click(run);
    expect(runCalls(api)).toHaveLength(0);
    expect(api.calls.some((c) => /workflow-definitions\/validate$/.test(c.path))).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved as revision 1/);
    await waitFor(() => expect(within(draft).getByRole('button', { name: 'Run draft' })).toBeEnabled());
    // An unsaved edit puts the gate back: a run uses the saved revision.
    await user.click(
      within(screen.getByRole('region', { name: 'Workflow graph' })).getByRole('button', { name: /^Record before payment/ }),
    );
    await user.type(screen.getByLabelText('Label'), '!');
    await waitFor(() => expect(within(draft).getByRole('button', { name: 'Run draft' })).toBeDisabled());
    expect(runCalls(api)).toHaveLength(0);
  });

  it("shows the platform's reasons and keeps Run draft disabled when the platform says the draft cannot run", async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    await openGraph(user);
    await user.click(
      within(screen.getByRole('region', { name: 'Workflow graph' })).getByRole('button', { name: /^Record before payment/ }),
    );
    await user.click(
      within(screen.getByRole('complementary', { name: 'Node palette' })).getByRole('button', { name: 'Branch on confidence' }),
    );
    const draft = screen.getByRole('region', { name: 'Draft' });
    const reasons = await within(draft).findByRole('list', { name: 'Reasons this draft cannot run' });
    expect(reasons).toHaveTextContent(/exactly two outgoing connections/);
    expect(within(draft).getByRole('button', { name: 'Run draft' })).toBeDisabled();
    expect(runCalls(api)).toHaveLength(0);
  });

  it("runs the saved draft with a form from the steps' contracts: the platform's refusal is shown verbatim, then the run starts and points at the existing runs UI", async () => {
    const api = new FakeXo();
    api.publishContractAll = true;
    const user = await analysed(api);
    await openGraph(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved as revision 1/);
    const draft = screen.getByRole('region', { name: 'Draft' });
    await waitFor(() => expect(within(draft).getByRole('button', { name: 'Run draft' })).toBeEnabled());
    expect(within(draft).getByText(/Not approved yet/)).toBeInTheDocument();

    await user.click(within(draft).getByRole('button', { name: 'Run draft' }));
    expect(await within(draft).findAllByRole('alert')).not.toHaveLength(0); // required details are checked before asking
    expect(runCalls(api)).toHaveLength(0);
    await user.type(within(draft).getByLabelText(/^claim_amount/), '120');
    await user.type(within(draft).getByLabelText(/^loss/), 'fire');
    await user.click(within(draft).getByRole('button', { name: 'Run draft' }));
    expect(await within(draft).findByText(/is not approved for execution/)).toBeInTheDocument(); // the platform's own words
    expect(runCalls(api)).toHaveLength(1);
    expect(within(draft).queryByText(/Run started/)).not.toBeInTheDocument();

    api.approvals.all = true;
    await user.click(within(draft).getByRole('button', { name: 'Run draft' }));
    expect(await within(draft).findByText(/Run started/)).toBeInTheDocument();
    const sent = runCalls(api).at(-1)!;
    expect(sent.body).toMatchObject({ input: { claim_amount: 120, loss: 'fire' }, expectedRevision: 1 });
    expect(sent.headers?.['idempotency-key'] ?? sent.headers?.['Idempotency-Key']).toBeTruthy();
    expect(within(draft).getByRole('button', { name: /Open the task in Inbox|See the run in Activity/ })).toBeInTheDocument();
    expect(api.workflowRuns.some((r) => (r as { workflowId: string }).workflowId.startsWith('draft:'))).toBe(true);
  });

  it('falls back to a JSON box when a step publishes no input contract, and checks it is an object before asking', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    const user = await analysed(api);
    await openGraph(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved as revision 1/);
    const draft = screen.getByRole('region', { name: 'Draft' });
    await waitFor(() => expect(within(draft).getByRole('button', { name: 'Run draft' })).toBeEnabled());
    const box = within(draft).getByLabelText('Input (JSON object)');
    await user.clear(box);
    await user.type(box, 'not json');
    await user.click(within(draft).getByRole('button', { name: 'Run draft' }));
    expect(await within(draft).findByRole('alert')).toHaveTextContent(/JSON object/);
    expect(runCalls(api)).toHaveLength(0);
  });

  it("says so, in the platform's words, when the platform cannot check the draft, and leaves no old verdict on screen", async () => {
    const api = new FakeXo();
    api.studio.validateRefusal = 'body.name must be a non-empty string of at most 120 characters';
    const user = await analysed(api);
    await openGraph(user);
    const draft = screen.getByRole('region', { name: 'Draft' });
    expect(await within(draft).findByLabelText('What the platform said about checking')).toHaveTextContent(/at most 120 characters/);
    expect(within(draft).queryByText(/the platform says this draft can run/i)).not.toBeInTheDocument();
    expect(within(draft).getByRole('button', { name: 'Run draft' })).toBeDisabled();
  });

  it("shows the platform's stale-revision refusal instead of running", async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    const user = await analysed(api);
    await openGraph(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved as revision 1/);
    api.studio.drafts[0]!.revision = 2; // someone else saved
    const draft = screen.getByRole('region', { name: 'Draft' });
    await waitFor(() => expect(within(draft).getByRole('button', { name: 'Run draft' })).toBeEnabled());
    await user.click(within(draft).getByRole('button', { name: 'Run draft' }));
    expect(await within(draft).findByLabelText('What the platform said')).toHaveTextContent(/stale draft revision; nothing was run/);
    expect(api.workflowRuns.some((r) => (r as { workflowId: string }).workflowId.startsWith('draft:'))).toBe(false);
  });

  it('saves a new draft, then saves again with the revision it loaded', async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    await openGraph(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Saved as revision 1/)).toBeInTheDocument();
    expect(api.studio.drafts).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Saved as revision 2/)).toBeInTheDocument();
    expect((puts(api)[0]!.body as { expectedRevision: number }).expectedRevision).toBe(1);
  });

  it('on a stale revision reloads the newer draft and says nothing was overwritten', async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    await openGraph(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved as revision 1/);
    api.studio.drafts[0]!.revision = 5;
    api.studio.drafts[0]!.name = 'Changed by a colleague';
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/nothing was overwritten/)).toBeInTheDocument();
    expect(screen.getByLabelText('Draft name')).toHaveValue('Changed by a colleague');
    expect(screen.getByText(/revision 5/, { selector: 'p' })).toBeInTheDocument();
    expect(api.studio.drafts[0]!.name).toBe('Changed by a colleague');
  });

  it('opens and deletes a saved draft after confirming', async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    await openGraph(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved as revision 1/);
    const list = await screen.findByRole('list', { name: 'Saved drafts' });
    await user.click(within(list).getByRole('button', { name: /^Delete / }));
    expect(api.studio.drafts).toHaveLength(1);
    await user.click(within(list).getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(api.studio.drafts).toHaveLength(0));
  });

  it('shows the platform refusal when a stale role hint lets a viewer try to save', async () => {
    const api = new FakeXo();
    api.studio.role = 'viewer';
    api.studio.reportedRole = 'admin';
    const user = await analysed(api);
    await openGraph(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await within(screen.getByRole('region', { name: 'Draft' })).findByRole('alert')).toBeInTheDocument();
    expect(api.studio.drafts).toHaveLength(0);
  });

  it('disables Save as a hint for a viewer whose role is known', async () => {
    const api = new FakeXo();
    api.studio.role = 'viewer';
    const user = await analysed(api);
    await openGraph(user);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByText(/access does not include saving workflows/)).toBeInTheDocument();
  });
});
