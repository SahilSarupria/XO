import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { FakeConnect } from '../fakeConnect';

const ev = (n: number, source = 'srcAAAAAAAAAAAA') => ({
  evidenceId: `ev_${n}`,
  sourceId: source,
  contentHash: 'sha256:9f3a1c0d5e7b2a4c8f6e1d3b5a7c9e0f2b4d6f8a',
  observedAt: '2026-11-03T09:00:00.000Z',
});
const stmt = (over: Record<string, unknown>) => ({
  ref: 'r',
  kind: 'claim',
  text: 't',
  status: 'known',
  origin: 'observed',
  confidence: { status: 'known', strength: 'direct', basis: 'x', corroboration: 1, calibrated: false },
  evidence: [ev(1)],
  reviewRequired: false,
  ...over,
});

const seed = (c: FakeConnect) => {
  c.statements = [
    stmt({ ref: 'e1', kind: 'entity', text: 'Priya Sharma (person)' }),
    stmt({ ref: 'c1', text: 'Priya Sharma has title Senior Finance Manager', origin: 'observed' }),
    stmt({ ref: 'c2', text: 'Raj Patel works on PRJ-2042', status: 'hypothesis', origin: 'inferred', reviewRequired: true }),
    stmt({
      ref: 'x1',
      kind: 'conflict',
      text: 'Approval limit: 500,000 or 300,000',
      status: 'conflicted',
      reviewRequired: true,
      evidence: [ev(2, 'srcAAAAAAAAAAAA'), ev(3, 'srcBBBBBBBBBBBB')],
    }),
  ];
};

async function open(connect: FakeConnect, api: FakeXo) {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={connect.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Claims Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Claims Ops' });
  await user.click(screen.getByRole('button', { name: 'Knowledge' }));
  await screen.findByRole('heading', { name: 'Knowledge' });
  return user;
}
const setup = () => {
  const api = new FakeXo();
  const connect = new FakeConnect(api);
  seed(connect);
  return { api, connect };
};

describe('Knowledge screen', () => {
  it('search is keyword search and says so; results carry status, source count and evidence', async () => {
    const { api, connect } = setup();
    const user = await open(connect, api);
    expect(screen.getByText(/does not interpret questions/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Search knowledge'), 'priya');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Priya Sharma has title Senior Finance Manager')).toBeInTheDocument();
    expect(screen.getAllByText('Observed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('1 source').length).toBeGreaterThan(0);
    expect(screen.getByText(/1 rest on a single source/)).toBeInTheDocument();
  });

  it('evidence panel: sources, hash, "not a probability", and no claim that anything disappears immediately', async () => {
    const { api, connect } = setup();
    const user = await open(connect, api);
    await user.type(screen.getByLabelText('Search knowledge'), 'title');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.click(await screen.findByRole('button', { name: 'Evidence' }));
    const panel = await screen.findByRole('complementary', { name: 'Evidence' });
    expect(within(panel).getByText('Backed by 1 independent source.')).toBeInTheDocument();
    expect(within(panel).getByText(/not a probability/)).toBeInTheDocument();
    expect(within(panel).getByText(/stops being shown only if every source behind it is removed/)).toBeInTheDocument();
    expect(within(panel).getByText(/Something missing here is not proof nothing is known/)).toBeInTheDocument();
    expect(panel.textContent).not.toMatch(/immediately|right away/i);
    expect(within(panel).getByText(/sha256:9f3a1c0d5e…|sha256:/)).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('complementary', { name: 'Evidence' })).not.toBeInTheDocument();
  });

  it('a conflict shows both sides as independent sources and says XO has not chosen', async () => {
    const { api, connect } = setup();
    const user = await open(connect, api);
    await user.click(screen.getByRole('tab', { name: 'Conflicts' }));
    expect(await screen.findByText('Approval limit: 500,000 or 300,000')).toBeInTheDocument();
    expect(screen.getByText('Conflict')).toBeInTheDocument();
    expect(screen.getByText('2 sources')).toBeInTheDocument();
    expect(screen.getByText(/XO has not chosen/)).toBeInTheDocument();
  });

  it('needs review: read-only, with no decision buttons', async () => {
    const { api, connect } = setup();
    const user = await open(connect, api);
    await user.click(screen.getByRole('tab', { name: 'Needs review' }));
    expect(await screen.findByText(/A reviewer needs to decide these/)).toBeInTheDocument();
    expect(screen.getByText('Unverified guess')).toBeInTheDocument();
    for (const name of [/approve/i, /block/i, /resolve/i, /undo/i]) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });

  it('empty states are honest about what is and is not known', async () => {
    const { api, connect } = setup();
    connect.statements = [];
    const user = await open(connect, api);
    await user.type(screen.getByLabelText('Search knowledge'), 'zeppelin');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Nothing matched "zeppelin"')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Facts' }));
    expect(await screen.findByText(/only structured organizational records become knowledge today/)).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Conflicts' }));
    expect(await screen.findByText('No conflicting information found')).toBeInTheDocument();
  });

  it('when the host keeps no knowledge, the screen shows a problem, not an empty result', async () => {
    const { api, connect } = setup();
    connect.knowledgeStatus = 503;
    const user = await open(connect, api);
    await user.click(screen.getByRole('tab', { name: 'Facts' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('a response that claims anything other than visible-scope-only is rejected', async () => {
    const { api, connect } = setup();
    const orig = connect.fetch;
    connect.fetch = async (input, init) => {
      const r = await orig(input, init);
      if (!input.includes('/connect/knowledge')) return r;
      const body = JSON.parse(await r.text()) as { access: { completeness: string } };
      body.access.completeness = 'complete';
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const user = await open(connect, api);
    await user.click(screen.getByRole('tab', { name: 'Facts' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Priya Sharma has title Senior Finance Manager')).not.toBeInTheDocument();
  });
});
