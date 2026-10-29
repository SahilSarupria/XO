import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { setDetailLevel } from './nav';

type U = ReturnType<typeof userEvent.setup>;
const nav = () => screen.getByRole('navigation', { name: /workspace sections/i });

async function open(api: FakeXo): Promise<{ user: U; panel: HTMLElement }> {
  api.publishContract = true;
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Ops', level: 1 });
  await user.click(within(nav()).getByRole('button', { name: /^my xos/i }));
  await user.upload(document.getElementById('file-upload') as HTMLInputElement, new File(['%PDF'], 'p.pdf', { type: 'application/pdf' }));
  await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
  await screen.findByText(/settlement amount must be recorded/i);
  await setDetailLevel(user, 'builder');
  await user.click(within(nav()).getByRole('button', { name: /^contracts/i }));
  const list = await screen.findByRole('list', { name: 'Capability contracts' });
  const card = within(list).getByRole('heading', { name: 'Record before payment' }).closest('li') as HTMLElement;
  await user.click(within(card).getByText('Test cases', { selector: 'summary' }));
  const panel = await within(card).findByRole('region', { name: 'Test cases for Record before payment' });
  await waitFor(() => expect(within(panel).queryByText('Loading test cases…')).not.toBeInTheDocument());
  return { user, panel };
}

