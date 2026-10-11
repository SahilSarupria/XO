import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { FakeXo } from '../fakeXo';

async function connect(api: FakeXo, key = api.validKey) {
  const user = userEvent.setup();
  render(<App fetchImpl={api.fetch} />);
  await user.type(screen.getByLabelText(/access key/i), key);
  await user.click(screen.getByRole('button', { name: /connect/i }));
  return user;
}

async function createWorkspaceAndUpload(user: ReturnType<typeof userEvent.setup>, filename = 'policy.pdf') {
  await user.type(await screen.findByLabelText(/workspace name/i), 'Claims Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Claims Ops' });
  const input = document.getElementById('file-upload') as HTMLInputElement;
  await user.upload(input, new File(['%PDF'], filename, { type: 'application/pdf' }));
}

describe('connecting', () => {
  it('rejects a bad key with a clear message, stays signed out, and stores nothing', async () => {
    const api = new FakeXo();
    await connect(api, 'xoak_wrong');
    expect(await screen.findByText(/access key was not accepted/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('xoak_');
  });

  it('never persists the key anywhere after a successful connect', async () => {
    const api = new FakeXo();
    await connect(api);
    await screen.findByLabelText(/workspace name/i);
    expect(JSON.stringify({ ...window.localStorage, ...window.sessionStorage })).not.toContain('xoak_good');
    expect(document.cookie).not.toContain('xoak_');
  });

  it('reports an unreachable service honestly', async () => {
    const user = userEvent.setup();
    render(<App fetchImpl={async () => { throw new TypeError('Failed to fetch'); }} />);
    await user.type(screen.getByLabelText(/access key/i), 'k');
    await user.click(screen.getByRole('button', { name: /connect/i }));
    expect(await screen.findByText(/cannot reach xo/i)).toBeInTheDocument();
  });
});

describe('golden path: context → analyse → review → approve → run', () => {
  it('walks the whole journey against real wire shapes', async () => {
    const api = new FakeXo();
    const user = await connect(api);
    await createWorkspaceAndUpload(user);

    expect(await screen.findByText('policy.pdf')).toBeInTheDocument();
    expect(screen.getByText('Analyse your document')).toBeInTheDocument(); // next-step guidance is derived from real state
    await user.click(screen.getByRole('button', { name: /^analyse$/i }));

    // lands in Review with the real clause text as evidence
    expect(await screen.findByText(/settlement amount must be recorded/i)).toBeInTheDocument();
    expect(screen.getAllByText(/page 2/i).length).toBeGreaterThan(0);

    // the unresolved rule is clearly "needs more information" and cannot be approved
    const open = screen.getByRole('heading', { name: 'Notify the Insurer' }).closest('li')!;
    expect(within(open).getByText('Needs more information')).toBeInTheDocument();
    expect(within(open).queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();

    // approve requires an explicit confirmation, and nothing is sent before it
    const det = screen.getByRole('heading', { name: 'Record before payment' }).closest('li')!;
    await user.click(within(det).getByRole('button', { name: /^approve$/i }));
    expect(api.calls.some((c) => c.path.endsWith('/approve'))).toBe(false);
    await user.click(within(det).getByRole('button', { name: /confirm approval/i }));
    await waitFor(() => expect(within(screen.getByRole('heading', { name: 'Record before payment' }).closest('li')!).getByText('Approval recorded')).toBeInTheDocument());
    expect(api.calls.filter((c) => c.path.endsWith('/approve'))).toHaveLength(1);

    // run with no details: the platform rejects the input and Studio says so — it is NOT shown as success
    await user.click(within(screen.getByRole('heading', { name: 'Record before payment' }).closest('li')!).getByRole('button', { name: /run…/i }));
    await user.click(screen.getByRole('button', { name: /^run$/i }));
    const outcome = await screen.findByText('Did not complete');
    expect(outcome).toBeInTheDocument();
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
    expect(screen.getByText(/missing required property/i)).toBeInTheDocument();
  });

  it('pre-fills the field names the platform reported missing, and a corrected run completes', async () => {
    const api = new FakeXo();
    const user = await connect(api);
    await createWorkspaceAndUpload(user);
    await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
    await screen.findByText(/settlement amount must be recorded/i);
    const card = () => screen.getByRole('heading', { name: 'Record before payment' }).closest('li')!;
    await user.click(within(card()).getByRole('button', { name: /^approve$/i }));
    await user.click(within(card()).getByRole('button', { name: /confirm approval/i }));
    await user.click(await within(card()).findByRole('button', { name: /run…/i }));
    await user.click(screen.getByRole('button', { name: /^run$/i }));
    await screen.findByText('Did not complete');

    // the panel closes after a run; the failed outcome stays visible on the card
    expect(within(card()).getByText('Did not complete')).toBeInTheDocument();
    api.executeBehavior = 'succeed';
    await user.click(within(card()).getByRole('button', { name: /run…/i }));
    expect(screen.getByDisplayValue('claim')).toBeInTheDocument();
    expect(screen.getByDisplayValue('lossadjuster_assessment')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Value for claim'), '{{"amount": 1200}');
    await user.click(screen.getByRole('button', { name: /^run$/i }));
    await waitFor(() => expect(within(card()).getByText('Completed')).toBeInTheDocument());
    const last = api.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/executions')).at(-1)!;
    expect(last.body).toMatchObject({ capabilityId: 'cap_det', input: { claim: { amount: 1200 } } });
    expect(JSON.stringify(last.body)).not.toMatch(/identity|principal|sally/i);
  });
});

describe('honest handling of things that cannot proceed', () => {
  it('does not advance to Review when the platform records a failed analysis', async () => {
    const api = new FakeXo();
    api.failNextCompile = { errorCode: 'XO_COMPILER_PARSE_FAILED', errorMessage: 'could not parse the PDF' };
    const user = await connect(api);
    await createWorkspaceAndUpload(user);
    await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
    expect(await screen.findByText(/could not analyse this document/i)).toBeInTheDocument();
    expect(screen.getByText(/could not parse the PDF/i)).toBeInTheDocument();
    expect(screen.queryByText(/settlement amount must be recorded/i)).not.toBeInTheDocument();
  });

  it('shows "not available yet" for a 501 and never as a result', async () => {
    const api = new FakeXo();
    const user = await connect(api);
    await createWorkspaceAndUpload(user);
    await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
    const card = () => screen.getByRole('heading', { name: 'Record before payment' }).closest('li')!;
    await user.click(await within(card()).findByRole('button', { name: /^approve$/i }));
    await user.click(within(card()).getByRole('button', { name: /confirm approval/i }));
    await user.click(await within(card()).findByRole('button', { name: /run…/i }));
    api.executeBehavior = 'unavailable';
    await user.click(screen.getByRole('button', { name: /^run$/i }));
    expect(await screen.findByText(/not available yet/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing was attempted/i)).toBeInTheDocument();
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
  });

  it('shows a permission failure as a refusal, not a success', async () => {
    const api = new FakeXo();
    const user = await connect(api);
    await createWorkspaceAndUpload(user);
    await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
    const card = () => screen.getByRole('heading', { name: 'Record before payment' }).closest('li')!;
    await user.click(await within(card()).findByRole('button', { name: /^approve$/i }));
    await user.click(within(card()).getByRole('button', { name: /confirm approval/i }));
    await user.click(await within(card()).findByRole('button', { name: /run…/i }));
    api.executeBehavior = 'forbidden';
    await user.click(screen.getByRole('button', { name: /^run$/i }));
    expect(await screen.findByText(/XO refused this action/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing was run/i)).toBeInTheDocument();
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
  });

  it('rejects an unsupported file type before any upload request and says why', async () => {
    const api = new FakeXo();
    const user = await connect(api);
    await user.type(await screen.findByLabelText(/workspace name/i), 'W');
    await user.click(screen.getByRole('button', { name: /create workspace/i }));
    await screen.findByRole('heading', { name: 'W' });
    const input = document.getElementById('file-upload') as HTMLInputElement;
    // userEvent honours `accept`, so bypass it to exercise our own check
    const u2 = userEvent.setup({ applyAccept: false });
    await u2.upload(input, new File(['x'], 'rules.docx'));
    expect(await screen.findByText(/word documents are not supported/i)).toBeInTheDocument();
    expect(api.calls.some((c) => c.path.includes('/sources') && c.method === 'POST')).toBe(false);
  });

  it('a paused human step offers a decision, and deciding calls the platform', async () => {
    const api = new FakeXo();
    api.executeBehavior = 'waiting_for_human';
    const user = await connect(api);
    await createWorkspaceAndUpload(user);
    await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
    const card = () => screen.getByRole('heading', { name: 'Review not covered' }).closest('li')!;
    await user.click(await within(card()).findByRole('button', { name: /^approve$/i }));
    await user.click(within(card()).getByRole('button', { name: /confirm approval/i }));
    await user.click(await within(card()).findByRole('button', { name: /run…/i }));
    await user.click(screen.getByRole('button', { name: /^run$/i }));
    expect(await screen.findByText('Waiting for a person to decide')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /approve this step/i }));
    await waitFor(() => expect(api.calls.some((c) => c.path.endsWith('/resolve'))).toBe(true));
    expect(api.calls.find((c) => c.path.endsWith('/resolve'))?.body).toEqual({ decision: 'approve' });
    await waitFor(() => expect(screen.queryByText('Waiting for a person to decide')).not.toBeInTheDocument());
  });
});

describe('Builder Mode', () => {
  it('reveals technical detail without changing what can be done or what is requested', async () => {
    const api = new FakeXo();
    const user = await connect(api);
    await createWorkspaceAndUpload(user);
    await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
    await screen.findByText(/settlement amount must be recorded/i);

    const actionsBefore = screen.getAllByRole('button').map((b) => b.textContent).filter((t) => /approve|run/i.test(t ?? ''));
    const callsBefore = api.calls.length;
    expect(screen.queryByText('cap_det')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Builder' }));
    expect((await screen.findAllByText(/cap_det/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/structured-comparison-resolver/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Processes' })).toBeInTheDocument();

    const actionsAfter = screen.getAllByRole('button').map((b) => b.textContent).filter((t) => /approve|run/i.test(t ?? ''));
    expect(actionsAfter).toEqual(actionsBefore); // no extra authority
    expect(api.calls.length).toBe(callsBefore); // switching mode issues no requests
  });

  it('lists platform workflows read-only, including whether they can run', async () => {
    const api = new FakeXo();
    const user = await connect(api);
    await createWorkspaceAndUpload(user);
    await user.click(await screen.findByRole('button', { name: 'Builder' }));
    await user.click(await screen.findByRole('button', { name: 'Processes' }));
    expect(await screen.findByText('Can run')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start|execute|run/i })).not.toBeInTheDocument();
  });
});


describe('WP2: truthful semantics', () => {
  async function toApprovedCard(api: FakeXo) {
    const user = await connect(api);
    await createWorkspaceAndUpload(user);
    await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
    const card = () => screen.getByRole('heading', { name: 'Record before payment' }).closest('li')!;
    await user.click(await within(card()).findByRole('button', { name: /^approve$/i }));
    await user.click(within(card()).getByRole('button', { name: /confirm approval/i }));
    await within(card()).findByText('Approval recorded');
    return { user, card };
  }

  it('says an approval is recorded, not that the rule is cleared to run', async () => {
    const { card } = await toApprovedCard(new FakeXo());
    expect(within(card()).getByText(/not a guarantee that a run will succeed/i)).toBeInTheDocument();
    expect(within(card()).queryByText(/can now be run/i)).not.toBeInTheDocument();
  });

  it('labels field names taken from an error message as hints, and says no verified form exists', async () => {
    const api = new FakeXo();
    const { user, card } = await toApprovedCard(api);
    await user.click(within(card()).getByRole('button', { name: /run…/i }));
    expect(screen.getByText(/does not publish the list of details/i)).toBeInTheDocument();
    expect(screen.queryByText(/hint from XO/i)).not.toBeInTheDocument(); // nothing inferred yet
    await user.click(screen.getByRole('button', { name: /^run$/i }));
    await screen.findByText('Did not complete');
    await user.click(within(card()).getByRole('button', { name: /run…/i }));
    expect(screen.getAllByText(/hint from XO/i).length).toBe(2);
    expect(screen.getByText(/hints, not a checked schema/i)).toBeInTheDocument();
    // a field the person adds is not labelled as a hint
    await user.click(screen.getByRole('button', { name: /add a detail/i }));
    expect(screen.getAllByText(/hint from XO/i).length).toBe(2);
  });

  it('a run that XO cannot bind is a failure with guidance, never a success', async () => {
    const api = new FakeXo();
    api.executeBehavior = 'binding_unresolved';
    const { user, card } = await toApprovedCard(api);
    await user.click(within(card()).getByRole('button', { name: /run…/i }));
    await user.click(screen.getByRole('button', { name: /^run$/i }));
    expect(await screen.findByText('Did not complete')).toBeInTheDocument();
    expect(screen.getByText(/cannot carry it out yet, so nothing ran/i)).toBeInTheDocument();
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
  });

  it('a refused approval (stale view) is shown as XO refusing, and the rule is not shown as approved', async () => {
    const api = new FakeXo();
    const user = await connect(api);
    await createWorkspaceAndUpload(user);
    await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
    const card = () => screen.getByRole('heading', { name: 'Record before payment' }).closest('li')!;
    api.approveRefusal = true;
    await user.click(await within(card()).findByRole('button', { name: /^approve$/i }));
    await user.click(within(card()).getByRole('button', { name: /confirm approval/i }));
    expect(await within(card()).findByText(/cannot carry this rule out yet/i)).toBeInTheDocument();
    expect(within(card()).queryByText('Approval recorded')).not.toBeInTheDocument();
    expect(api.approvals.size).toBe(0);
  });
});
