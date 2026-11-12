import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import type { FakeLibraryItem } from '../fakeStudio';

async function open(api: FakeXo) {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Ops', level: 1 });
  await user.click(screen.getByRole('button', { name: 'Library' }));
  return user;
}
const item = (over: Partial<FakeLibraryItem> & { id: string; name: string }): FakeLibraryItem => ({
  version: '1.0.0',
  creatorDid: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
  publishedAt: '2026-10-01T00:00:00.000Z',
  summary: null,
  capabilities: [{ id: 'c1', name: 'Check' }],
  madeByMe: false,
  signed: false,
  overallScore: null,
  byCategory: {},
  installable: true,
  ...over,
});
const card = (name: string): HTMLElement =>
  within(screen.getByRole('list', { name: 'XOs' }))
    .getByText(name)
    .closest('li') as HTMLElement;
beforeEach(() => window.localStorage.clear());

describe('Library', () => {
  it('shows recorded facts only: signature entries are "not checked", scores are the publisher’s, nothing is called verified', async () => {
    const api = new FakeXo();
    api.studio.library.push(
      item({ id: 'a', name: 'signed-xo', signed: true, overallScore: 94.2, byCategory: { knowledge: 94 } }),
      item({ id: 'b', name: 'plain-xo' }),
    );
    await open(api);
    const signed = card('signed-xo');
    expect(within(signed).getByText(/Signature entries present \(1\) — not checked/)).toBeInTheDocument();
    expect(within(signed).getByText(/Benchmark score 94.2 — recorded by the publisher, not independently verified/)).toBeInTheDocument();
    const plain = card('plain-xo');
    expect(within(plain).getByText('No signature entries')).toBeInTheDocument();
    expect(within(plain).getByText('No benchmark runs recorded')).toBeInTheDocument();
    for (const t of document.body.textContent!.split(/(?<=[.!?])\s+/).filter((x) => /verified|authentic|trusted/i.test(x))) {
      expect(t, `"${t}" must be a negation`).toMatch(/\b(not|no|never|cannot|nor)\b/i);
    }
    expect(within(screen.getByRole('list', { name: 'XOs' })).queryByText(/★|rating|₹|price/i)).not.toBeInTheDocument();
  });

  it('installs and uninstalls through the platform, and the card follows', async () => {
    const api = new FakeXo();
    api.studio.library.push(item({ id: 'a', name: 'burglary-policy' }));
    const user = await open(api);
    await user.click(await screen.findByRole('button', { name: 'Install burglary-policy' }));
    expect(await screen.findByRole('button', { name: 'Uninstall burglary-policy' })).toBeInTheDocument();
    expect(within(card('burglary-policy')).getByText('Installed')).toBeInTheDocument();
    expect(api.studio.installs).toEqual([{ name: 'burglary-policy', version: '1.0.0' }]);
    await user.click(screen.getByRole('button', { name: /^Installed/ }));
    expect(within(screen.getByRole('list', { name: 'XOs' })).getByText('burglary-policy')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Uninstall burglary-policy' }));
    await waitFor(() => expect(api.studio.installs).toEqual([]));
    await user.click(screen.getByRole('button', { name: 'All' }));
    expect(await screen.findByRole('button', { name: 'Install burglary-policy' })).toBeInTheDocument();
    expect(api.studio.installs).toEqual([]);
  });

  it('a refused install shows the platform’s reason on that card: unsigned under a signature requirement; archive not kept', async () => {
    const api = new FakeXo();
    api.studio.settings.trust.requireSignedPackages = true;
    api.studio.library.push(item({ id: 'a', name: 'unsigned-xo' }), item({ id: 'b', name: 'old-xo', signed: true, installable: false }));
    const user = await open(api);
    await user.click(await screen.findByRole('button', { name: 'Install unsigned-xo' }));
    expect(await within(card('unsigned-xo')).findByRole('alert')).toHaveTextContent(/requires signed packages/);
    await user.click(screen.getByRole('button', { name: 'Install old-xo' }));
    expect(await within(card('old-xo')).findByRole('alert')).toHaveTextContent(/original package archive was not retained/);
    expect(api.studio.installs).toEqual([]);
  });

  it('filters and counts: Installed and Made by me; search goes to the platform', async () => {
    const api = new FakeXo();
    api.studio.library.push(item({ id: 'a', name: 'alpha', madeByMe: true }), item({ id: 'b', name: 'beta' }));
    api.studio.installs.push({ name: 'beta', version: '1.0.0' });
    const user = await open(api);
    await screen.findByText('alpha');
    await user.click(screen.getByRole('button', { name: /^Installed/ }));
    expect(within(screen.getByRole('list', { name: 'XOs' })).queryByText('alpha')).not.toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'XOs' })).getByText('beta')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Made by me/ }));
    expect(within(screen.getByRole('list', { name: 'XOs' })).getByText('alpha')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'All' }));
    await user.type(screen.getByLabelText('Search the library'), 'bet');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'XOs' })).queryByText('alpha')).not.toBeInTheDocument());
  });

  it('Details show the latest score per category and say what is not known', async () => {
    const api = new FakeXo();
    api.studio.library.push(
      item({ id: 'a', name: 'scored', signed: true, overallScore: 90, byCategory: { knowledge: 94, safety_checks: 86 } }),
    );
    const user = await open(api);
    await user.click(await screen.findByRole('button', { name: 'Details for scored' }));
    const list = await screen.findByRole('list', { name: 'Latest score per category' });
    expect(within(list).getByText('safety checks')).toBeInTheDocument();
    expect(within(list).getByText('94')).toBeInTheDocument();
    expect(screen.getByText(/present but not checked/)).toBeInTheDocument();
  });

  it('a Viewer can browse but Install is disabled with the reason; a stale hint is corrected by the platform’s refusal', async () => {
    const viewer = new FakeXo();
    viewer.studio.role = 'viewer';
    viewer.studio.library.push(item({ id: 'a', name: 'alpha' }));
    await open(viewer);
    const install = await screen.findByRole('button', { name: 'Install alpha' });
    expect(install).toBeDisabled();
    expect(install).toHaveAttribute('title', expect.stringMatching(/Viewer access does not include installing or removing XOs/));
  });
  it('if the hint is stale and the platform refuses, the card says the role is the reason', async () => {
    const api = new FakeXo();
    api.studio.role = 'viewer';
    api.studio.reportedRole = 'admin';
    api.studio.library.push(item({ id: 'a', name: 'alpha' }));
    const user = await open(api);
    await user.click(await screen.findByRole('button', { name: 'Install alpha' }));
    expect(await within(card('alpha')).findByRole('alert')).toHaveTextContent(/Your role does not allow this/);
    expect(api.studio.installs).toEqual([]);
  });

  it('empty library, and a failure with retry instead of an empty list', async () => {
    const api = new FakeXo();
    api.failing.add('/library');
    const user = await open(api);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    api.failing.clear();
    await user.click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(await screen.findByText('No XOs here yet')).toBeInTheDocument();
    expect(screen.getByText(/published to this workspace/)).toBeInTheDocument();
  });
});
