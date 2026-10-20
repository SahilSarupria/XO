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
  await user.upload(document.getElementById('file-upload') as HTMLInputElement, new File(['%PDF'], 'procedure.pdf', { type: 'application/pdf' }));
  await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
  await screen.findByText(/settlement amount must be recorded/i);
  return user;
}

async function openGraph(user: U) {
  await openScreen(user, 'Work');
  await user.click(await screen.findByRole('button', { name: /view graph of/i }));
  return screen.findByRole('region', { name: 'Workflow graph' });
}

describe('Workflow graph', () => {
  it('draws the process steps the platform composed, in order, with a node count', async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    const canvas = await openGraph(user);
    const nodes = within(within(canvas).getByRole('list', { name: /steps in the order they run/i })).getAllByRole('button');
    expect(nodes.map((n) => n.querySelector('.wf-node-name')?.textContent)).toEqual(['Record before payment', 'Review not covered']);
    expect(within(nodes[1]!).getByText('person decides')).toBeInTheDocument();
    expect(within(canvas).getByText('2 nodes')).toBeInTheDocument();
    expect(window.location.hash).toBe('#/graph');
    expect(screen.getByRole('button', { name: /^workflows$/i, hidden: false })).toBeInTheDocument(); // breadcrumb back
  });

  it('shows what is not available as unavailable: save, adding nodes, memory scope, editing', async () => {
    const user = await analysed(new FakeXo());
    await openGraph(user);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-disabled', 'true');
    const palette = screen.getByRole('complementary', { name: 'Node palette' });
    for (const name of ['Document dropped', 'Schedule', 'Branch', 'Human review', 'Webhook / Email'])
      expect(within(palette).getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
    expect(within(palette).getAllByText('Preview').length).toBe(3);
    expect(within(screen.getByRole('complementary', { name: 'Inspector' })).getByText('Not available yet')).toBeInTheDocument();
    expect(screen.getByText('Read-only')).toBeInTheDocument();
  });

  it('lists the real capabilities in the palette, filters them, and a click selects the matching node', async () => {
    const user = await analysed(new FakeXo());
    await openGraph(user);
    const palette = screen.getByRole('complementary', { name: 'Node palette' });
    expect(within(palette).getByRole('button', { name: 'Notify the Insurer' })).toBeInTheDocument();
    await user.type(within(palette).getByLabelText('Search nodes'), 'review');
    expect(within(palette).queryByRole('button', { name: 'Notify the Insurer' })).not.toBeInTheDocument();
    await user.click(within(palette).getByRole('button', { name: 'Review not covered' }));
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect(within(inspector).getByRole('heading', { name: 'Review not covered' })).toBeInTheDocument();
    expect(within(inspector).getByText('Person decides')).toBeInTheDocument();
    expect(within(inspector).getByText('No output recorded for this step yet.')).toBeInTheDocument();
    expect(within(inspector).getByText('Not approved yet')).toBeInTheDocument();
  });

  it('will not offer Run while approvals are missing, and says why', async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    await openGraph(user);
    expect(screen.getByRole('button', { name: /run/i })).toBeDisabled();
    expect(screen.getByText(/still need your approval/i)).toBeInTheDocument();
    expect(screen.getByText('Needs approval')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'POST' && c.path.includes('/workflows/'))).toBe(false);
  });

  it('Run starts the process through the same guarded path as the Workflows list', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    const user = await analysed(api);
    await openGraph(user);
    expect(await screen.findByText('Ready')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /run/i }));
    await waitFor(() => expect(api.calls.filter((c) => c.method === 'POST' && /\/workflows\/wf_1\/executions$/.test(c.path))).toHaveLength(1));
    const start = api.calls.find((c) => c.method === 'POST' && /\/workflows\/wf_1\/executions$/.test(c.path))!;
    expect(start.headers?.['Idempotency-Key']).toBeTruthy();
  });

  it('while a run is under way, Run is unavailable and the screen points at the run instead', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    const user = await analysed(api);
    await user.click(screen.getByRole('button', { name: /^home$/i }));
    await openScreen(user, 'Work');
    await user.click(await screen.findByRole('button', { name: /start this process/i }));
    await waitFor(() => expect(window.location.hash).toBe('#/tasks'));
    await openScreen(user, 'Work');
    await user.click(await screen.findByRole('button', { name: /view graph of/i }));
    await screen.findByRole('region', { name: 'Workflow graph' });
    expect(screen.getByRole('button', { name: /run/i })).toBeDisabled();
    expect(screen.getByText(/waiting for a decision/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue in inbox/i })).toBeInTheDocument();
    expect(api.calls.filter((c) => c.method === 'POST' && /\/workflows\/wf_1\/executions$/.test(c.path))).toHaveLength(1);
  });

  it('Settings shows only what the platform holds and says it is not editable', async () => {
    const user = await analysed(new FakeXo());
    await openGraph(user);
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(screen.getByText(/not editable yet/i)).toBeInTheDocument();
    expect(screen.getByText('Steps')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Editor' }));
    expect(screen.getByRole('region', { name: 'Workflow graph' })).toBeInTheDocument();
  });

  it('zoom controls resize the drawing and Fit restores it', async () => {
    const user = await analysed(new FakeXo());
    const canvas = await openGraph(user);
    const stage = () => canvas.querySelector('.wf-stage') as HTMLElement;
    const base = stage().style.width;
    await user.click(within(canvas).getByRole('button', { name: 'Zoom in' }));
    expect(stage().style.width).not.toBe(base);
    await user.click(within(canvas).getByRole('button', { name: 'Fit' }));
    expect(stage().style.width).toBe(base);
  });

  it('the breadcrumb returns to the Workflows list', async () => {
    const user = await analysed(new FakeXo());
    await openGraph(user);
    await user.click(screen.getByRole('button', { name: 'Workflows' }));
    expect(await screen.findByRole('heading', { name: /^workflows$/i })).toBeInTheDocument();
  });

  it('with no analysis yet, says so instead of drawing anything', async () => {
    const user = userEvent.setup();
    const api = new FakeXo();
    render(withShell(<App fetchImpl={api.fetch} />));
    await user.type(screen.getByLabelText(/access key/i), api.validKey);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
    await user.click(screen.getByRole('button', { name: /create workspace/i }));
    await screen.findByRole('heading', { name: 'Ops' });
    window.location.hash = '#/graph';
    expect(await screen.findByText('No workflow to show yet')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Workflow graph' })).not.toBeInTheDocument();
  });
});