async function addCase(user: U, panel: HTMLElement, name: string, status = 'succeeded', amount = '120', loss = 'fire', output = '') {
  await user.click(within(panel).getByRole('button', { name: 'Add a test case' }));
  const form = within(panel).getByRole('group', { name: 'New test case' });
  await user.type(within(form).getByLabelText('Name'), name);
  await user.type(within(form).getByLabelText(/^claim_amount/), amount);
  await user.type(within(form).getByLabelText(/^loss/), loss);
  await user.selectOptions(within(form).getByLabelText('Expected result'), status);
  if (output !== '') await user.type(within(form).getByLabelText(/^Expected output contains/), output.replace(/[{[]/g, '$&$&'));
  await user.click(within(form).getByRole('button', { name: 'Save test case' }));
  await within(panel).findByText(name);
}
const caseRow = (panel: HTMLElement, name: string) => within(panel).getByText(name).closest('li') as HTMLElement;
const calls = (api: FakeXo, re: RegExp) => api.calls.filter((c) => re.test(c.path));

describe('Test cases per rule', () => {
  it('loads lazily, saves a case from the contract form, and lists it as not run', async () => {
    const api = new FakeXo();
    const { user, panel } = await open(api);
    expect(within(panel).getByText('No test cases yet.')).toBeInTheDocument();
    await addCase(user, panel, 'Small fire');
    expect(within(caseRow(panel, 'Small fire')).getByText('Not run')).toBeInTheDocument();
    const saved = calls(api, /test-cases$/).find((c) => c.method === 'POST')!.body as { input: unknown; expected: unknown };
    expect(saved).toMatchObject({ name: 'Small fire', input: { claim_amount: 120, loss: 'fire' }, expected: { status: 'succeeded' } });
  });

  it('pass or fail comes from the platform: its verdict and its reasons are shown, nothing is compared in the browser', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    const { user, panel } = await open(api);
    await addCase(user, panel, 'Expects a failure', 'failed');
    await addCase(user, panel, 'Expects success');
    await user.click(within(panel).getByRole('button', { name: 'Run Expects a failure' }));
    const failed = caseRow(panel, 'Expects a failure');
    expect(await within(failed).findByText('Failed')).toBeInTheDocument();
    expect(within(failed).getByRole('list', { name: 'Why Expects a failure failed' })).toHaveTextContent(
      'status: expected "failed", got "succeeded"',
    );
    await user.click(within(panel).getByRole('button', { name: 'Run Expects success' }));
    expect(await within(caseRow(panel, 'Expects success')).findByText('Passed')).toBeInTheDocument();
    // The platform changes its mind about the outcome; the UI follows it, not what the case "should" give.
    api.studio.caseOutcome = () => ({ status: 'failed', errorCode: 'XO_INVALID_ARGUMENT', errorMessage: 'bad input' });
    await user.click(within(panel).getByRole('button', { name: 'Run Expects success' }));
    expect(await within(caseRow(panel, 'Expects success')).findByText('Failed')).toBeInTheDocument();
    expect(calls(api, /test-cases\/[^/]+\/runs$/).filter((c) => c.method === 'POST')).toHaveLength(3);
  });

  it("shows the platform's refusal verbatim when the rule is not approved, and records no result", async () => {
    const api = new FakeXo();
    const { user, panel } = await open(api);
    await addCase(user, panel, 'Needs approval');
    await user.click(within(panel).getByRole('button', { name: 'Run Needs approval' }));
    expect(await within(panel).findByLabelText('What the platform said')).toHaveTextContent(/is not approved for execution/);
    expect(within(caseRow(panel, 'Needs approval')).getByText('Not run')).toBeInTheDocument();
  });

  it("runs all cases, reports the platform's counts, and keeps a history per case", async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    const { user, panel } = await open(api);
    await addCase(user, panel, 'A');
    await addCase(user, panel, 'B', 'failed');
    await user.click(within(panel).getByRole('button', { name: 'Run all test cases' }));
    expect(await within(panel).findByText('1 passed, 1 failed.')).toBeInTheDocument();
    expect(within(caseRow(panel, 'A')).getByText('Passed')).toBeInTheDocument();
    expect(within(caseRow(panel, 'B')).getByText('Failed')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Run A' }));
    await user.click(within(panel).getByRole('button', { name: 'History of A' }));
    const history = await within(panel).findByRole('list', { name: 'Run history of A' });
    expect(within(history).getAllByRole('listitem')).toHaveLength(2);
    expect(history).toHaveTextContent('Passed');
    await user.click(within(panel).getByRole('button', { name: 'History of A' }));
    expect(within(panel).queryByRole('list', { name: 'Run history of A' })).not.toBeInTheDocument();
  });

  it('edits with the revision it loaded; a stale edit is refused by the platform and the saved case is reloaded', async () => {
    const api = new FakeXo();
    const { user, panel } = await open(api);
    await addCase(user, panel, 'Original');
    await user.click(within(panel).getByRole('button', { name: 'Edit Original' }));
    const form = within(panel).getByRole('group', { name: 'Edit Original' });
    const name = within(form).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Renamed');
    // someone else saves first
    api.studio.testCases.forEach((list) => list.forEach((c) => (c.revision = 5)));
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await within(panel).findByLabelText('What the platform said')).toHaveTextContent(/changed by someone else/);
    // The user's edit is kept in the open form, not lost, so they can decide what to do with the newer saved case.
    expect(within(panel).getByRole('group', { name: 'Edit Original' })).toBeInTheDocument();
    expect(within(panel).getByLabelText('Name')).toHaveValue('Renamed');
    const put = calls(api, /test-cases\/[^/]+$/).find((c) => c.method === 'PUT')!;
    expect(put.body).toMatchObject({ name: 'Renamed', expectedRevision: 1 });
  });

  it('edits the input as JSON when the form would not allow it, and deletes only after confirming', async () => {
    const api = new FakeXo();
    const { user, panel } = await open(api);
    await user.click(within(panel).getByRole('button', { name: 'Add a test case' }));
    const form = within(panel).getByRole('group', { name: 'New test case' });
    await user.type(within(form).getByLabelText('Name'), 'Bad amount');
    await user.click(within(form).getByLabelText(/Edit the input as JSON/));
    const box = within(form).getByLabelText('Input (JSON object)');
    await user.clear(box);
    await user.type(box, '{{"claim_amount": "lots"}');
    await user.selectOptions(within(form).getByLabelText('Expected result'), 'failed');
    await user.click(within(form).getByRole('button', { name: 'Save test case' }));
    await within(panel).findByText('Bad amount');
    expect(calls(api, /test-cases$/).find((c) => c.method === 'POST')!.body).toMatchObject({ input: { claim_amount: 'lots' } });
    await user.click(within(panel).getByRole('button', { name: 'Delete Bad amount' }));
    expect(calls(api, /test-cases\/[^/]+$/).filter((c) => c.method === 'DELETE')).toHaveLength(0);
    await user.click(within(panel).getByRole('button', { name: 'Confirm delete Bad amount' }));
    await waitFor(() => expect(within(panel).queryByText('Bad amount')).not.toBeInTheDocument());
    expect(within(panel).getByText('No test cases yet.')).toBeInTheDocument();
  });

  it('role hints: a reviewer can run but not edit', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    api.studio.role = 'reviewer';
    api.studio.reportedRole = 'reviewer';
    api.studio.seedCases = [{ name: 'Shared case' }];
    const { user, panel } = await open(api);
    expect(within(panel).getByRole('button', { name: 'Add a test case' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Run Shared case' })).toBeEnabled();
    expect(within(panel).getByRole('button', { name: 'Edit Shared case' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Delete Shared case' })).toBeDisabled();
    await user.click(within(panel).getByRole('button', { name: 'Run Shared case' }));
    expect(await within(caseRow(panel, 'Shared case')).findByText('Passed')).toBeInTheDocument();
  });

  it('role hints: a viewer can read cases but the Run and edit controls are disabled', async () => {
    const api = new FakeXo();
    api.studio.role = 'viewer';
    api.studio.reportedRole = 'viewer';
    api.studio.seedCases = [{ name: 'Shared case' }];
    const { panel } = await open(api);
    expect(within(caseRow(panel, 'Shared case')).getByText('Not run')).toBeInTheDocument();
    for (const name of ['Run Shared case', 'Edit Shared case', 'Delete Shared case', 'Add a test case', 'Run all test cases'])
      expect(within(panel).getByRole('button', { name })).toBeDisabled();
    expect(within(panel).getByText(/access does not include running test cases/)).toBeInTheDocument();
  });
});
