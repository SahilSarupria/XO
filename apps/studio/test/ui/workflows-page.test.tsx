import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { findStart, openScreen, openWorkflow } from './nav';

type U = ReturnType<typeof userEvent.setup>;

async function open(api: FakeXo): Promise<U> {
  window.history.replaceState(null, '', '#/home');
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Ops' });
  return user;
}
async function analysed(api: FakeXo): Promise<U> {
  const user = await open(api);
  await user.click(screen.getByRole('button', { name: /^my xos/i }));
  await user.upload(
    document.getElementById('file-upload') as HTMLInputElement,
    new File(['%PDF'], 'procedure.pdf', { type: 'application/pdf' }),
  );
  await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
  await screen.findByText(/settlement amount must be recorded/i);
  await openScreen(user, 'Work');
  await waitFor(() => expect(document.querySelector('[data-wf-open]')).not.toBeNull());
  return user;
}
const title = () => document.querySelector<HTMLElement>('[data-wf-open]')!;

describe('Workflows page: first time', () => {
  it('says what happens next in four plain steps and offers one thing to do, which goes to the documents', async () => {
    const user = await open(new FakeXo());
    await openScreen(user, 'Work');
    expect(await screen.findByRole('heading', { name: /set up your first workflow/i })).toBeInTheDocument();
    const steps = screen.getAllByRole('listitem').filter((li) => li.closest('.wf-first') !== null);
    expect(steps).toHaveLength(4);
    expect(screen.queryByRole('button', { name: 'New workflow' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /add your first document/i }));
    expect(await screen.findByRole('button', { name: 'Documents' })).toBeInTheDocument(); // My XOs, where documents are added
  });
});

describe('Workflows page: cards', () => {
  it('shows each workflow as one card with only what the platform reports, and nothing it does not', async () => {
    await analysed(new FakeXo());
    const cards = screen.getByRole('list', { name: 'Workflows' });
    expect(cards.querySelectorAll('.wc')).toHaveLength(1);
    const card = cards.querySelector<HTMLElement>('.wc')!;
    expect(within(card).getByText('Needs approval')).toBeInTheDocument();
    expect(within(card).getByText('2 rules to approve')).toBeInTheDocument();
    expect(within(card).getByText('Someone starts it')).toBeInTheDocument();
    expect(within(card).getByText('Not run yet')).toBeInTheDocument();
    expect(within(card).getByText(/steps? XO carries out · 1 a person decides/)).toBeInTheDocument();
    // Things the platform does not report yet are not on the page, not even as plausible-looking placeholders.
    expect(card.textContent).not.toMatch(/signed|webhook|shadow|practis|live\b|schedule|permission|limit/i);
    expect(screen.queryByText(/pause everything/i)).not.toBeInTheDocument();
    expect(screen.getByText(/has not been measured yet/i)).toBeInTheDocument();
  });

  it('puts what needs a person at the top, in plain words, with one button each', async () => {
    const user = await analysed(new FakeXo());
    const need = screen.getByRole('region', { name: '1 thing needs you' });
    expect(within(need).getByText(/2 rules need your approval before this can start/i)).toBeInTheDocument();
    await user.click(within(need).getByRole('button', { name: 'Review rules' }));
    expect(await screen.findByRole('heading', { name: 'Review' })).toBeInTheDocument();
  });

  it('shows nothing on the needs-you card when everything is approved, and says "All clear"', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    await analysed(api);
    expect(screen.queryByRole('region', { name: /need you|needs you/i })).not.toBeInTheDocument();
    const card = screen.getByRole('list', { name: 'Workflows' });
    expect(within(card).getByText('Ready to start')).toBeInTheDocument();
    expect(within(card).getByText('All clear')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^needs you/i })).not.toBeInTheDocument();
  });

  it('a run that waits for a person moves to the needs-you card and the filter', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    const user = await analysed(api);
    await user.click(await findStart(user)); // starting lands on the waiting decision in Inbox
    await screen.findByRole('button', { name: /approve this step/i });
    await openScreen(user, 'Work');
    await waitFor(() => expect(document.querySelector('[data-wf-open]')).not.toBeNull());
    expect(within(screen.getByRole('list', { name: 'Workflows' })).getByText('A person must decide')).toBeInTheDocument();
    const need = screen.getByRole('region', { name: '1 thing needs you' });
    await user.click(within(need).getByRole('button', { name: 'Decide now' }));
    expect(await screen.findByRole('button', { name: /approve this step/i })).toBeInTheDocument();
  });

  it('filters by what needs you, and hides search until there are enough workflows to need it', async () => {
    const user = await analysed(new FakeXo());
    const pills = screen.getByRole('group', { name: 'Filter workflows' });
    expect(within(pills).getByRole('button', { name: /^All 1$/ })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(pills).getByRole('button', { name: /^Needs you 1$/ }));
    expect(screen.getByRole('list', { name: 'Workflows' }).querySelectorAll('.wc')).toHaveLength(1);
    expect(within(pills).queryByRole('button', { name: /In progress/ })).not.toBeInTheDocument(); // nothing is in progress, so no empty pill
    expect(screen.queryByRole('textbox', { name: /search workflows/i })).not.toBeInTheDocument();
  });
});

describe('Workflows page: details panel', () => {
  it('opens from the card, is named, shows the real checklist, and the URL follows the open workflow', async () => {
    const user = await analysed(new FakeXo());
    await user.click(title());
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent(/record before payment/i);
    expect(within(dialog).getByText('2 of 3 done')).toBeInTheDocument();
    expect(within(dialog).getByText(/Needs approval: Record before payment/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/deterministically composed/i)).not.toBeInTheDocument(); // the platform's raw description is for Builder mode only
    expect(within(dialog).getByText('2 steps · 1 needs a person')).toBeInTheDocument();
    expect(window.location.hash).toMatch(/^#\/work\/.+/);
    expect(dialog.textContent).not.toMatch(/signed|shadow|practis|permission/i);
  });

  it('Escape closes it, the URL goes back, and the keyboard returns to the card', async () => {
    const user = await analysed(new FakeXo());
    await user.click(title());
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(window.location.hash).toBe('#/work');
    await waitFor(() => expect(document.activeElement).toBe(title()));
  });

  it('keeps Tab inside the panel while it is open', async () => {
    const user = await analysed(new FakeXo());
    await user.click(title());
    const dialog = await screen.findByRole('dialog');
    for (let i = 0; i < 14; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 6; i++) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('closing from the close button, or from the dimmed background, both work', async () => {
    const user = await analysed(new FakeXo());
    await openWorkflow(user);
    await user.click(screen.getByRole('button', { name: 'Close details' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await openWorkflow(user);
    await user.click(document.querySelector('.wp-scrim')!);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('Workflows page: the ⋯ menu', () => {
  it('offers the details and the graph, closes with Escape, and keeps the card as a single tab stop', async () => {
    const user = await analysed(new FakeXo());
    const more = screen.getByRole('button', { name: /^more actions for/i });
    await user.click(more);
    const menu = screen.getByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent),
    ).toEqual(['See details', 'Open the graph']);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(more);
    await user.click(more);
    await user.click(screen.getByRole('menuitem', { name: 'See details' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('"Open the graph" goes to the workflow graph', async () => {
    const user = await analysed(new FakeXo());
    await user.click(screen.getByRole('button', { name: /^more actions for/i }));
    await user.click(screen.getByRole('menuitem', { name: 'Open the graph' }));
    expect(await screen.findByRole('region', { name: 'Workflow graph' })).toBeInTheDocument();
  });
});
