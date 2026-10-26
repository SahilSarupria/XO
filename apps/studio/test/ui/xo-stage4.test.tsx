import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { openScreen } from './nav';

type U = ReturnType<typeof userEvent.setup>;

async function signedIn(api: FakeXo, applyAccept = true): Promise<U> {
  const user = userEvent.setup({ applyAccept });
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Ops' });
  return user;
}

const pkg = {
  id: 'pkg-1',
  publishedAt: '2026-09-01T00:00:00Z',
  manifest: {
    name: 'burglary-policy',
    version: '1.2.0',
    creatorDid: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
    capabilities: [{ id: 'cap-a', name: 'Check exclusions', description: 'Flags excluded losses.' }],
    signatures: [{}, {}],
    components: { rules: { path: 'rules.json' } },
  },
};
const runs = [
  { id: 'b1', packageId: 'pkg-1', category: 'reasoning_quality', score: 0.5, runAt: '2026-09-02T00:00:00Z', challengeable: false },
  { id: 'b2', packageId: 'pkg-1', category: 'reasoning_quality', score: 0.8, runAt: '2026-09-03T00:00:00Z', challengeable: true },
];

describe('Library registry search', () => {
  it('searches the real registry, shows only recorded facts, and opens the package in the inspector', async () => {
    const api = new FakeXo();
    api.registryPackages.push(pkg);
    api.benchmarkRuns.push(...runs);
    const user = await signedIn(api);
    await user.click(screen.getByRole('button', { name: 'Library' }));
    const search = screen.getByRole('button', { name: 'Search registry' });
    expect(search).toBeDisabled();
    await user.type(screen.getByLabelText('Search the library'), 'burglary');
    await user.click(search);
    const grid = screen.getByRole('list', { name: 'XOs' });
    const card = (await within(grid).findByText('1 capability declared')).closest('li')!;
    expect(within(card).getByText('burglary-policy')).toBeInTheDocument();
    expect(within(card).getByText('In your registry')).toBeInTheDocument();
    expect(within(card).queryByText(/verified|★|₹|\$/i)).not.toBeInTheDocument();
    // Samples stay labelled as samples, with Install unavailable.
    expect(within(grid).getAllByText('Sample').length).toBeGreaterThan(0);
    expect(within(grid).getAllByRole('button', { name: 'Install' })[0]).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('button', { name: 'My company' }));
    expect(within(grid).queryByText('Sample')).not.toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: 'Open burglary-policy' }));
    const xo = await screen.findByRole('region', { name: 'XO' });
    expect(within(xo).getByRole('heading', { name: 'burglary-policy' })).toBeInTheDocument();
    expect(within(xo).getByText('Signatures on the manifest')).toBeInTheDocument();
    expect(within(xo).getByText('Not checked here')).toBeInTheDocument();
    expect(within(xo).getByText('Reasoning quality')).toBeInTheDocument();
    expect(within(xo).getByText('0.8')).toBeInTheDocument(); // latest run, not an average
    expect(within(xo).getByText(/2 runs recorded · 1 marked challengeable/)).toBeInTheDocument();
    expect(within(xo).getByRole('button', { name: 'Fork' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(within(xo).getByRole('tab', { name: 'Rules' }));
    expect(within(xo).getByText('Check exclusions')).toBeInTheDocument();
  });

  it('says so when the registry has nothing, and shows a failure instead of an empty list', async () => {
    const api = new FakeXo();
    const user = await signedIn(api);
    await user.click(screen.getByRole('button', { name: 'Library' }));
    await user.type(screen.getByLabelText('Search the library'), 'nothing');
    await user.click(screen.getByRole('button', { name: 'Search registry' }));
    expect(await screen.findByText(/registry has nothing for “nothing”/)).toBeInTheDocument();
    api.failing.add('/registry/search?q=boom');
    await user.clear(screen.getByLabelText('Search the library'));
    await user.type(screen.getByLabelText('Search the library'), 'boom');
    await user.click(screen.getByRole('button', { name: 'Search registry' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('Create XO wizard and the inspector for an analysed document', () => {
  it('walks upload, analyse, review, publish, and Publish is not available', async () => {
    const api = new FakeXo();
    const user = await signedIn(api);
    await openScreen(user, 'Setup');
    await user.click(screen.getByRole('button', { name: 'XOs' }));
    expect(screen.getByText('No XOs yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '+ Create XO' }));
    expect(window.location.hash).toBe('#/create');
    const steps = screen.getByRole('list', { name: 'Steps' });
    const items = within(steps).getAllByRole('listitem');
    ['1 Add sources', '2 Build', '3 Test', '4 Publish'].forEach((t, i) => expect(items[i]!.textContent).toContain(t));
    expect(items[0]).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('button', { name: 'Continue to Build' })).toBeDisabled();
    await user.upload(
      screen.getByLabelText('Choose a document to upload'),
      new File(['%PDF'], 'procedure.pdf', { type: 'application/pdf' }),
    );
    await user.click(await screen.findByRole('radio', { name: /procedure\.pdf/ }));
    expect(screen.getByText(/pasting a link is not available yet/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue to Build' }));
    expect(screen.getByRole('button', { name: 'Continue to Test' })).toBeDisabled(); // not analysed yet
    await user.click(screen.getByRole('button', { name: 'Analyse' }));
    expect(await screen.findByText(/\d+ rules? found/)).toBeInTheDocument();
    expect(await screen.findByText('Notify the Insurer')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue to Test' }));
    expect(screen.getByText(/You approve every rule/)).toBeInTheDocument();
    expect(screen.getByText(/Running test cases against this XO is not available yet/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue to Publish' }));
    expect(screen.getByText(/Not available yet. Publishing needs a signed \.xo package/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open XO' }));

    const xo = await screen.findByRole('region', { name: 'XO' });
    expect(within(xo).getByRole('heading', { name: 'procedure' })).toBeInTheDocument();
    expect(within(xo).getByText(/Not available yet\. No benchmark has been run/)).toBeInTheDocument();
    await waitFor(() => expect(within(xo).getByText('Rules found')).toBeInTheDocument());
    await user.click(within(xo).getByRole('tab', { name: 'Benchmarks' }));
    expect(within(xo).getByText('No benchmark runs')).toBeInTheDocument();
    await user.click(within(xo).getByRole('tab', { name: 'Rules' }));
    expect(await within(xo).findByText('Notify the Insurer')).toBeInTheDocument();
    await user.click(within(xo).getByRole('button', { name: '← My XOs' }));
    expect(await screen.findByRole('button', { name: 'Open procedure' })).toBeInTheDocument();
  });

  it('refuses an unsupported file and does not move on (Word .docx is supported; legacy .doc is not)', async () => {
    const user = await signedIn(new FakeXo(), false);
    await openScreen(user, 'Setup');
    await user.click(screen.getByRole('button', { name: 'XOs' }));
    expect(screen.getByText('No XOs yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '+ Create XO' }));
    await user.upload(screen.getByLabelText('Choose a document to upload'), new File(['x'], 'rules.doc'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Older \.doc files are not supported: save it as \.docx or PDF first/);
    expect(screen.getByRole('button', { name: 'Continue to Build' })).toBeDisabled();
  });
});
