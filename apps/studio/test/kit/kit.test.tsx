/**
 * S1-1 — the kit's parts, each in its states: actions (loading, unavailable with a reason, two-step confirm, type to confirm),
 * fields (label, hint and error wired to the control), choices, tabs (keyboard), overlays (focus in, trapped, Escape, focus
 * back), toasts (announced), status in words and shapes, tables (sort, phone labels, row action, more), and a data view's five
 * distinct states. The whole kit page has no axe violations.
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  Banner,
  Breadcrumb,
  Button,
  Card,
  Checkbox,
  ConfirmButton,
  CountSummary,
  DataTable,
  DataView,
  Dialog,
  Disclosure,
  EmptyState,
  Field,
  FileDrop,
  FormErrors,
  IconButton,
  Progress,
  RadioGroup,
  Select,
  Sheet,
  StatusPill,
  Switch,
  Tabs,
  TextArea,
  TextField,
  Timeline,
  ToastProvider,
  WhoMark,
  statusLabel,
  useToast,
  type Status,
} from '../../src/ui/kit';
import { KitPage } from '../../src/ui/kit/KitPage';
import type { LoadState } from '../../src/ui/primitives';

describe('actions', () => {
  it('a loading button is busy, stays focusable and ignores clicks', async () => {
    const click = vi.fn();
    render(
      <Button loading onClick={click}>
        Starting
      </Button>,
    );
    const b = screen.getByRole('button', { name: 'Starting' });
    expect(b).toHaveAttribute('aria-busy', 'true');
    expect(b).toHaveAttribute('aria-disabled', 'true');
    expect(b).not.toBeDisabled();
    await userEvent.click(b);
    expect(click).not.toHaveBeenCalled();
  });

  it('an unavailable button says why, next to it, and is described by the reason', async () => {
    const click = vi.fn();
    render(
      <Button variant="primary" disabledReason="Nobody has signed this version off yet." onClick={click}>
        Go live
      </Button>,
    );
    const b = screen.getByRole('button', { name: 'Go live' });
    expect(b).toHaveAccessibleDescription('Nobody has signed this version off yet.');
    await userEvent.click(b);
    expect(click).not.toHaveBeenCalled();
  });

  it('an icon button is named by its label', () => {
    render(<IconButton label="More actions" icon={<span>…</span>} />);
    expect(screen.getByRole('button', { name: 'More actions' })).toBeInTheDocument();
  });

  it('a two-step confirm asks first, Escape backs out, and the second press confirms', async () => {
    const done = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmButton consequence="The run stops." confirmLabel="Stop the run" onConfirm={done}>
        Stop
      </ConfirmButton>,
    );
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByText('The run stops.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop the run' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByText('The run stops.')).not.toBeInTheDocument();
    expect(done).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await user.click(screen.getByRole('button', { name: 'Stop the run' }));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('a destructive confirm stays unavailable until the exact text is typed', async () => {
    const done = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmButton consequence="Deleted for everyone." confirmLabel="Delete" typeToConfirm="Operations" onConfirm={done} variant="danger">
        Delete the workspace
      </ConfirmButton>,
    );
    await user.click(screen.getByRole('button', { name: 'Delete the workspace' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(done).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(/type operations to confirm/i), 'Operations');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe('fields', () => {
  it('label, hint and error are wired to the control; an error marks it invalid', () => {
    render(
      <>
        <Field label="Workflow name" hint="People see this in lists.">
          <TextField />
        </Field>
        <Field label="Subject" error="Write a subject for the message.">
          <TextField />
        </Field>
        <Field label="Message" optional>
          <TextArea />
        </Field>
      </>,
    );
    expect(screen.getByRole('textbox', { name: 'Workflow name' })).toHaveAccessibleDescription('People see this in lists.');
    const subject = screen.getByRole('textbox', { name: 'Subject' });
    expect(subject).toHaveAttribute('aria-invalid', 'true');
    expect(subject).toHaveAccessibleDescription('Write a subject for the message.');
    expect(screen.getByRole('textbox', { name: 'Message (optional)' })).not.toHaveAttribute('aria-invalid');
  });

  it('a control outside a field is refused (every control needs a visible label)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<TextField />)).toThrow(/inside <Field>/);
  });

  it('select, checkbox, radio group and switch report their choices', async () => {
    const user = userEvent.setup();
    function Form() {
      const [c, setC] = useState(false);
      const [r, setR] = useState<'a' | 'b' | undefined>(undefined);
      const [s, setS] = useState(false);
      return (
        <>
          <Field label="Send from">
            <Select options={[{ value: 'x', label: 'office@example.org' }]} />
          </Field>
          <Checkbox label="Also decide this step" checked={c} onChange={setC} />
          <RadioGroup
            legend="Approval"
            value={r}
            onChange={setR}
            options={[
              { value: 'a', label: 'Each run' },
              { value: 'b', label: 'Standing' },
            ]}
          />
          <Switch label="Email me" checked={s} onChange={setS} />
          <output>{`${c}-${r ?? 'none'}-${s}`}</output>
        </>
      );
    }
    render(<Form />);
    expect(screen.getByRole('combobox', { name: 'Send from' })).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Also decide this step' }));
    await user.click(screen.getByRole('radio', { name: 'Standing' }));
    await user.click(screen.getByRole('switch', { name: 'Email me' }));
    expect(screen.getByRole('group', { name: 'Approval' })).toBeInTheDocument();
    expect(screen.getByText('true-b-true')).toBeInTheDocument();
  });

  it('a file can be chosen with the real file input', async () => {
    const files = vi.fn();
    render(<FileDrop label="Drop a document here" onFiles={files} />);
    await userEvent.upload(screen.getByLabelText('Choose a file'), new File(['x'], 'list.csv', { type: 'text/csv' }));
    expect(files.mock.calls[0]![0][0].name).toBe('list.csv');
  });

  it('form errors are summarised in an alert that takes focus, each linking to its field', async () => {
    render(<FormErrors errors={[{ fieldId: 'subject', message: 'Write a subject.' }]} />);
    const alert = screen.getByRole('alert');
    await act(async () => {});
    expect(alert).toHaveFocus();
    expect(within(alert).getByRole('link', { name: 'Write a subject.' })).toHaveAttribute('href', '#subject');
    expect(within(alert).getByText('1 thing needs your attention')).toBeInTheDocument();
  });
});

describe('structure', () => {
  it('tabs follow the WAI-ARIA pattern: one tab stop, arrows move and select', async () => {
    const user = userEvent.setup();
    function T() {
      const [c, setC] = useState('a');
      return (
        <Tabs
          label="Workflow"
          current={c}
          onSelect={setC}
          items={[
            { id: 'a', label: 'Overview' },
            { id: 'b', label: 'Runs', count: 3, countLabel: 'runs' },
            { id: 'c', label: 'History' },
          ]}
        />
      );
    }
    render(<T />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    tabs[0]!.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /^Runs/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /^Runs/ })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  it('a titled section card is a labelled region; a disclosure opens; a breadcrumb marks the current page', async () => {
    render(
      <>
        <Card title="Recent runs" as="section">
          x
        </Card>
        <Disclosure summary="More">hidden detail</Disclosure>
        <Breadcrumb items={[{ label: 'Work', href: '/w/1/work' }, { label: 'Send certificates' }]} />
      </>,
    );
    expect(screen.getByRole('region', { name: 'Recent runs' })).toBeInTheDocument();
    expect(screen.getByText('hidden detail')).not.toBeVisible();
    await userEvent.click(screen.getByText('More'));
    expect(screen.getByText('hidden detail')).toBeVisible();
    expect(screen.getByText('Send certificates').closest('li')).toHaveAttribute('aria-current', 'page');
  });

  it('a danger banner is an alert; others are status messages', () => {
    render(
      <>
        <Banner tone="danger" title="Everything is stopped" />
        <Banner tone="info" title="Notifications are in Studio only" />
      </>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Everything is stopped');
    expect(screen.getByRole('status')).toHaveTextContent('Notifications are in Studio only');
  });
});

describe('overlays', () => {
  function WithSheet(props: { kind: 'sheet' | 'dialog' }) {
    const [open, setOpen] = useState(false);
    const Overlay = props.kind === 'sheet' ? Sheet : Dialog;
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
        <Overlay
          open={open}
          title="Approve the batch"
          description="3 emails."
          onClose={() => setOpen(false)}
          footer={<button type="button">Approve</button>}
        >
          <input aria-label="Note" />
        </Overlay>
      </>
    );
  }
  it.each(['sheet', 'dialog'] as const)('a %s takes focus, keeps it inside, closes on Escape and gives focus back', async (kind) => {
    const user = userEvent.setup();
    render(<WithSheet kind={kind} />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Approve the batch' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('3 emails.');
    expect(dialog).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('a toast is announced politely and goes away', async () => {
    vi.useFakeTimers();
    function Show() {
      const toast = useToast();
      return (
        <button type="button" onClick={() => toast('Saved')}>
          Save
        </button>
      );
    }
    render(
      <ToastProvider durationMs={1000}>
        <Show />
      </ToastProvider>,
    );
    act(() => screen.getByRole('button', { name: 'Save' }).click());
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    act(() => vi.advanceTimersByTime(1100));
    expect(screen.getByRole('status')).toHaveTextContent('');
    vi.useRealTimers();
  });
});

describe('data', () => {
  const ALL: Status[] = [
    'draft',
    'ready',
    'live',
    'paused',
    'waiting',
    'running',
    'attention',
    'done',
    'partial',
    'failed',
    'cancelled',
    'left-out',
    'unknown',
  ];
  it.each(ALL)('status %s is shown in words with a shape, never colour alone', (s) => {
    const { container } = render(<StatusPill status={s} />);
    expect(container.textContent).toBe(statusLabel(s));
    expect(container.querySelector('svg.k-shape')).not.toBeNull();
  });

  it('every status has its own words', () => {
    expect(new Set(ALL.map(statusLabel)).size).toBe(ALL.length);
  });

  it('who does a step is said in words beside the mark', () => {
    render(
      <>
        <WhoMark who="xo" />
        <WhoMark who="person" showLabel={false} />
      </>,
    );
    expect(screen.getByText('XO carries this out')).toBeVisible();
    expect(screen.getByText('A person decides')).toHaveClass('k-visually-hidden');
  });

  it('counts use words and leave out zeros; progress reports its value', () => {
    render(
      <>
        <CountSummary
          counts={[
            { n: 3, one: 'email', many: 'emails' },
            { n: 1, one: 'person left out', many: 'people left out' },
            { n: 0, one: 'failure', many: 'failures' },
          ]}
        />
        <Progress label="Sending" done={2} total={3} />
      </>,
    );
    expect(screen.getByText(/emails/).closest('p')).toHaveTextContent('3 emails1 person left out');
    expect(screen.getByRole('progressbar', { name: 'Sending' })).toHaveAttribute('aria-valuetext', '2 of 3');
  });

  it('a timeline is an ordered list labelled for what it shows', () => {
    render(<Timeline label="What happened" items={[{ id: '1', when: '09:00', text: 'Started' }]} />);
    expect(screen.getByRole('list', { name: 'What happened' }).tagName).toBe('OL');
  });

  it('a table sorts by a column, says how it is sorted, labels cells for phones and offers more', async () => {
    const user = userEvent.setup();
    const more = vi.fn();
    render(
      <DataTable<{ n: string; d: string }>
        caption="Who it goes to"
        rows={[
          { n: 'Ben', d: 'b.org' },
          { n: 'Asha', d: 'a.org' },
        ]}
        rowKey={(r) => r.n}
        columns={[
          { id: 'n', header: 'Person', cell: (r) => r.n, sortValue: (r) => r.n, primary: true },
          { id: 'd', header: 'Email domain', cell: (r) => r.d },
        ]}
        rowAction={(r) => <button type="button">Details for {r.n}</button>}
        onMore={more}
        moreLabel="Show 20 more"
      />,
    );
    const table = screen.getByRole('table', { name: 'Who it goes to' });
    await user.click(within(table).getByRole('button', { name: /Person/ }));
    expect(within(table).getByRole('columnheader', { name: /Person/ })).toHaveAttribute('aria-sort', 'ascending');
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((c) => c.textContent),
    ).toEqual(['Asha', 'Ben']);
    await user.click(within(table).getByRole('button', { name: /Person/ }));
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((c) => c.textContent),
    ).toEqual(['Ben', 'Asha']);
    expect(within(table).getAllByRole('cell')[0]).toHaveAttribute('data-label', 'Email domain');
    await user.click(screen.getByRole('button', { name: 'Show 20 more' }));
    expect(more).toHaveBeenCalled();
  });
});

describe('the five states of a data view', () => {
  const view = (state: LoadState<readonly string[]>, partial: string[] = []) =>
    render(
      <DataView<readonly string[]>
        state={state}
        loadingLabel="Loading people"
        isEmpty={(v) => v.length === 0}
        partial={partial}
        empty={<EmptyState title="No people yet" />}
        onRetry={() => {}}
      >
        {(v) => <p>{v.join(', ')}</p>}
      </DataView>,
    );
  const problem = { kind: 'network' as const, message: 'down' };

  it('loading shows only a labelled placeholder, never "empty"', () => {
    view({ phase: 'loading' });
    expect(screen.getByRole('status')).toHaveTextContent('Loading people');
    expect(screen.queryByText('No people yet')).not.toBeInTheDocument();
  });
  it('empty says so with its next step', () => {
    view({ phase: 'ready', value: [] });
    expect(screen.getByRole('heading', { name: 'No people yet' })).toBeInTheDocument();
  });
  it('partial says what could not be loaded, and does not call a partial list empty', () => {
    view({ phase: 'ready', value: [] }, ['the second folder']);
    expect(screen.getByRole('status')).toHaveTextContent(/could not be loaded: the second folder/);
    expect(screen.queryByText('No people yet')).not.toBeInTheDocument();
  });
  it('error says what failed and offers a retry, never "empty"', () => {
    view({ phase: 'error', problem });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('No people yet')).not.toBeInTheDocument();
  });
  it('a failed refresh keeps the last good value with the error above it', () => {
    view({ phase: 'error', problem, stale: ['Asha'] });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Asha')).toBeInTheDocument();
  });
  it('ready shows the content', () => {
    view({ phase: 'ready', value: ['Asha', 'Ben'] });
    expect(screen.getByText('Asha, Ben')).toBeInTheDocument();
  });
});

describe('accessibility of the whole kit', () => {
  it('the kit page has no axe violations (contrast is checked from the tokens, which jsdom cannot render)', async () => {
    const { container } = render(<KitPage />);
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
});
